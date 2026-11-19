import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { ApiError, workerCall } from "./api";
import { REPO } from "./steps/repository";
import { pinYarn1 } from "./steps/dependencies";
import { keysDir, prepareBuild } from "./steps/config";
import { applyBranding, downloadAssets } from "./steps/assets";
import { applyDynamicWhitelabeling } from "./steps/whitelabel";
import { BuildBundle } from "./types";
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
    const subject = await checkoutAndInstall(dir, commit);
    const out = await executeCommand(
      "npx",
      [...EAS, "update", "--branch", branch, "--message", subject, "--platform", "all", "--non-interactive", "--json"],
      dir,
      "eas update",
      publishEnv(process.env.EXPO_TOKEN),
    );
    const update = parseUpdate(out);
    const event = { event: "ota.candidate", ...update, commit, branch, message: update.message ?? subject };
    await workerCall("/worker/ota/events", event);
    console.log(`OTA candidate ${branch}: group ${event.groupId}, runtime ${event.runtimeVersion}`);
  });
}

/** Publishes the branded bundle (or rolls back) in the app's own Expo project; always reports ota.sent, failure included. */
export async function runOtaSend(job: Extract<OtaMessage, { type: "ota-send" }>) {
  const { requestId, appId, message = "OTA send" } = job;
  let error: string | undefined;
  let published: string | undefined;
  try {
    if (!/^[0-9a-zA-Z-]{1,64}$/.test(requestId ?? "")) throw new Error(`Invalid request ${requestId}`);
    let details: OwnProject;
    try {
      details = await workerCall(`/worker/ota/sends/${requestId}`);
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409) return console.log(`OTA send ${requestId}: no longer pending; skipping`);
      throw e;
    }
    // Only an app in its own Expo project, with its branding, can get its own bundle.
    if (details?.mode !== "own" || !details.app) throw new Error("The backend is out of date; update thrico-logic");
    published = await sendIntoOwnProject(requestId, appId, details, message);
  } catch (e: any) {
    error = e?.message ?? String(e);
  }
  console.log(`OTA send ${requestId}: ${error ? `failed: ${error}` : `sent (group ${published})`}`);
  await workerCall("/worker/ota/events", {
    event: "ota.sent",
    appId,
    requestId,
    status: error ? "failure" : "success",
    ...(error ? { error } : {}),
    ...(published ? { groupId: published } : {}),
  });
}

type OwnProject = {
  mode: "own";
  action: "send" | "rollback";
  commit: string;
  projectId: string;
  owner: string;
  slug: string;
  channel: string;
  expoToken: string;
  groupId?: string;
  /** Same as a store build's bundle.app, without keys. */
  app: Omit<BuildBundle["app"], "id">;
};

/**
 * Send: build the commit, branded for the app, into the app's own Expo project on its channel.
 * Rollback: put the earlier group back on that channel. Both with the app's token. Returns the group now live.
 */
async function sendIntoOwnProject(requestId: string, appId: string, d: OwnProject, message: string): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(d.projectId ?? "")) throw new Error(`Invalid Expo project ${d.projectId}`);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(d.channel ?? "") || !/^[A-Za-z0-9_.-]{1,100}$/.test(d.slug ?? "") || !/^[A-Za-z0-9_.-]{1,100}$/.test(d.owner ?? "")) {
    throw new Error("Invalid Expo owner, slug or channel");
  }
  if (!d.expoToken) throw new Error("The app's Expo token is missing");
  let live = "";
  await inWorkDir(`ota-send-${requestId}`, async (dir) => {
    if (d.action === "rollback") {
      if (!/^[0-9a-fA-F-]{8,64}$/.test(d.groupId ?? "")) throw new Error(`Invalid group ${d.groupId}`);
      await retryNetwork("git clone", () => executeCommand("git", ["clone", "--depth", "1", REPO, dir], process.cwd(), "git clone"));
      stripConfigPlugins(dir);
      pointAtProject(dir, d);
      await executeCommand(
        "npx",
        [...EAS, "update:republish", "--group", d.groupId!, "--destination-channel", d.channel, "--message", message, "--non-interactive", "--json"],
        dir,
        "eas update:republish",
        { EXPO_TOKEN: d.expoToken },
      );
      live = d.groupId!;
      return;
    }
    await checkoutAndInstall(dir, d.commit);
    const versionName = JSON.parse(fs.readFileSync(path.join(dir, "app.json"), "utf8")).expo?.version ?? "1.0.0";
    await brandForApp(dir, { ...d.app, id: appId }, versionName);
    pointAtProject(dir, d);
    const out = await executeCommand(
      "npx",
      [...EAS, "update", "--channel", d.channel, "--message", message, "--platform", "all", "--non-interactive", "--json"],
      dir,
      "eas update",
      publishEnv(d.expoToken),
    );
    live = parseUpdate(out).groupId;
  });
  return live;
}

