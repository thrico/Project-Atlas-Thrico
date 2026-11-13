import shell from "shelljs";
import fs from "fs";
import path from "path";

export async function uploadArtifacts(workDir: string, buildId: string): Promise<void> {
  console.log("Step 12: Uploading Artifacts");
  // Move artifacts to a persistent directory for POC
  const artifactsDir = path.join(process.cwd(), "artifacts", buildId);
  shell.mkdir("-p", artifactsDir);

  // The APK is typically output to this location after assembleRelease
  const apkPath = path.join(workDir, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
  if (fs.existsSync(apkPath)) {
    shell.cp(apkPath, artifactsDir);
    console.log(`Copied APK to ${artifactsDir}`);
  } else {
    console.warn("Could not find generated APK at", apkPath);
  }

  // The AAB is typically output to this location after bundleRelease
  const aabPath = path.join(workDir, "android", "app", "build", "outputs", "bundle", "release", "app-release.aab");
  if (fs.existsSync(aabPath)) {
    shell.cp(aabPath, artifactsDir);
    console.log(`Copied AAB to ${artifactsDir}`);
  } else {
    console.warn("Could not find generated AAB at", aabPath);
  }

  if (fs.existsSync(path.join(workDir, "Application.ipa"))) {
    shell.cp(path.join(workDir, "Application.ipa"), artifactsDir);
    console.log(`Copied IPA to ${artifactsDir}`);
  }
  
  console.log(`Artifacts uploaded to ${artifactsDir}`);
}

export async function cleanupBuild(workDir: string): Promise<void> {
  console.log("Step 13: Cleanup");
  shell.rm("-rf", workDir);
}
