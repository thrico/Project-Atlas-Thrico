/** Client for thrico-logic's build worker routes (src/webhooks/build-worker.ts), Bearer BUILD_WORKER_TOKEN. */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function workerCall(path: string, body?: unknown): Promise<any> {
  const api = (process.env.THRICO_API_URL || '').replace(/\/$/, '');
  const res = await fetch(`${api}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${process.env.BUILD_WORKER_TOKEN || ''}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, `${path}: ${res.status} ${json.error ?? ''}`.trim());
  return json;
}

const MAX_LINES = 500; // per /logs call (server limit)
const MAX_BYTES = 250_000; // server limit is 256 KB
const MAX_LINE_CHARS = 4000;
const MAX_QUEUED = 50_000; // shortcut: drops the oldest lines while the API is unreachable; fine for a log view

/** Reports steps and batches log lines (flushed every second) for one build. */
export class BuildReporter {
  step = 'build';
  private queue: { step: string; line: string }[] = [];
  private sending: Promise<void> = Promise.resolve();
  private timer = setInterval(() => void this.flush(), 1000);

  /** onGone: the server answered 409 (build cancelled or ended), so the build should stop. */
  constructor(private buildId: string, private onGone?: () => void) {}

  report(body: Record<string, unknown>) {
    return workerCall(`/worker/builds/${this.buildId}/report`, body);
  }

  log(line: string) {
    console.log(`[${this.step}] ${line}`);
    this.queue.push({ step: this.step, line: line.slice(0, MAX_LINE_CHARS) });
    if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED);
  }

  /** Sends everything queued so far; never throws (a lost log batch must not fail the build). */
  flush(): Promise<void> {
    this.sending = this.sending.then(async () => {
      while (this.queue.length) {
        const step = this.queue[0].step;
        const lines: string[] = [];
        let bytes = 0;
        while (this.queue.length && this.queue[0].step === step && lines.length < MAX_LINES) {
          const size = Buffer.byteLength(this.queue[0].line) + 1;
          if (lines.length && bytes + size > MAX_BYTES) break;
          lines.push(this.queue.shift()!.line);
          bytes += size;
        }
        try {
          await workerCall(`/worker/builds/${this.buildId}/logs`, { step, lines });
        } catch (e: any) {
          console.error(`Log upload failed (${lines.length} lines dropped): ${e.message}`);
          if (e instanceof ApiError && e.status === 409) {
            this.queue = [];
            this.onGone?.();
          }
          return;
        }
      }
    });
    return this.sending;
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}
