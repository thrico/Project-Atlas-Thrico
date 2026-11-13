import shell from "shelljs";
import path from "path";
import fs from "fs";
import { executeCommand } from "../utils/command";
import { MobilePublishPayload } from "../types";

const androidEnv = () => ({
  ANDROID_HOME: process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`,
});

export async function buildAndroid(workDir: string, payload: MobilePublishPayload): Promise<void> {
  const androidDir = path.join(workDir, "android");
  shell.chmod("+x", path.join(androidDir, "gradlew"));

  // Never sign with a generated key: Play would tie the app to a key nobody has.
  const keystorePath = payload.android.keystorePath;
  if (!keystorePath || !fs.existsSync(keystorePath)) {
    throw new Error("Release keystore (android_keystore) is missing; refusing to build an unsigned or self-signed app.");
  }
  if (!payload.android.keystorePasswordSecret || !payload.android.keyPasswordSecret || !payload.android.keystoreAlias) {
    throw new Error("Keystore password, key password and key alias are all required.");
  }

  const signingArgs = [
    `-Pandroid.injected.signing.store.file=${keystorePath}`,
    `-Pandroid.injected.signing.store.password=${payload.android.keystorePasswordSecret}`,
    `-Pandroid.injected.signing.key.alias=${payload.android.keystoreAlias}`,
    `-Pandroid.injected.signing.key.password=${payload.android.keyPasswordSecret}`,
  ];

  await executeCommand("./gradlew", ["assembleRelease", ...signingArgs], androidDir, "GRADLE ASSEMBLE", androidEnv());
  await executeCommand("./gradlew", ["bundleRelease", ...signingArgs], androidDir, "GRADLE BUNDLE", androidEnv());
}

/**
 * Uploads the AAB to the Play internal track as a draft release: never another track, and an admin
 * rolls it out in Play Console (draft also works for apps Play still lists as draft).
 */
export async function uploadAndroid(workDir: string, payload: MobilePublishPayload) {
  const androidDir = path.join(workDir, "android");
  if (!payload.android.serviceJsonPath) throw new Error("Play service account key (android_playServiceAccountJson) is missing.");

  const fastlaneDir = path.join(androidDir, "fastlane");
  fs.mkdirSync(fastlaneDir, { recursive: true });
  fs.writeFileSync(
    path.join(fastlaneDir, "Fastfile"),
    `default_platform(:android)

platform :android do
  lane :publish do
    upload_to_play_store(
      track: "internal",
      release_status: "draft",
      json_key: ${JSON.stringify(payload.android.serviceJsonPath)},
      package_name: ${JSON.stringify(payload.android.packageName)},
      aab: "app/build/outputs/bundle/release/app-release.aab",
      skip_upload_apk: true,
      skip_upload_metadata: true,
      skip_upload_changelogs: true,
      skip_upload_images: true,
      skip_upload_screenshots: true
    )
  end
end`,
  );

  await executeCommand("fastlane", ["publish"], androidDir, "FASTLANE ANDROID PUBLISH", androidEnv());
  return { storeUpload: { track: "internal", status: "draft", message: "Draft release on the Play internal track" } };
}
