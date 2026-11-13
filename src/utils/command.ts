import { spawn } from "child_process";

/** Set by the pipeline for the build in progress (one at a time): where output lines go, and the abort signal. */
export const commandContext: { log?: (line: string) => void; signal?: AbortSignal } = {};

export async function executeCommand(
  command: string,
  args: string[],
  cwd: string,
  logPrefix: string,
  envOverride?: NodeJS.ProcessEnv,
): Promise<void> {
  const { log = (line: string) => console.log(`[${logPrefix}]: ${line}`), signal } = commandContext;
  if (signal?.aborted) throw new Error(`[${logPrefix}] Not started: ${signal.reason?.message ?? "build aborted"}`);

  return new Promise((resolve, reject) => {
    const env = envOverride ? { ...process.env, ...envOverride } : process.env;
    // Args are not logged: some carry passwords. shortcut: SIGKILL reaches only the direct child, not
    // grandchildren (xcodebuild under fastlane); move to process groups if those are seen lingering.
    const proc = spawn(command, args, { cwd, env, signal, killSignal: "SIGKILL" });
    log(`$ ${logPrefix}`);

    for (const stream of [proc.stdout, proc.stderr]) {
      let rest = "";
      stream.on("data", (data) => {
        const parts = (rest + data.toString()).split(/\r?\n|\r/);
        rest = parts.pop() ?? "";
        for (const line of parts) if (line.trim()) log(line);
      });
      stream.on("end", () => {
        if (rest.trim()) log(rest);
      });
    }

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`[${logPrefix}] Failed with exit code ${code}`));
    });

    proc.on("error", (err) => {
      reject(new Error(`[${logPrefix}] ${signal?.aborted ? signal.reason?.message ?? "Aborted" : `Process error: ${err.message}`}`));
    });
  });
}
