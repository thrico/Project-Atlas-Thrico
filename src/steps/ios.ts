import fs from "fs";
import path from "path";
// import { executeCommand } from "../utils/command";

export async function buildIOS(workDir: string): Promise<void> {
  console.log("Step 11: iOS Build");
  // In a real scenario:
  // await executeCommand("pod", ["install"], path.join(workDir, "ios"), "IOS PODS");
  // await executeCommand("xcodebuild", ["-workspace", "Thrico.xcworkspace", "-scheme", "Thrico", "-configuration", "Release", "archive"], path.join(workDir, "ios"), "IOS BUILD");
  
  console.log("Mocking iOS Build... created Application.ipa");
  fs.writeFileSync(
    path.join(workDir, "Application.ipa"),
    "mocked ios build"
  );
}
