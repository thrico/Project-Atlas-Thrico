import shell from "shelljs";
import fs from "fs";
import { executeCommand } from "../utils/command";

export async function initAndClone(workDir: string): Promise<void> {
  console.log("Step 1-4: Init and Clone Repository");
  if (fs.existsSync(workDir)) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  shell.mkdir("-p", workDir);

  console.log("Cloning https://github.com/thrico/thrico-mobile branch develop...");

  await executeCommand(
    "git",
    ["clone", "--depth", "1", "-b", "develop", "https://github.com/thrico/thrico-mobile", workDir],
    process.cwd(),
    "GIT CLONE"
  );
}
