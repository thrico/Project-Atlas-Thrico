// Self-check for the parts that talk to thrico-logic: log batching, key files and OTA jobs. No network, no build.
//   npm run check
import assert from "assert";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { BuildReporter, retryDelays, workerCall } from "./api";
import { prepareBuild } from "./steps/config";
import { keystoreAlias, privateKeyAliases } from "./steps/android";
import { execFileSync } from "child_process";
import { BuildBundle } from "./types";
import { MobileBuildWorker, visibility } from "./worker";
import { networkRetry, otaTimeLimit, otaWorkRoot } from "./ota";
import { REPO } from "./steps/repository";
import sharp from "sharp";

(async () => {
  const calls: { url: string; body: any }[] = [];
  let logStatus = 200;
  // Canned answers for GET /worker/ota/sends/<id> (where an OTA send publishes).
  const sendDetails: Record<string, { status?: number; body: unknown }> = {};
  const cdnHits: string[] = []; // the app's logo comes from the CDN, stubbed here
  const logoPng = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#f00" } }).webp().toBuffer();
  let flaky = 0; // /flaky answers 502 this many times, then 200
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url!.startsWith("/cdn/")) {
        cdnHits.push(req.url!);
        return res.end(logoPng);
      }
      assert.equal(req.headers.authorization, `Bearer ${process.env.BUILD_WORKER_TOKEN}`);
      calls.push({ url: req.url!, body: JSON.parse(raw || "{}") });
      const canned = sendDetails[req.url!];
      if (canned) {
        res.statusCode = canned.status ?? 200;
        return res.end(JSON.stringify(canned.body));
      }
      res.statusCode = req.url!.endsWith("/logs") ? logStatus : req.url === "/flaky" && flaky-- > 0 ? 502 : req.url === "/bad" ? 400 : 200;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.THRICO_API_URL = `http://127.0.0.1:${(server.address() as any).port}/`;
  process.env.BUILD_WORKER_TOKEN = "t".padEnd(32, "x");

  // A 5xx is retried until it clears; a 4xx is not.
  retryDelays.ms = [1, 1, 1];
  flaky = 2;
  await workerCall("/flaky", { a: 1 });
  assert.equal(calls.filter((c) => c.url === "/flaky").length, 3);
  flaky = 9;
  await assert.rejects(workerCall("/flaky", { a: 1 }), /502/);
  await assert.rejects(workerCall("/bad", { a: 1 }), /400/);
  assert.equal(calls.filter((c) => c.url === "/bad").length, 1);
  calls.length = 0;

  // Logs: split per step, at most 500 lines per call.
  let gone = 0;
  const r = new BuildReporter("b1", () => gone++);
  r.step = "Clone";
  for (let i = 0; i < 1201; i++) r.log(`line ${i}`);
  r.step = "Build";
  r.log("built");
  await r.flush();
  const logs = calls.filter((c) => c.url === "/worker/builds/b1/logs");
  assert.deepEqual(logs.map((c) => [c.body.step, c.body.lines.length]), [["Clone", 500], ["Clone", 500], ["Clone", 201], ["Build", 1]]);
  assert.equal(logs[2].body.lines[200], "line 1200");

  // A 409 on logs means the build was cancelled: stop.
  logStatus = 409;
  r.log("after cancel");
  await r.close();
  assert.equal(gone, 1);

  // Keys: fixed names inside the build folder, 0600, uploaded file names ignored.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-check-"));
  const file = (s: string) => ({ kind: "file" as const, fileName: "../../evil", value: Buffer.from(s).toString("base64") });
  const bundle: BuildBundle = {
    build: { id: "b1", platform: "android", gitRef: "release/1.0.0", versionName: "1.0.0", buildNumber: 7 },
    app: {
      id: "a1", entityId: "e1", appName: "Brand", androidPackageName: "com.brand.app", iosBundleId: "com.brand.app",
      branding: { appIcon: "x/icon.png", splashImage: "https://other/s.png", primaryColor: "#000" },
      android: { keystoreAlias: "upload" }, ios: { appleTeamId: "TEAM" }, eas: {}, cdnUrl: "https://cdn.example/",
    },
    secrets: {
      android_keystore: file("KEYSTORE"),
      android_keystorePassword: { kind: "text", value: "store-pass" },
      android_keyPassword: { kind: "text", value: "key-pass" },
      android_googleServicesJson: file("{}"),
    },
  };
  const p = prepareBuild(workDir, bundle);
  assert.equal(p.android.keystorePath, path.join(workDir, ".build-keys", "release.keystore"));
  assert.equal(fs.readFileSync(p.android.keystorePath!, "utf8"), "KEYSTORE");
  assert.equal(fs.statSync(p.android.keystorePath!).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(workDir, ".build-keys")).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(workDir, "android", "app", "google-services.json"), "utf8"), "{}");
  assert.equal(p.android.keystorePasswordSecret, "store-pass");
  assert.equal(p.android.versionCode, 7);
  assert.equal(p.android.serviceJsonPath, undefined); // missing key stays missing; the upload step fails on it
  assert.equal(p.ios.signingCertPath, undefined);
  assert.equal(p.branding.icon, "https://cdn.example/x/icon.png");
  assert.equal(p.branding.splash, "https://other/s.png");
  assert.ok(!fs.existsSync(path.join(workDir, "..", "evil")));

  // Key alias read from the keystore when the app has none set.
  const ks = path.join(workDir, "t.ks");
  const gen = (alias: string) =>
    execFileSync("keytool", ["-genkeypair", "-keystore", ks, "-storepass", "pass123456", "-keypass", "pass123456", "-alias", alias, "-keyalg", "RSA", "-dname", "CN=x", "-validity", "1"], { stdio: "ignore" });
  gen("my-upload");
  assert.equal(keystoreAlias(ks, "pass123456"), "my-upload");
  assert.throws(() => keystoreAlias(ks, "wrong-pass"), /Could not open the keystore/);
  gen("second");
  assert.throws(() => keystoreAlias(ks, "pass123456"), /holds 2 keys \(my-upload, second\)/);
  assert.deepEqual(privateKeyAliases("Alias name: ca\nEntry type: trustedCertEntry\n\nAlias name: k\nEntry type: PrivateKeyEntry\n"), ["k"]);

  // OTA jobs: routed by `type`, run with stub git/yarn/npx on PATH that log their args.
  const bin = path.join(workDir, "bin");
  const cmdLog = path.join(workDir, "commands.log");
  fs.mkdirSync(bin);
  const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${cmdLog}"\n${body}\n`, { mode: 0o755 });
  const gitBody = `case "$1" in
  clone) for a; do d=$a; done; mkdir -p "$d"; echo '{"expo": {"name": "Thrico"}}' > "$d/app.json";;
  init) for a; do d=$a; done; mkdir -p "$d";;
  fetch) [ -f "${cmdLog}.fetchfail" ] && { rm "${cmdLog}.fetchfail"; echo "fatal: early EOF" >&2; exit 128; };;
  merge-base) [ -n "$FAKE_NOT_ON_OTA" ] && exit 1;;
  log) echo "Fix the feed";;
  checkout) echo '{"name": "thrico"}' > package.json; echo '{"expo": {"name": "Thrico", "owner": "thrico_1", "slug": "thrico-thriving-communities"}}' > app.json;;
esac
exit 0`;
  stub("git", gitBody);
  stub("yarn", "exit 0");
  // node: the brand's theme/font scripts are only logged; `node -e` and scripts in bin/ run for real.
  fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh\ncase "$1" in -e|${bin}/*) exec "${process.execPath}" "$@";; esac\necho "node $*" >> "${cmdLog}"\n`, { mode: 0o755 });
  // What eas update would bundle: branding.json, the in-app logo (now a real PNG) and .env.
  fs.writeFileSync(path.join(bin, "brandcheck.js"), `const fs = require("fs");
const b = JSON.parse(fs.readFileSync("src/theme/branding.json", "utf8"));
const png = fs.readFileSync("assets/images/logo.png").subarray(1, 4).toString();
const pkg = /EXPO_PUBLIC_PACKAGE="([^"]*)"/.exec(fs.readFileSync(".env", "utf8"))[1];
console.log("  branded", b.primaryColor, b.font, b.logo, "logo=" + png, "package=" + pkg, "keys=" + fs.existsSync(".build-keys"));`);
  const npxBody = `echo "  env $NODE_OPTIONS $EXPO_TOKEN $EXPO_PUBLIC_API_URL $EXPO_PUBLIC_SENTRY_DSN" >> "${cmdLog}"
case "$3" in
  update) echo '[{"group":"0f1e2d3c-4b5a","runtimeVersion":"1.0.0","platform":"android","message":"Fix the feed"},{"group":"0f1e2d3c-4b5a","runtimeVersion":"1.0.0","platform":"ios","message":"Fix the feed"}]';;
  channel:create) exit 1;;
  update:republish) [ -n "$FAKE_REPUBLISH_FAIL" ] && exit 1;;
  install) grep -o '"packageManager": "[^"]*"' package.json >> "${cmdLog}";;
esac
project() { node -e 'const e=require("./app.json").expo;console.log("  project", e.owner, e.slug, e.extra.eas.projectId, e.updates.url, "token="+process.env.EXPO_TOKEN)' >> "${cmdLog}"; }
case "$4" in
  --channel) project; node "${bin}/brandcheck.js" >> "${cmdLog}";;
  --group) project;;
esac
exit 0`;
  stub("npx", npxBody);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  Object.assign(process.env, { EXPO_TOKEN: "expo-tok", APP_API_URL: "https://api.example/graphql", APP_SENTRY_DSN: "dsn", APP_WS_URL: "wss://api.example", APP_GOOGLE_MAPS_API_KEY: "maps" });
  otaWorkRoot.dir = path.join(workDir, "ota");
  logStatus = 200;
  const commands = () => {
    const lines = fs.existsSync(cmdLog) ? fs.readFileSync(cmdLog, "utf8").trim().split("\n") : [];
    fs.rmSync(cmdLog, { force: true });
    return lines.map((l) => l.replace(otaWorkRoot.dir, "<work>"));
  };
  const deleted: string[] = [];
  const worker = new MobileBuildWorker() as any;
  worker.sqs = { send: async (cmd: any) => deleted.push(cmd.input.ReceiptHandle) };
  const deliver = (body: unknown, receipt: string, count = 1) =>
    worker.handle({ Body: JSON.stringify(body), ReceiptHandle: receipt, Attributes: { ApproximateReceiveCount: String(count) } });
  const sha = "abcdef0123456789abcdef0123456789abcdef01";
  const events = () => calls.splice(0).filter((c) => c.url === "/worker/ota/events").map((c) => c.body);

  calls.length = 0;
  networkRetry.delayMs = 10;
  fs.writeFileSync(`${cmdLog}.fetchfail`, ""); // the first fetch times out, the retry works
  await deliver({ type: "ota-candidate", commit: sha }, "c1");
  const npxUpdate = `npx -y eas-cli@27.2.0 update --branch ota-abcdef0 --message Fix the feed --platform all --non-interactive --json`;
  assert.deepEqual(commands(), [
    `git init -q <work>/ota-${sha}`,
    `git fetch --depth 50 --no-tags ${REPO} +refs/heads/ota:refs/remotes/origin/ota`,
    `git fetch --depth 50 --no-tags ${REPO} +refs/heads/ota:refs/remotes/origin/ota`, // first try timed out
    `git merge-base --is-ancestor ${sha} origin/ota`,
    `git checkout --detach ${sha}`,
    `git log -1 --pretty=%s`,
    `npx -y yarn@1.22.22 install --frozen-lockfile`,
    `  env  expo-tok  `, // Yarn 1 pinned through npx, not the Mac's global yarn
    `"packageManager": "yarn@1.22.22"`, // and declared, so a parent folder's packageManager isn't used
    npxUpdate,
    `  env --max-old-space-size=8192 expo-tok https://api.example/graphql dsn`,
  ]);
  assert.deepEqual(events(), [
    { event: "ota.candidate", groupId: "0f1e2d3c-4b5a", commit: sha, branch: "ota-abcdef0", message: "Fix the feed", runtimeVersion: "1.0.0", platforms: ["android", "ios"] },
  ]);
  assert.deepEqual(deleted.splice(0), ["c1"]);
  assert.ok(!fs.existsSync(path.join(otaWorkRoot.dir, `ota-${sha}`)));

  // Not on origin/ota: nothing published or registered, message still deleted.
  process.env.FAKE_NOT_ON_OTA = "1";
  await deliver({ type: "ota-candidate", commit: sha }, "c2");
  delete process.env.FAKE_NOT_ON_OTA;
  assert.ok(!commands().some((c) => c.startsWith("npx")));
  assert.deepEqual(events(), []);
  assert.deepEqual(deleted.splice(0), ["c2"]);

  // OTA send: always into the app's own Expo project, with the app's token, branded for the app.
  const eas = "npx -y eas-cli@27.2.0";
  const send = { type: "ota-send", requestId: "o1", appId: "ibpc", groupId: "0f1e2d3c-4b5a", target: "app-com-ibpc-dubai", message: "Fix the feed" };
  const app = {
    entityId: "e1", appName: "IBPC Dubai", androidPackageName: "com.ibpc.dubai", iosBundleId: "com.ibpc.dubai",
    branding: { appIcon: "brand/icon.png", logo: "brand/logo.png", primaryColor: "#112233", secondaryColor: "#445566", font: "@expo-google-fonts/inter" },
    android: {}, ios: {}, eas: {}, cdnUrl: `${process.env.THRICO_API_URL}cdn/`,
  };
  const ownProject = { mode: "own", commit: sha, projectId: "bc86f517-0000-4000-8000-000000000000", owner: "thrico_1", slug: "ipbc-dubai", channel: "production", expoToken: "own-tok", app };
  const details = (id: string, body: unknown, status?: number) => (sendDetails[`/worker/ota/sends/${id}`] = { status, body });

  details("o1", { ...ownProject, action: "send" });
  await deliver(send, "o1");
  const ownCmds = commands().filter((c) => !c.startsWith("  env"));
  assert.deepEqual(ownCmds.slice(ownCmds.indexOf("npx -y yarn@1.22.22 install --frozen-lockfile")), [
    "npx -y yarn@1.22.22 install --frozen-lockfile",
    `"packageManager": "yarn@1.22.22"`,
    "npx yarn add @expo-google-fonts/inter", // the brand's font, then its theme, as a store build does
    "node scripts/ci-set-font.js @expo-google-fonts/inter",
    "node scripts/ci-set-theme.js #112233 #445566",
    `${eas} update --channel production --message Fix the feed --platform all --non-interactive --json`,
    "  project thrico_1 ipbc-dubai bc86f517-0000-4000-8000-000000000000 https://u.expo.dev/bc86f517-0000-4000-8000-000000000000 token=own-tok",
    `  branded #112233 @expo-google-fonts/inter ${app.cdnUrl}brand/logo.png logo=PNG package=com.ibpc.dubai keys=false`,
  ]);
  assert.deepEqual(cdnHits.splice(0), ["/cdn/brand/icon.png"]);
  assert.ok(!ownCmds.some((c) => c.includes("republish") || c.includes("channel:create") || c.includes("branch:create")), "nothing copied or created in thrico-mobile's project");
  assert.deepEqual(events(), [{ event: "ota.sent", appId: "ibpc", requestId: "o1", status: "success", groupId: "0f1e2d3c-4b5a" }]);

  details("o2", { ...ownProject, action: "rollback", groupId: "9e8d7c6b-1111" });
  await deliver({ ...send, requestId: "o2" }, "o2");
  const rbCmds = commands();
  assert.ok(rbCmds.includes(`${eas} update:republish --group 9e8d7c6b-1111 --destination-channel production --message Fix the feed --non-interactive --json`));
  assert.ok(rbCmds.some((c) => c.startsWith("  project thrico_1 ipbc-dubai") && c.endsWith("token=own-tok")));
  assert.ok(!rbCmds.some((c) => c.includes("yarn") || c.includes("branded")), "rollback needs no install or branding");
  assert.deepEqual(events(), [{ event: "ota.sent", appId: "ibpc", requestId: "o2", status: "success", groupId: "9e8d7c6b-1111" }]);

  process.env.FAKE_REPUBLISH_FAIL = "1";
  await deliver({ ...send, requestId: "o2" }, "o2b");
  delete process.env.FAKE_REPUBLISH_FAIL;
  commands();
  assert.deepEqual(events(), [{ event: "ota.sent", appId: "ibpc", requestId: "o2", status: "failure", error: "[eas update:republish] Failed with exit code 1" }]);

  details("o3", { error: "This OTA send is not pending" }, 409);
  await deliver({ ...send, requestId: "o3" }, "o3");
  assert.deepEqual([commands(), events()], [[], []], "a send that is no longer pending does nothing");

  // An old backend (shared mode, or no app branding) never gets a plain Thrico bundle sent.
  details("n1", { mode: "shared" });
  details("n2", { ...ownProject, action: "send", app: undefined });
  await deliver({ ...send, requestId: "n1" }, "n1");
  await deliver({ ...send, requestId: "n2" }, "n2");
  // Bad input never reaches a command; too many deliveries give up with a failure event.
  await deliver({ ...send, requestId: "x; rm -rf /" }, "s3");
  await deliver(send, "s4", 4);
  assert.deepEqual(commands(), []);
  assert.deepEqual(events().map((e) => [e.status, e.error]), [
    ["failure", "The backend is out of date; update thrico-logic"],
    ["failure", "The backend is out of date; update thrico-logic"],
    ["failure", "Invalid request x; rm -rf /"],
    ["failure", "The build worker gave up after 3 attempts"],
  ]);
  await deliver({ type: "nope" }, "x1");
  assert.deepEqual(deleted.splice(0), ["o1", "o2", "o2b", "o3", "n1", "n2", "s3", "s4", "x1"]);

  // Time limit kills the running command and fails the send.
  otaTimeLimit.ms = 200;
  stub("npx", "sleep 5");
  await deliver({ ...send, requestId: "o2" }, "s5");
  const [timedOut] = events();
  assert.equal(timedOut.status, "failure");
  assert.match(timedOut.error, /Timed out after/);
  commands();
  assert.deepEqual(deleted.splice(0), ["s5"]);

  // Heartbeat: while a job runs its message's hold is renewed (short), and it stops once the job ends.
  visibility.heartbeatMs = 50;
  otaTimeLimit.ms = 10_000;
  stub("npx", "sleep 0.4");
  const sqsCalls: { name: string; input: any }[] = [];
  worker.sqs = { send: async (cmd: any) => void sqsCalls.push({ name: cmd.constructor.name, input: cmd.input }) };
  await deliver({ ...send, requestId: "o2" }, "h1");
  const holds = sqsCalls.filter((c) => c.name === "ChangeMessageVisibilityCommand");
  assert.ok(holds.length >= 3, `heartbeat renewed the hold (${holds.length}x)`);
  assert.ok(holds.every((c) => c.input.ReceiptHandle === "h1" && c.input.VisibilityTimeout === visibility.seconds));
  assert.equal(sqsCalls.at(-1)!.name, "DeleteMessageCommand");
  const after = sqsCalls.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sqsCalls.length, after, "no renewals after the job ended");
  events();
  commands();

  fs.rmSync(workDir, { recursive: true, force: true });
  server.close();
  console.log("worker.check: ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
