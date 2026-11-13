import path from "path";
import { ApiError, BuildReporter } from "./api";
import { BuildBundle, MobilePublishPayload } from "./types";
import { commandContext } from "./utils/command";
import {
  initAndClone,
  prepareBuild,
  downloadAssets,
  applyBranding,
  generateAssets,
  installDependencies,
  buildAndroid,
  uploadAndroid,
  buildIOS,
  uploadIOS,
  uploadArtifacts,
  cleanupBuild,
  applyDynamicWhitelabeling,
} from "./steps";

/** Whole-build limit; the backend fails a build after 3 hours without a report anyway. */
export const buildTimeLimitMs = () => Number(process.env.BUILD_TIME_LIMIT_MINUTES || 120) * 60_000;

/** Runs one build from its bundle, reporting every step and streaming command output to thrico-logic. */
export class BuildPipeline {
  private reporter: BuildReporter;
  private workDir: string;
  private abortController = new AbortController();

  constructor(private bundle: BuildBundle) {
    this.reporter = new BuildReporter(bundle.build.id, () => this.abort("The build was cancelled or ended on the server"));
    this.workDir = path.join(process.cwd(), "builds", bundle.build.id);
  }

  /** Stops the running command and fails the build with this reason. */
  abort(reason: string) {
    this.abortController.abort(new Error(reason));
  }

  /** Never throws: the build ends with a final succeeded/failed report (best effort if the API is down). */
  async run(): Promise<void> {
    const { build } = this.bundle;
    const r = this.reporter;
    const signal = this.abortController.signal;
    commandContext.log = (line) => r.log(line);
    commandContext.signal = signal;

    const step = async (name: string, fn: () => Promise<Record<string, unknown> | void>) => {
      if (signal.aborted) throw signal.reason;
      r.step = name;
      await r.report({ step: name, stepStatus: "running" });
      const extra = await fn();
      await r.flush();
      await r.report({ step: name, stepStatus: "succeeded", ...(extra || {}) });
    };

    const steps = async () => {
      let artifacts: Record<string, string> = {};
      let payload!: MobilePublishPayload;
      await step("Clone", async () => ({ commit: await initAndClone(this.workDir, build.gitRef) }));
      await step("Prepare keys", async () => {
        payload = prepareBuild(this.workDir, this.bundle);
      });
      await step("Download assets", () => downloadAssets(this.workDir, payload));
      await step("Apply branding", () => applyBranding(this.workDir, payload));
      await step("Generate assets", () => generateAssets(this.workDir, payload));
      await step("Install dependencies", () => installDependencies(this.workDir));
      await step("Apply whitelabeling", () => applyDynamicWhitelabeling(this.workDir, payload));
      if (build.platform === "android") {
        await step("Build Android", () => buildAndroid(this.workDir, payload));
        await step("Upload to Play internal", () => uploadAndroid(this.workDir, payload));
      } else {
        await step("Build iOS", () => buildIOS(this.workDir, payload));
        await step("Upload to TestFlight", () => uploadIOS(this.workDir, payload));
      }
      await step("Save artifacts", async () => {
        artifacts = await uploadArtifacts(this.workDir, build.id);
      });
      return artifacts;
    };

    let artifacts: Record<string, string> = {};
    let error: Error | undefined;
    let failedStep: string | undefined;
    const timer = setTimeout(() => this.abort(`Timed out after ${buildTimeLimitMs() / 60_000} minutes`), buildTimeLimitMs());
    try {
      // Race the abort too, so a step stuck outside a command (a hung download) can't hold the build.
      artifacts = await Promise.race([
        steps(),
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      ]);
    } catch (e: any) {
      error = e instanceof Error ? e : new Error(String(e));
      failedStep = r.step;
      r.log(`Error: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
    // The losing branch of the race may still settle later; nothing is waiting on it.
    this.abortController.abort(new Error("Build finished"));

    // Cleanup always runs, after success, failure or timeout: keys and the temporary keychain must not stay.
    r.step = "Cleanup";
    const problems = cleanupBuild(this.workDir, build.id);
    problems.forEach((p) => r.log(p));
    commandContext.log = undefined;
    commandContext.signal = undefined;
    await r.close();
    await this.finalReport({ step: "Cleanup", stepStatus: problems.length ? "failed" : "succeeded", ...(problems.length ? { error: problems.join("; ") } : {}) });

    await this.finalReport(
      error
        ? { step: failedStep, stepStatus: "failed", status: "failed", error: error.message }
        : { status: "succeeded", artifacts },
    );
    console.log(`Build ${build.id} ${error ? `failed at ${failedStep}: ${error.message}` : "succeeded"}`);
  }

  /** A few tries; 409 means the build was cancelled or already ended, nothing more to say. */
  private async finalReport(body: Record<string, unknown>) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.reporter.report(body);
      } catch (e: any) {
        if (e instanceof ApiError && e.status === 409) return;
        console.error(`Report failed (attempt ${attempt}/3): ${e.message}`);
        if (attempt < 3) await new Promise((res) => setTimeout(res, 5000 * attempt));
      }
    }
  }
}
