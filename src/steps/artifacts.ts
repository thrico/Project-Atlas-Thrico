import shell from "shelljs";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { keychainName } from "./ios";

/** Copies the built files to artifacts/<buildId> on this Mac and returns their paths for the report. */
export async function uploadArtifacts(workDir: string, buildId: string): Promise<Record<string, string>> {
  const saved: Record<string, string> = {};
  // Move artifacts to a persistent directory for POC
  const artifactsDir = path.join(process.cwd(), "artifacts", buildId);
  shell.mkdir("-p", artifactsDir);

  // The APK is typically output to this location after assembleRelease
  const apkPath = path.join(workDir, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
  if (fs.existsSync(apkPath)) {
    shell.cp(apkPath, artifactsDir);
    saved.apk = path.join(artifactsDir, "app-release.apk");
    console.log(`Copied APK to ${artifactsDir}`);
  } else {
    console.warn("Could not find generated APK at", apkPath);
  }

  // The AAB is typically output to this location after bundleRelease
  const aabPath = path.join(workDir, "android", "app", "build", "outputs", "bundle", "release", "app-release.aab");
  if (fs.existsSync(aabPath)) {
    shell.cp(aabPath, artifactsDir);
    saved.aab = path.join(artifactsDir, "app-release.aab");
    console.log(`Copied AAB to ${artifactsDir}`);
  } else {
    console.warn("Could not find generated AAB at", aabPath);
  }

  if (fs.existsSync(path.join(workDir, "Application.ipa"))) {
    shell.cp(path.join(workDir, "Application.ipa"), artifactsDir);
    saved.ipa = path.join(artifactsDir, "Application.ipa");
    console.log(`Copied IPA to ${artifactsDir}`);
  }
  
  console.log(`Artifacts saved to ${artifactsDir}`);
  return saved;
}

/** Deletes the build folder (keys included) and the temporary iOS keychain. Never throws. */
export function cleanupBuild(workDir: string, buildId: string): string[] {
  const problems: string[] = [];
  if (process.platform === "darwin") {
    // delete-keychain also removes it from the search list; "not found" just means no iOS signing ran.
    const r = spawnSync("security", ["delete-keychain", keychainName(buildId)], { encoding: "utf8" });
    if (r.status !== 0 && !/could not be found/i.test(r.stderr ?? "")) problems.push(`Keychain not deleted: ${r.stderr?.trim()}`);
  }
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch (e: any) {
    problems.push(`Build folder not deleted: ${e.message}`);
  }
  return problems;
}
