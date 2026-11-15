import shell from "shelljs";
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { executeCommand } from "../utils/command";
import { MobilePublishPayload } from "../types";

const androidEnv = () => ({
  ANDROID_HOME: process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`,
});

/** Signing key names in `keytool -list -v` output (entries that hold a private key). */
export const privateKeyAliases = (listing: string) =>
  listing
    .split(/^Alias name: /m)
    .slice(1)
    .filter((entry) => /^Entry type: PrivateKeyEntry/m.test(entry))
    .map((entry) => entry.split("\n")[0].trim());

/** The alias of the keystore's only signing key, so admins needn't type it. */
export function keystoreAlias(keystorePath: string, storePassword: string): string {
  const r = spawnSync("keytool", ["-list", "-v", "-keystore", keystorePath, "-storepass:env", "KS_PASS"], {
    encoding: "utf8",
    env: { ...process.env, KS_PASS: storePassword }, // not on the command line
  });
  if (r.status !== 0) throw new Error(`Could not open the keystore: ${(r.stdout + r.stderr).trim().split("\n").pop()}`);
  const aliases = privateKeyAliases(r.stdout);
  if (aliases.length !== 1) {
    throw new Error(
      aliases.length
        ? `The keystore holds ${aliases.length} keys (${aliases.join(", ")}); set the key alias on the app's Android page.`
        : "The keystore holds no signing key.",
    );
  }
  console.log(`Using key alias "${aliases[0]}" from the keystore`);
  return aliases[0];
}

export async function buildAndroid(workDir: string, payload: MobilePublishPayload): Promise<void> {
  const androidDir = path.join(workDir, "android");
  shell.chmod("+x", path.join(androidDir, "gradlew"));

  // Never sign with a generated key: Play would tie the app to a key nobody has.
  const keystorePath = payload.android.keystorePath;
  if (!keystorePath || !fs.existsSync(keystorePath)) {
    throw new Error("Release keystore (android_keystore) is missing; refusing to build an unsigned or self-signed app.");
  }
  if (!payload.android.keystorePasswordSecret || !payload.android.keyPasswordSecret) {
    throw new Error("Keystore password and key password are both required.");
  }
  const alias = payload.android.keystoreAlias || keystoreAlias(keystorePath, payload.android.keystorePasswordSecret);

  const signingArgs = [
    `-Pandroid.injected.signing.store.file=${keystorePath}`,
    `-Pandroid.injected.signing.store.password=${payload.android.keystorePasswordSecret}`,
    `-Pandroid.injected.signing.key.alias=${alias}`,
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
