import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { ApiError, workerCall } from "./api";
import { OtaMessage, runOtaCandidate, runOtaSend } from "./ota";
import { BuildPipeline, buildTimeLimitMs } from "./pipeline";
import { BuildBundle, BuildMessage } from "./types";

const MAX_DELIVERIES = 3; // never retry a build forever
const RETRY_AFTER_SECONDS = 60; // when the bundle can't be fetched (API down)

/** Takes builds from the SQS build queue one at a time; a message is deleted only after the final report. */
export class MobileBuildWorker {
  private sqs?: SQSClient;
  private queueUrl = "";
  private stopping = new AbortController();
  private current?: BuildPipeline;
  private currentRun?: Promise<void>;
  private loop?: Promise<void>;

  async start() {
    for (const name of ["CUSTOM_APP_BUILD_QUEUE_URL", "THRICO_API_URL", "BUILD_WORKER_TOKEN"]) {
      if (!process.env[name]) throw new Error(`Missing ${name} in the build worker's environment`);
    }
    this.queueUrl = process.env.CUSTOM_APP_BUILD_QUEUE_URL!;
    this.sqs = new SQSClient({ region: process.env.AWS_REGION || /sqs\.([a-z0-9-]+)\./.exec(this.queueUrl)?.[1] });
    this.loop = this.poll();
    console.log(`Listening for builds on ${this.queueUrl}`);
  }

  /** Fails the running build (cleanup and final report included), then stops polling. */
  async stop() {
    this.stopping.abort();
    this.current?.abort("The build worker was stopped");
    await Promise.all([this.loop, this.currentRun]);
  }

  private async poll() {
    // Keep the message hidden for the whole build, so nobody else takes it meanwhile (SQS max is 12 hours).
    const visibility = Math.min(43_200, Math.ceil(buildTimeLimitMs() / 1000) + 15 * 60);
    while (!this.stopping.signal.aborted) {
      try {
        const { Messages } = await this.sqs!.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 20,
            VisibilityTimeout: visibility,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
          { abortSignal: this.stopping.signal },
        );
        if (Messages?.[0]) await this.handle(Messages[0]);
      } catch (e: any) {
        if (this.stopping.signal.aborted) break;
        console.error("Build queue error:", e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async handle(msg: Message) {
    const remove = () => this.sqs!.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: msg.ReceiptHandle }));
    let job: BuildMessage | OtaMessage;
    try {
      job = JSON.parse(msg.Body || "");
      if (!("type" in job) && !job?.buildId) throw new Error("no buildId");
      if ("type" in job && job.type !== "ota-candidate" && job.type !== "ota-send") throw new Error(`unknown type ${(job as any).type}`);
    } catch (e: any) {
      console.error(`Dropping unreadable build message ${msg.MessageId}: ${e.message}`);
      return remove();
    }

    const deliveries = Number(msg.Attributes?.ApproximateReceiveCount || 1);
    if ("type" in job) {
      const ota = job;
      if (deliveries > MAX_DELIVERIES) {
        console.error(`OTA ${ota.type}: delivered ${deliveries} times, giving up`);
        if (ota.type === "ota-send")
          await workerCall("/worker/ota/events", {
            event: "ota.sent", appId: ota.appId, requestId: ota.requestId, status: "failure",
            error: `The build worker gave up after ${MAX_DELIVERIES} attempts`,
          }).catch((e) => console.error(e.message));
        return remove();
      }
      this.currentRun = (ota.type === "ota-candidate" ? runOtaCandidate(ota) : runOtaSend(ota)).catch((e) =>
        console.error(`OTA ${ota.type} failed: ${e.message}`),
      );
      await this.currentRun;
      this.currentRun = undefined;
      return remove();
    }

    if (deliveries > MAX_DELIVERIES) {
      console.error(`Build ${job.buildId}: delivered ${deliveries} times, giving up`);
      await workerCall(`/worker/builds/${job.buildId}/report`, {
        status: "failed",
        error: `The build worker gave up after ${MAX_DELIVERIES} attempts`,
      }).catch((e) => console.error(e.message));
      return remove();
    }

    let bundle: BuildBundle;
    try {
      bundle = await workerCall(`/worker/builds/${job.buildId}/bundle`);
    } catch (e: any) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
        console.log(`Build ${job.buildId}: ${e.message}; skipping`); // cancelled, finished or gone
        return remove();
      }
      console.error(`Build ${job.buildId}: bundle fetch failed (${e.message}); retrying in ${RETRY_AFTER_SECONDS}s`);
      await this.sqs!.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: msg.ReceiptHandle, VisibilityTimeout: RETRY_AFTER_SECONDS }),
      ).catch(() => {});
      return;
    }

    console.log(`Build ${job.buildId}: ${bundle.app.appName} ${bundle.build.platform} ${bundle.build.versionName} (${bundle.build.buildNumber}) from ${bundle.build.gitRef}`);
    await this.runBuild(bundle);
    await remove();
  }

  /** Also used by `npm start -- --build <id>` to run one build without the queue. */
  async runBuild(bundle: BuildBundle) {
    this.current = new BuildPipeline(bundle);
    this.currentRun = this.current.run(); // never throws
    await this.currentRun;
    this.current = this.currentRun = undefined;
  }
}