/** The store build's JS-side branding steps, in pipeline order: theme, font, in-app logo, branding.json, .env. */
async function brandForApp(dir: string, app: BuildBundle["app"], versionName: string) {
  const payload = prepareBuild(dir, { build: { id: "ota", platform: "android", gitRef: "ota", versionName, buildNumber: 0 }, app, secrets: {} });
  fs.rmSync(keysDir(dir), { recursive: true, force: true }); // no keys on a send; drop the empty folder
  await downloadAssets(dir, payload);
  await applyBranding(dir, payload, { native: false }); // native files aren't in an OTA bundle
  // generateAssets is skipped: it only makes native icons.
  await applyDynamicWhitelabeling(dir, payload);
}

/** Shallow fetch of the ota branch, check the commit is on it, check it out, install with Yarn 1. */
async function checkoutAndInstall(dir: string, commit: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error(`Invalid commit ${commit}`);
  // One shallow fetch: everything arrives in a single download (a blob-less clone fetched files
  // lazily during checkout, which failed midway on slow connections).
  await executeCommand("git", ["init", "-q", dir], process.cwd(), "git init");
  await retryNetwork("git fetch", () =>
    executeCommand("git", ["fetch", "--depth", String(OTA_HISTORY), "--no-tags", REPO, "+refs/heads/ota:refs/remotes/origin/ota"], dir, "git fetch ota"),
  );
  await executeCommand("git", ["merge-base", "--is-ancestor", commit, "origin/ota"], dir, "check commit is on ota").catch(() => {
    throw new Error(`${commit} is not among the newest ${OTA_HISTORY} commits of the ota branch`);
  });
  await executeCommand("git", ["checkout", "--detach", commit], dir, `git checkout ${commit}`);
  const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: dir, encoding: "utf8" }).trim();
  // macOS creates AppleDouble (._) sidecar files on non-HFS+ volumes (exFAT SSDs).
  // They break patch-package (._*.patch) and Metro (.__layout.tsx etc). Remove them all.
  cleanAppleDoubleFiles(dir);
  pinYarn1(dir);
  await retryNetwork("yarn install", () => executeCommand("npx", [...YARN, "install", "--frozen-lockfile"], dir, "yarn install"));
  // yarn install may recreate ._ files in node_modules; clean again for Metro.
  cleanAppleDoubleFiles(dir);
  return subject;
}

/** Settings `eas update` builds with: memory for Metro and the app's public config. */
const publishEnv = (expoToken?: string) => ({
  NODE_OPTIONS: "--max-old-space-size=8192", // Metro bundles both platforms with source maps
  EXPO_TOKEN: expoToken,
  EXPO_PUBLIC_API_URL: process.env.APP_API_URL,
  EXPO_PUBLIC_WS_URL: process.env.APP_WS_URL,
  EXPO_PUBLIC_GOOGLE_MAPS_API_KEY: process.env.APP_GOOGLE_MAPS_API_KEY,
  EXPO_PUBLIC_SENTRY_DSN: process.env.APP_SENTRY_DSN,
});

/** `eas update --json` lists one update per platform sharing a group. */
function parseUpdate(out: string) {
  const parsed = JSON.parse(out);
  const list: any[] = Array.isArray(parsed) ? parsed : [parsed];
  const update = {
    groupId: list[0]?.group as string,
    runtimeVersion: list[0]?.runtimeVersion as string,
    message: list[0]?.message as string | undefined,
    platforms: [...new Set(list.map((u) => u.platform))],
  };
  if (!update.groupId || !update.runtimeVersion) throw new Error("eas update returned no group or runtime version");
  return update;
}

/** Point the checkout at the app's own Expo project, so EAS publishes there and the app finds it. */
function pointAtProject(dir: string, d: Pick<OwnProject, "projectId" | "owner" | "slug">) {
  const p = path.join(dir, "app.json");
  const json = JSON.parse(fs.readFileSync(p, "utf8"));
  const expo = (json.expo ??= {});
  expo.owner = d.owner;
  expo.slug = d.slug;
  expo.extra = { ...expo.extra, eas: { ...expo.extra?.eas, projectId: d.projectId } };
  expo.updates = { ...expo.updates, url: `https://u.expo.dev/${d.projectId}` };
  fs.writeFileSync(p, JSON.stringify(json, null, 2));
}

/** Strip plugins and dynamic configs so EAS CLI doesn't try to resolve uninstalled node_modules. */
function stripConfigPlugins(dir: string) {
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

/**
 * Recursively remove macOS AppleDouble `._*` sidecar files that macOS creates on
 * non-HFS+ volumes (e.g. exFAT SSDs). These break Metro (binary `.__layout.tsx`),
 * patch-package (`._react-native+…`), and other tools that glob for source files.
 */
function cleanAppleDoubleFiles(dir: string) {
  try {
    execFileSync("find", [dir, "-name", "._*", "-type", "f", "-delete"], { stdio: "ignore" });
  } catch {
    // Best-effort: some files may already have been removed or be on broken symlinks.
  }
}
