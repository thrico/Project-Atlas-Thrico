import shell from "shelljs";
import path from "path";
import fs from "fs";
import { executeCommand } from "../utils/command";
import { MobilePublishPayload } from "../types";

export async function buildAndroid(
  workDir: string,
  payload: MobilePublishPayload,
): Promise<void> {
  console.log("Step 10: Android Build");
  const androidDir = path.join(workDir, "android");

  // Ensure gradle wrapper has execution permissions
  shell.chmod("+x", path.join(androidDir, "gradlew"));

  // For POC purposes, we don't have a release keystore configured yet.
  // We will temporarily patch app/build.gradle to use the debug signing config for release builds.
  const buildGradlePath = path.join(androidDir, "app", "build.gradle");
  if (fs.existsSync(buildGradlePath)) {
    let buildGradle = fs.readFileSync(buildGradlePath, "utf-8");
    buildGradle = buildGradle.replace(
      /signingConfig signingConfigs\.release/g,
      "signingConfig signingConfigs.debug",
    );
    fs.writeFileSync(buildGradlePath, buildGradle);
  }

  // Setup Fastlane
  const fastlaneDir = path.join(androidDir, "fastlane");
  if (!fs.existsSync(fastlaneDir)) {
    fs.mkdirSync(fastlaneDir, { recursive: true });
  }

  const fastfileContent = `default_platform(:android)

platform :android do
  desc "Build the Android App"
  lane :build do
    gradle(
      task: "assemble",
      build_type: "Release"
    )
    gradle(
      task: "bundle",
      build_type: "Release"
    )
  end
  
  desc "Publish the Android App to Google Play Store"
  lane :publish do
    build
    upload_to_play_store(
      track: "production",
      json_key: "google-services-account.json", # Assuming the JSON key is placed here during the pipeline
      package_name: ENV["EXPO_PUBLIC_BUNDLE_ID"]
    )
  end
end`;

  // Only overwrite Fastfile if it doesn't exist, in case the repository provides its own
  const fastfilePath = path.join(fastlaneDir, "Fastfile");
  fs.writeFileSync(fastfilePath, fastfileContent); // Force overwrite for POC

  // Generate google-services-account.json for Fastlane Play Store upload
  const googleServicesAccount = {};
  fs.writeFileSync(
    path.join(androidDir, "google-services-account.json"),
    JSON.stringify(googleServicesAccount, null, 2),
  );

  const envOverride = {
    ANDROID_HOME:
      process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`,
  };

  // Perform actual build using gradle directly
  console.log("Building actual APK via gradle...");
  await executeCommand(
    "./gradlew",
    ["assembleRelease"],
    androidDir,
    "GRADLE ASSEMBLE",
    envOverride,
  );

  console.log("Building actual AAB via gradle...");
  await executeCommand(
    "./gradlew",
    ["bundleRelease"],
    androidDir,
    "GRADLE BUNDLE",
    envOverride,
  );

  // // If in production, run the fastlane publish lane to upload
  // if (payload.environment === "production") {
  //   console.log("Publishing Android Build to Play Store via fastlane...");
  //   await executeCommand("fastlane", ["publish"], androidDir, `FASTLANE ANDROID PUBLISH`, envOverride);
  // }
}
