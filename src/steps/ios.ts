import fs from "fs";
import path from "path";
import { MobilePublishPayload } from "../types";
// import { executeCommand } from "../utils/command";

export async function buildIOS(workDir: string, payload: MobilePublishPayload): Promise<void> {
  console.log("Step 11: iOS Build");
  // In a real scenario:
  // await executeCommand("pod", ["install"], path.join(workDir, "ios"), "IOS PODS");
  // await executeCommand("xcodebuild", ["-workspace", "Thrico.xcworkspace", "-scheme", "Thrico", "-configuration", "Release", "archive"], path.join(workDir, "ios"), "IOS BUILD");
  
  const iosDir = path.join(workDir, "ios");
  
  // Setup Fastlane
  const fastlaneDir = path.join(iosDir, "fastlane");
  if (!fs.existsSync(fastlaneDir)) {
    fs.mkdirSync(fastlaneDir, { recursive: true });
  }

  const fastfileContent = `default_platform(:ios)

platform :ios do
  desc "Build the iOS App"
  lane :build do
    build_app(
      workspace: "Thrico.xcworkspace",
      scheme: "Thrico",
      configuration: "Release",
      export_method: "app-store"
    )
  end
  
  desc "Publish the iOS App to App Store / TestFlight"
  lane :publish do
    build
    upload_to_app_store(
      app_identifier: ENV["EXPO_PUBLIC_BUNDLE_ID"],
      force: true, # skip HTML report
      skip_metadata: true,
      skip_screenshots: true
    )
  end
end`;
  
  // Only overwrite Fastfile if it doesn't exist
  const fastfilePath = path.join(fastlaneDir, "Fastfile");
  fs.writeFileSync(fastfilePath, fastfileContent); // Force overwrite for POC

  // Uncomment when ready to run the actual build using fastlane
  // await executeCommand("fastlane", ["build"], iosDir, "FASTLANE IOS BUILD");
  
  console.log("Mocking iOS Fastlane Build... created Application.ipa");
  fs.writeFileSync(
    path.join(workDir, "Application.ipa"),
    "mocked ios build via fastlane"
  );
}
