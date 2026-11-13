import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { MobilePublishPayload } from "../types";
import { executeCommand } from "../utils/command";

export const keychainName = (buildId: string) => `build-${buildId}.keychain`;

export async function buildIOS(
  workDir: string,
  payload: MobilePublishPayload,
): Promise<void> {
  const iosDir = path.join(workDir, "ios");

  // ─── 1. Signing assets, written into the build folder from the bundle ───
  // Never fall back to automatic or ad-hoc signing: a store build needs the app's own certificate.
  const { signingCertPath: certPath, provisionProfile: provisionProfilePath, teamId } = payload.ios;
  if (!certPath || !fs.existsSync(certPath)) throw new Error("Distribution certificate (ios_distributionCertP12) is missing.");
  if (!provisionProfilePath || !fs.existsSync(provisionProfilePath)) throw new Error("Provisioning profile (ios_provisioningProfile) is missing.");
  if (!teamId) throw new Error("Apple team ID is missing on the app.");

  let profileUUIDStr: string | undefined;
  {
    // Install provisioning profile to ~/Library/MobileDevice/Provisioning Profiles/
    const profilesDir = path.join(
      process.env.HOME || "~",
      "Library/MobileDevice/Provisioning Profiles",
    );
    if (fs.existsSync(profilesDir)) {
      // Clear out old provisioning profiles to force Xcode to use the exact one we are installing
      fs.readdirSync(profilesDir).forEach((file) => {
        if (file.endsWith(".mobileprovision")) {
          fs.unlinkSync(path.join(profilesDir, file));
        }
      });
    } else {
      fs.mkdirSync(profilesDir, { recursive: true });
    }

    // Extract UUID from the profile
    const uuidMatch = execFileSync("security", ["cms", "-D", "-i", provisionProfilePath], { encoding: "utf8" });
    const profileUUID = /<key>UUID<\/key>\s*<string>(.*?)<\/string>/.exec(uuidMatch)?.[1];
    if (!profileUUID) throw new Error("Could not read the UUID of the provisioning profile.");
    fs.copyFileSync(provisionProfilePath, path.join(profilesDir, `${profileUUID}.mobileprovision`));
    console.log(`Provisioning profile installed as ${profileUUID}.mobileprovision`);
    profileUUIDStr = profileUUID;
  }

  // Fail fast on a wrong certificate. The password goes through the environment, not the command line.
  try {
    const output = execFileSync(
      "openssl",
      ["pkcs12", "-info", "-in", certPath, "-passin", "env:P12_PASS", "-passout", "pass:dummy"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, P12_PASS: payload.ios.signingCertPassword || "" } },
    );
    if (output.includes("Apple Development")) {
      throw new Error("The .p12 holds an 'Apple Development' certificate; App Store builds need 'Apple Distribution'.");
    }
    if (!output.includes("Apple Distribution")) {
      console.warn("WARNING: no 'Apple Distribution' identity found in the .p12; signing may fail.");
    }
  } catch (err: any) {
    if (`${err.message}${err.stderr ?? ""}`.includes("invalid password")) throw new Error("Wrong password for the distribution certificate (.p12).");
    if (err.message.includes("Apple Development")) throw err;
    console.warn("Could not verify .p12 contents using openssl. Proceeding anyway...");
  }

  // Import the certificate into a temporary keychain; the pipeline deletes it after every build.
  const keychain = keychainName(payload.buildId);
  const keychainPassword = crypto.randomBytes(24).toString("hex");
  await executeCommand("security", ["create-keychain", "-p", keychainPassword, keychain], workDir, "CREATE KEYCHAIN");
  await executeCommand("security", ["unlock-keychain", "-p", keychainPassword, keychain], workDir, "UNLOCK KEYCHAIN");
  await executeCommand(
    "security",
    ["import", certPath, "-k", keychain, "-P", payload.ios.signingCertPassword || "", "-T", "/usr/bin/codesign"],
    workDir,
    "IMPORT CERT",
  );
  await executeCommand("security", ["list-keychains", "-d", "user", "-s", keychain, "login.keychain"], workDir, "SET KEYCHAIN LIST");
  await executeCommand(
    "security",
    ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychain],
    workDir,
    "SET PARTITION LIST",
  );

  // ─── 2. Install CocoaPods dependencies ───

  console.log("Installing CocoaPods...");
  await executeCommand("pod", ["install"], iosDir, "IOS PODS");

  // ─── 3. Setup Fastlane ───

  const fastlaneDir = path.join(iosDir, "fastlane");
  if (!fs.existsSync(fastlaneDir)) {
    fs.mkdirSync(fastlaneDir, { recursive: true });
  }

  const exportMethod = payload.ios.exportMethod || "app-store";

  // Build the xcargs string
  let xcargs = `CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY='Apple Distribution' DEVELOPMENT_TEAM='${payload.ios.teamId}'`;

  const fastfileContent = `default_platform(:ios)

platform :ios do
  desc "Build the iOS App"
  lane :build do
    update_code_signing_settings(
      use_automatic_signing: false,
      path: "Thrico.xcodeproj",
      team_id: "${payload.ios.teamId}",
      code_sign_identity: "Apple Distribution",
      profile_name: "${profileUUIDStr || ""}",
      targets: ["Thrico"]
    )

    build_app(
      workspace: "Thrico.xcworkspace",
      scheme: "Thrico",
      configuration: "Release",
      export_method: "${exportMethod}",
      clean: true,
      output_directory: "./build",
      output_name: "Application.ipa",
      xcargs: "${xcargs}"
    )
  end
end`;

  const fastfilePath = path.join(fastlaneDir, "Fastfile");
  fs.writeFileSync(fastfilePath, fastfileContent);

  await executeCommand("fastlane", ["build"], iosDir, "FASTLANE IOS BUILD");

  const ipaPath = path.join(iosDir, "build", "Application.ipa");
  if (!fs.existsSync(ipaPath)) throw new Error("iOS build failed — Application.ipa not found at " + ipaPath);
  fs.copyFileSync(ipaPath, path.join(workDir, "Application.ipa")); // picked up by uploadArtifacts
}

/** Uploads the built IPA to TestFlight only (never App Store review); an admin submits it in App Store Connect. */
export async function uploadIOS(workDir: string, payload: MobilePublishPayload) {
  const iosDir = path.join(workDir, "ios");
  const { keyId, issuerId, apiKeySecret, bundleId } = payload.ios;
  if (!keyId || !issuerId || !apiKeySecret) {
    throw new Error("App Store Connect API key (ios_ascApiKeyP8, ios_ascApiKeyId, ios_ascIssuerId) is missing.");
  }
  fs.writeFileSync(
    path.join(iosDir, "fastlane", "Fastfile"),
    `default_platform(:ios)

platform :ios do
  lane :publish do
    api_key = app_store_connect_api_key(
      key_id: ${JSON.stringify(keyId)},
      issuer_id: ${JSON.stringify(issuerId)},
      key_filepath: ${JSON.stringify(apiKeySecret)},
      in_house: false
    )
    upload_to_testflight(
      api_key: api_key,
      app_identifier: ${JSON.stringify(bundleId)},
      ipa: "./build/Application.ipa",
      skip_waiting_for_build_processing: true
    )
  end
end`,
  );
  await executeCommand("fastlane", ["publish"], iosDir, "FASTLANE IOS PUBLISH");
  return { storeUpload: { track: "testflight", status: "uploaded", message: "Uploaded to TestFlight; Apple is processing it" } };
}
