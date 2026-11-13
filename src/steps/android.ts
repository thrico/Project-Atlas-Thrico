import shell from "shelljs";
import path from "path";
import fs from "fs";
import { executeCommand } from "../utils/command";
import { MobilePublishPayload } from "../types";

async function downloadFile(url: string, dest: string): Promise<void> {
  console.log(`Downloading ${url} to ${dest}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buffer));
}

export async function buildAndroid(
  workDir: string,
  payload: MobilePublishPayload,
): Promise<void> {
  console.log("Step 10: Android Build");
  const androidDir = path.join(workDir, "android");

  // Ensure gradle wrapper has execution permissions
  shell.chmod("+x", path.join(androidDir, "gradlew"));

  // Download dynamic payload files if provided
  if (payload.android.keystorePath && !payload.android.keystorePath.startsWith('/')) {
    const keystoreUrl = `https://cdn.thrico.network/${payload.android.keystorePath}`;
    const dest = path.join(androidDir, "app", "release.keystore");
    await downloadFile(keystoreUrl, dest);
    payload.android.keystorePath = dest;
  }

  if (payload.android.serviceJsonPath && !payload.android.serviceJsonPath.startsWith('/')) {
    const serviceUrl = `https://cdn.thrico.network/${payload.android.serviceJsonPath}`;
    const dest = path.join(androidDir, "google-services-account.json");
    await downloadFile(serviceUrl, dest);
    payload.android.serviceJsonPath = dest;
  }

  if (payload.android.googleServicesJsonPath && !payload.android.googleServicesJsonPath.startsWith('/')) {
    const googleServicesUrl = `https://cdn.thrico.network/${payload.android.googleServicesJsonPath}`;
    const dest = path.join(androidDir, "app", "google-services.json");
    await downloadFile(googleServicesUrl, dest);
    payload.android.googleServicesJsonPath = dest;
  }

  // Use provided keystore or generate a real release keystore to satisfy Google Play's signature requirements
  let keystorePath = payload.android.keystorePath;
  if (keystorePath) {
    keystorePath = path.resolve(workDir, keystorePath);
  }

  if (!keystorePath || !fs.existsSync(keystorePath)) {
    if (keystorePath) {
      console.log(`Warning: Keystore at ${keystorePath} not found. Falling back to generating a mock keystore.`);
    }
    keystorePath = path.join(androidDir, "app", "release.keystore");
    if (!fs.existsSync(keystorePath)) {
      console.log("Generating a mock release keystore...");
      shell.exec(
        `keytool -genkey -v -keystore ${keystorePath} -alias release -keyalg RSA -keysize 2048 -validity 10000 -dname "cn=Unknown, ou=Unknown, o=Unknown, c=Unknown" -storepass password -keypass password`
      );
    }
  }


  // Setup Fastlane
  const fastlaneDir = path.join(androidDir, "fastlane");
  if (!fs.existsSync(fastlaneDir)) {
    fs.mkdirSync(fastlaneDir, { recursive: true });
  }

  // Determine the fastlane json_key path dynamically based on payload
  const serviceJsonKeyPath = payload.android.serviceJsonPath || "google-services-account.json";

  const fastfileContent = `default_platform(:android)

platform :android do
  desc "Publish the Android App to Google Play Store"
  lane :publish do
    upload_to_play_store(
      track: "${payload.android.track || 'internal'}",
      release_status: "${payload.android.releaseStatus || 'completed'}",
      json_key: "${serviceJsonKeyPath}",
      package_name: "${payload.android.packageName}",
      aab: "app/build/outputs/bundle/release/app-release.aab",
      skip_upload_metadata: true,
      skip_upload_images: true,
      skip_upload_screenshots: true
    )
  end

  error do |lane, exception|
    puts("Error occurred in lane '#{lane}': #{exception.message}")
  end
end`;

  // Write Fastfile to disk
  const fastfilePath = path.join(fastlaneDir, "Fastfile");
  fs.writeFileSync(fastfilePath, fastfileContent); // Force overwrite for POC
  const envOverride = {
    ANDROID_HOME:
      process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`,
  };

  // Perform actual build using gradle directly
  console.log("Building actual APK via gradle...");

  const signingArgs = [
    `-Pandroid.injected.signing.store.file=${keystorePath}`,
    `-Pandroid.injected.signing.store.password=${payload.android.keystorePasswordSecret || "password"}`,
    `-Pandroid.injected.signing.key.alias=${payload.android.keystoreAlias || "release"}`,
    `-Pandroid.injected.signing.key.password=${payload.android.keyPasswordSecret || "password"}`
  ];

  await executeCommand(
    "./gradlew",
    ["assembleRelease", ...signingArgs],
    androidDir,
    "GRADLE ASSEMBLE",
    envOverride,
  );

  console.log("Building actual AAB via gradle...");
  await executeCommand(
    "./gradlew",
    ["bundleRelease", ...signingArgs],
    androidDir,
    "GRADLE BUNDLE",
    envOverride,
  );

  // If in production, run the fastlane publish lane to upload
  if (payload.environment === "production") {
    console.log("Publishing Android Build to Play Store via fastlane...");
    await executeCommand("fastlane", ["publish"], androidDir, `FASTLANE ANDROID PUBLISH`, envOverride);
  }
}
