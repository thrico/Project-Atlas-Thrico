import path from "path";
import { MobilePublishPayload } from "./types";
import {
  initAndClone,
  fetchConfig,
  downloadAssets,
  applyBranding,
  generateAssets,
  installDependencies,
  buildAndroid,
  buildIOS,
  uploadArtifacts,
  cleanupBuild,
  applyDynamicWhitelabeling,
} from "./steps";

export class BuildPipeline {
  private payload: MobilePublishPayload;
  private buildId: string;
  private entityId: string;
  private platform: string;
  private workDir: string;

  constructor(payload: MobilePublishPayload) {
    this.payload = payload;
    this.buildId = payload.buildId;
    this.entityId = payload.entityId;
    this.platform = payload.platform;
    this.workDir = path.join(process.cwd(), "builds", this.buildId);
  }

  async run() {
    console.log(
      `Starting build pipeline for ${this.payload.buildId} (Entity: ${this.payload.entityId})`,
    );

    const runStep = async (stepName: string, stepFn: () => Promise<void>) => {
      console.log(`\n--- [Step] ${stepName} started ---`);
      try {
        await stepFn();
        console.log(`--- [Step] ${stepName} completed successfully ---\n`);
      } catch (error) {
        console.error(`\n*** [Step Error] ${stepName} failed:`, error);
        throw error;
      }
    };

    try {
      await runStep("Init and Clone", () => initAndClone(this.workDir));
      await runStep("Download Assets", () => downloadAssets(this.workDir, this.payload));
      await runStep("Apply Branding", () => applyBranding(this.workDir, this.payload));
      await runStep("Generate Assets", () => generateAssets(this.workDir, this.payload));
      await runStep("Install Dependencies", () => installDependencies(this.workDir));
      await runStep("Apply Dynamic Whitelabeling", () => applyDynamicWhitelabeling(this.workDir, this.payload));

      // if (this.platform === "android" || this.platform === "both") {
      //   await runStep("Build Android", () => buildAndroid(this.workDir, this.payload));
      // }

      if (this.platform === "ios" || this.platform === "both") {
        await runStep("Build iOS", () => buildIOS(this.workDir, this.payload));
      }

      await runStep("Upload Artifacts", () => uploadArtifacts(this.workDir, this.buildId));

      await runStep("Cleanup Build", async () => cleanupBuild(this.workDir));

      console.log(`Build pipeline ${this.buildId} completed successfully!`);
    } catch (error) {
      console.error(`Build pipeline ${this.buildId} failed entirely:`, error);
      throw error;
    }
  }
}
