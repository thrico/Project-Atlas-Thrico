import crypto from "crypto";
import fs from "fs";
import path from "path";
import shell from "shelljs";
import { MobilePublishPayload } from "../types";
import { executeCommand } from "../utils/command";

async function downloadFile(url: string, dest: string): Promise<void> {
  console.log(`Downloading ${url} to ${dest}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buffer));
}

export async function buildIOS(
  workDir: string,
  payload: MobilePublishPayload,
): Promise<void> {
  console.log("Step 11: iOS Build");
  const iosDir = path.join(workDir, "ios");

  // ─── 1. Resolve signing assets (local or CDN) ───

  // Resolve GoogleService-Info.plist (Firebase config)
  if (payload.ios.firebaseConfig) {
    const dest = path.join(iosDir, "GoogleService-Info.plist");
    if (payload.ios.firebaseConfig.startsWith("/")) {
      // Local file — copy to ios dir
      fs.copyFileSync(payload.ios.firebaseConfig, dest);
      console.log(`Copied local Firebase config to ${dest}`);
    } else {
      // CDN path — download
      const firebaseUrl = `https://cdn.thrico.network/${payload.ios.firebaseConfig}`;
      await downloadFile(firebaseUrl, dest);
      console.log(`Firebase config saved to ${dest}`);
    }
  }

  // Resolve App Store Connect API Key (.p8)
  let apiKeyPath: string | undefined;
  if (payload.ios.apiKeySecret) {
    if (payload.ios.apiKeySecret.startsWith("/")) {
      // Local file path — use directly
      apiKeyPath = payload.ios.apiKeySecret;
      console.log(`Using local API key: ${apiKeyPath}`);
    } else {
      // CDN path — download
      const apiKeyUrl = `https://cdn.thrico.network/${payload.ios.apiKeySecret}`;
      apiKeyPath = path.join(workDir, `AuthKey_${payload.ios.keyId}.p8`);
      await downloadFile(apiKeyUrl, apiKeyPath);
      console.log(`API key saved to ${apiKeyPath}`);
    }
  }

  // Resolve Provisioning Profile (.mobileprovision)
  let provisionProfilePath: string | undefined;
  let profileUUIDStr: string | undefined;
  
  if (payload.ios.provisionProfile) {
    if (payload.ios.provisionProfile.startsWith("/")) {
      // Local file path — use directly
      provisionProfilePath = payload.ios.provisionProfile;
      console.log(`Using local provisioning profile: ${provisionProfilePath}`);
    } else {
      // CDN path — download
      const profileUrl = `https://cdn.thrico.network/${payload.ios.provisionProfile}`;
      provisionProfilePath = path.join(
        workDir,
        "AppStore_Profile.mobileprovision",
      );
      await downloadFile(profileUrl, provisionProfilePath);
      console.log(`Provisioning profile saved to ${provisionProfilePath}`);
    }

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
    const { execSync } = require("child_process");
    const uuidMatch = execSync(
      `security cms -D -i "${provisionProfilePath}" | grep -A 1 UUID`
    ).toString();
    const profileUUID = uuidMatch.match(/<string>(.*?)<\/string>/)?.[1];
    
    if (profileUUID) {
      const targetProfilePath = path.join(profilesDir, `${profileUUID}.mobileprovision`);
      fs.copyFileSync(provisionProfilePath, targetProfilePath);
      console.log(`Provisioning profile installed as ${profileUUID}.mobileprovision`);
      profileUUIDStr = profileUUID;
    } else {
      console.warn("Could not extract UUID from provisioning profile. Falling back to basename.");
      fs.copyFileSync(
        provisionProfilePath,
        path.join(profilesDir, path.basename(provisionProfilePath)),
      );
      console.log("Provisioning profile installed.");
    }
  }

  // Resolve Distribution Certificate (.p12 or .cer) if provided
  let certPath: string | undefined;
  if (payload.ios.signingCertPath) {
    if (payload.ios.signingCertPath.startsWith("/")) {
      // Local file path — use directly
      certPath = payload.ios.signingCertPath;
      console.log(`Using local certificate: ${certPath}`);
    } else {
      // CDN path — download
      const certUrl = `https://cdn.thrico.network/${payload.ios.signingCertPath}`;
      certPath = path.join(workDir, "distribution.p12");
      await downloadFile(certUrl, certPath);
      console.log(`Distribution certificate saved to ${certPath}`);
    }

    // Verify .p12 file contents before proceeding (fails fast if wrong cert is provided)
    if (certPath.endsWith(".p12")) {
      try {
        console.log(`Verifying contents of ${certPath}...`);
        const { execSync } = require("child_process");
        const password = payload.ios.signingCertPassword || "";
        const output = execSync(
          `openssl pkcs12 -info -in "${certPath}" -passin pass:"${password}" -passout pass:dummy 2>&1`,
          { encoding: "utf8" }
        );

        if (output.includes("Apple Development")) {
          throw new Error(
            "The provided .p12 file contains an 'Apple Development' certificate, but an 'Apple Distribution' certificate is required for App Store builds. Please export the correct Apple Distribution certificate from Keychain Access."
          );
        }
        
        // Ensure it doesn't just contain the private key without the actual distribution certificate
        if (!output.includes("Apple Distribution")) {
          console.warn(
            "WARNING: Could not explicitly find 'Apple Distribution' string in the .p12 file. If the build fails during signing, ensure your .p12 was exported with both the certificate AND the private key selected."
          );
        } else {
          console.log("Certificate verification passed: Found Apple Distribution identity.");
        }
      } catch (err: any) {
        if (err.message.includes("Mac verify error: invalid password")) {
          throw new Error("Invalid signingCertPassword provided for the .p12 file.");
        } else if (err.message.includes("Apple Development")) {
          throw err; // Re-throw our custom error
        }
        console.warn("Could not verify .p12 contents using openssl. Proceeding anyway...");
      }
    }

    // Import certificate into a temporary keychain for CI
    const keychainName = `build-${payload.buildId}.keychain`;
    const keychainPassword = crypto.randomBytes(24).toString("hex"); // temporary keychain, deleted after the build
    const isP12 = certPath.endsWith(".p12");

    await executeCommand(
      "security",
      ["create-keychain", "-p", keychainPassword, keychainName],
      workDir,
      "CREATE KEYCHAIN",
    );
    await executeCommand(
      "security",
      ["unlock-keychain", "-p", keychainPassword, keychainName],
      workDir,
      "UNLOCK KEYCHAIN",
    );
    await executeCommand(
      "security",
      [
        "import",
        certPath,
        "-k",
        keychainName,
        ...(isP12 ? ["-P", payload.ios.signingCertPassword || ""] : []),
        "-T",
        "/usr/bin/codesign",
      ],
      workDir,
      "IMPORT CERT",
    );
    // Add the temporary keychain to the search list
    await executeCommand(
      "security",
      ["list-keychains", "-d", "user", "-s", keychainName, "login.keychain"],
      workDir,
      "SET KEYCHAIN LIST",
    );

    // set-key-partition-list only works with .p12 (which contains private keys)
    // .cer files only have the public certificate — skip this step for them
    if (isP12) {
      await executeCommand(
        "security",
        [
          "set-key-partition-list",
          "-S",
          "apple-tool:,apple:,codesign:",
          "-s",
          "-k",
          keychainPassword,
          keychainName,
        ],
        workDir,
        "SET PARTITION LIST",
      );
    }

    console.log("Distribution certificate imported into keychain.");
  }

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

  desc "Publish the iOS App to App Store Connect / TestFlight"
  lane :publish do
    api_key = app_store_connect_api_key(
      key_id: "${payload.ios.keyId}",
      issuer_id: "${payload.ios.issuerId}",
      key_filepath: "${apiKeyPath || ""}",
      in_house: false
    )

    build

    upload_to_testflight(
      api_key: api_key,
      app_identifier: "${payload.ios.bundleId}",
      ipa: "./build/Application.ipa",
      skip_waiting_for_build_processing: true
    )
  end

  desc "Publish directly to App Store (skip TestFlight)"
  lane :release do
    api_key = app_store_connect_api_key(
      key_id: "${payload.ios.keyId}",
      issuer_id: "${payload.ios.issuerId}",
      key_filepath: "${apiKeyPath || ""}",
      in_house: false
    )

    build

    upload_to_app_store(
      api_key: api_key,
      app_identifier: "${payload.ios.bundleId}",
      ipa: "./build/Application.ipa",
      force: true,
      skip_metadata: true,
      skip_screenshots: true,
      precheck_include_in_app_purchases: false
    )
  end

  error do |lane, exception|
    puts("Error occurred in lane '#{lane}': #{exception.message}")
  end
