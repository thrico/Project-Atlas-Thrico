import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { workerCall } from "./api";
import { REPO } from "./steps/repository";
import { pinYarn1 } from "./steps/dependencies";
import { commandContext, executeCommand } from "./utils/command";

/** SQS bodies from thrico-logic for OTA jobs (message group "ota"); store builds have no `type`. */
export type OtaMessage =
  | { type: "ota-candidate"; commit: string }
  | { type: "ota-send"; requestId: string; appId: string; groupId: string; target: string; message?: string };

const EAS = ["-y", "eas-cli@27.2.0"];
// thrico-mobile's lockfile is Yarn 1; the Mac's global yarn may be Yarn 4, which refuses it.
const YARN = ["-y", "yarn@1.22.22"];
/** The dashboard offers the newest 20 `ota` commits; fetch a little more history than that. */
const OTA_HISTORY = 50;
export const otaTimeLimit = { ms: 40 * 60_000 }; // shortened by the self-check
export const networkRetry = { attempts: 3, delayMs: 10_000 }; // shortened by the self-check

/** GitHub over the Mac's connection can time out mid-download; try a network step again. */
async function retryNetwork(label: string, step: () => Promise<unknown>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (e: any) {
      if (attempt >= networkRetry.attempts || commandContext.signal?.aborted) throw e;
      console.log(`${label} failed (${e.message}); retry ${attempt + 1}/${networkRetry.attempts}`);
      await new Promise((r) => setTimeout(r, networkRetry.delayMs * attempt));
    }
  }
}
export const otaWorkRoot = { dir: path.join(process.cwd(), "builds") };

/** Same contract as the GitHub Action: register the update group with thrico-logic. */
export async function runOtaCandidate(job: { commit: string }) {
  const { commit } = job;
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error(`Invalid commit ${commit}`);
  const branch = `ota-${commit.slice(0, 7)}`;
  await inWorkDir(`ota-${commit}`, async (dir) => {
    // One shallow fetch of the ota branch: everything arrives in a single download (a blob-less clone
    // fetched files lazily during checkout, which failed midway on slow connections).
    await executeCommand("git", ["init", "-q", dir], process.cwd(), "git init");
    await retryNetwork("git fetch", () =>
      executeCommand("git", ["fetch", "--depth", String(OTA_HISTORY), "--no-tags", REPO, "+refs/heads/ota:refs/remotes/origin/ota"], dir, "git fetch ota"),
    );
    await executeCommand("git", ["merge-base", "--is-ancestor", commit, "origin/ota"], dir, "check commit is on ota").catch(() => {
      throw new Error(`${commit} is not among the newest ${OTA_HISTORY} commits of the ota branch`);
    });
    await executeCommand("git", ["checkout", "--detach", commit], dir, `git checkout ${commit}`);
    const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: dir, encoding: "utf8" }).trim();
    pinYarn1(dir);
    await retryNetwork("yarn install", () => executeCommand("npx", [...YARN, "install", "--frozen-lockfile"], dir, "yarn install"));
    const out = await executeCommand(
      "npx",
      [...EAS, "update", "--branch", branch, "--message", subject, "--platform", "all", "--non-interactive", "--json"],
      dir,
      "eas update",
      {
        NODE_OPTIONS: "--max-old-space-size=8192", // Metro bundles both platforms with source maps
        EXPO_TOKEN: process.env.EXPO_TOKEN,
        EXPO_PUBLIC_API_URL: process.env.APP_API_URL,
        EXPO_PUBLIC_WS_URL: process.env.APP_WS_URL,
        EXPO_PUBLIC_GOOGLE_MAPS_API_KEY: process.env.APP_GOOGLE_MAPS_API_KEY,
        EXPO_PUBLIC_SENTRY_DSN: process.env.APP_SENTRY_DSN,
      },
    );
    const parsed = JSON.parse(out);
    const list: any[] = Array.isArray(parsed) ? parsed : [parsed];
    const event = {
      event: "ota.candidate",
      groupId: list[0]?.group,
      commit,
      branch,
      message: list[0]?.message ?? subject,
      runtimeVersion: list[0]?.runtimeVersion,
      platforms: [...new Set(list.map((u) => u.platform))],
    };
    if (!event.groupId || !event.runtimeVersion) throw new Error("eas update returned no group or runtime version");
    await workerCall("/worker/ota/events", event);
    console.log(`OTA candidate ${branch}: group ${event.groupId}, runtime ${event.runtimeVersion}`);
  });
}

/** Republishes an update group onto the app's own branch; always reports ota.sent, failure included. */
export async function runOtaSend(job: Extract<OtaMessage, { type: "ota-send" }>) {
  const { requestId, appId, groupId, target, message = "OTA send" } = job;
  let error: string | undefined;
  try {
    if (!/^app-[a-z0-9-]+$/.test(target ?? "")) throw new Error(`Invalid target ${target}`);
    if (!/^[0-9a-fA-F-]{8,64}$/.test(groupId ?? "")) throw new Error(`Invalid group ${groupId}`);
    await inWorkDir(`ota-send-${requestId}`, async (dir) => {
      // Only app.json (the EAS project id) is needed.
      await retryNetwork("git clone", () => executeCommand("git", ["clone", "--depth", "1", REPO, dir], process.cwd(), "git clone"));
      // Strip plugins and dynamic configs so EAS CLI doesn't try to resolve uninstalled node_modules.
      const appJsonPath = path.join(dir, "app.json");
      if (fs.existsSync(appJsonPath)) {
        try {
          const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf8"));
          if (appJson.expo?.plugins) {
            delete appJson.expo.plugins;
            fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2));
          }
        } catch (e: any) {
          console.warn(`Could not strip plugins from app.json: ${e.message}`);
        }
      }
      for (const dyn of ["app.config.js", "app.config.ts", "app.config.mjs"]) {
        const p = path.join(dir, dyn);
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
      }
      const eas = (args: string[], label: string) =>
        executeCommand("npx", [...EAS, ...args], dir, label, { EXPO_TOKEN: process.env.EXPO_TOKEN });
      // Both are created on the app's first send; afterwards they already exist.
      await eas(["branch:create", target, "--non-interactive"], "eas branch:create").catch(() => console.log(`branch ${target} exists`));
      await eas(["channel:create", target, "--non-interactive"], "eas channel:create").catch(() => console.log(`channel ${target} exists`));
      await eas(["channel:edit", target, "--branch", target, "--non-interactive"], "eas channel:edit");
      await eas(["update:republish", "--group", groupId, "--destination-branch", target, "--message", message, "--non-interactive", "--json"], "eas update:republish");
    });
  } catch (e: any) {
    error = e?.message ?? String(e);
  }
  console.log(`OTA send ${groupId} -> ${target}: ${error ? `failed: ${error}` : "sent"}`);
  await workerCall("/worker/ota/events", { event: "ota.sent", appId, requestId, status: error ? "failure" : "success", ...(error ? { error } : {}) });
}

/** Fresh folder, removed afterwards; commands are killed after the OTA time limit. */
async function inWorkDir(name: string, fn: (dir: string) => Promise<void>) {
  const dir = path.join(otaWorkRoot.dir, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(otaWorkRoot.dir, { recursive: true });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`Timed out after ${otaTimeLimit.ms / 60_000} minutes`)), otaTimeLimit.ms);
  commandContext.signal = abort.signal;
  try {
    // No race: every step is a command (killed, or refused once aborted) or a workerCall (30 s timeout).
    await fn(dir);
  } finally {
    clearTimeout(timer);
    commandContext.signal = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
