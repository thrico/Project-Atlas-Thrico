import fs from "fs";
import path from "path";
import { executeCommand } from "../utils/command";

export async function installDependencies(workDir: string): Promise<void> {
  console.log("Step 9: Install Dependencies");
  
  // Inject packageManager into the cloned repo to prevent Yarn from checking the parent monorepo's pnpm setup
  const pkgPath = path.join(workDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    pkg.packageManager = "yarn@1.22.22";
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  }

  await executeCommand("npx", ["yarn", "install", "--ignore-scripts", "--ignore-engines", "--mutex", "network"], workDir, "YARN INSTALL");
  
  // Fix for expo-device TARGET_OS_SIMULATOR error in Xcode 16
  const expoDeviceUIDeviceSwiftPath = path.join(workDir, "node_modules", "expo-device", "ios", "UIDevice.swift");
  if (fs.existsSync(expoDeviceUIDeviceSwiftPath)) {
    let content = fs.readFileSync(expoDeviceUIDeviceSwiftPath, "utf-8");
    if (!content.includes("TARGET_OS_SIMULATOR = 1")) {
      const fix = `
#if targetEnvironment(simulator)
  let TARGET_OS_SIMULATOR = 1
#else
  let TARGET_OS_SIMULATOR = 0
#endif
`;
      fs.writeFileSync(expoDeviceUIDeviceSwiftPath, fix + content);
      console.log("Applied Xcode 16 fix for expo-device TARGET_OS_SIMULATOR");
    }
  }

  console.log("Applying patches...");
  await executeCommand("npx", ["patch-package"], workDir, "PATCH-PACKAGE");
}