end`;

  const fastfilePath = path.join(fastlaneDir, "Fastfile");
  fs.writeFileSync(fastfilePath, fastfileContent);
  console.log("Fastfile written to", fastfilePath);

  // ─── 4. Build IPA via Fastlane ───

  console.log("Building iOS IPA via Fastlane...");
  await executeCommand("fastlane", ["build"], iosDir, "FASTLANE IOS BUILD");

  // ─── 5. Publish to App Store Connect / TestFlight ───

  if (payload.environment === "production") {
    console.log("Publishing iOS Build to App Store Connect via Fastlane...");
    // Use 'publish' lane for TestFlight, or 'release' lane for direct App Store submission
    await executeCommand(
      "fastlane",
      ["publish"],
      iosDir,
      "FASTLANE IOS PUBLISH",
    );
  }

  // Verify the IPA was created
  const ipaPath = path.join(iosDir, "build", "Application.ipa");
  if (fs.existsSync(ipaPath)) {
    // Copy IPA to workDir root for artifact upload step
    fs.copyFileSync(ipaPath, path.join(workDir, "Application.ipa"));
    console.log("iOS build completed — Application.ipa ready for upload.");
  } else {
    throw new Error(
      "iOS build failed — Application.ipa not found at " + ipaPath,
    );
  }
}
