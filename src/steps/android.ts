import shell from "shelljs";
import path from "path";
import fs from "fs";
import { executeCommand } from "../utils/command";

export async function buildAndroid(workDir: string): Promise<void> {
  console.log("Step 10: Android Build");
  const androidDir = path.join(workDir, "android");

  // Ensure gradle wrapper has execution permissions
  shell.chmod("+x", path.join(androidDir, "gradlew"));

  // For POC purposes, we don't have a release keystore configured yet.
  // We will temporarily patch app/build.gradle to use the debug signing config for release builds.
  const buildGradlePath = path.join(androidDir, "app", "build.gradle");
  if (fs.existsSync(buildGradlePath)) {
    let buildGradle = fs.readFileSync(buildGradlePath, "utf-8");
    buildGradle = buildGradle.replace(/signingConfig signingConfigs\.release/g, "signingConfig signingConfigs.debug");
    fs.writeFileSync(buildGradlePath, buildGradle);
  }

  // Run the actual build
  const envOverride = {
    ANDROID_HOME: process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`
  };
  await executeCommand("./gradlew", ["assembleRelease"], androidDir, "ANDROID BUILD", envOverride);
}
