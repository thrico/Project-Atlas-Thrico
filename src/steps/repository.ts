import shell from "shelljs";
import fs from "fs";
import { execFileSync } from "child_process";
import { executeCommand } from "../utils/command";

const REPO = "https://github.com/thrico/thrico-mobile";

/** Shallow-clones gitRef (a release/* branch) into workDir and returns the commit SHA. */
export async function initAndClone(workDir: string, gitRef: string): Promise<string> {
  if (fs.existsSync(workDir)) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  shell.mkdir("-p", workDir);

  if (!gitRef || gitRef.startsWith("-")) throw new Error(`Bad git ref "${gitRef}"`);
  await executeCommand("git", ["clone", "--depth", "1", "-b", gitRef, REPO, workDir], process.cwd(), `git clone ${gitRef}`);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: workDir, encoding: "utf8" }).trim();
}
