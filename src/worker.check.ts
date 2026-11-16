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
import { otaTimeLimit, otaWorkRoot } from "./ota";
import { REPO } from "./steps/repository";

(async () => {
  const calls: { url: string; body: any }[] = [];
  let logStatus = 200;
  let flaky = 0; // /flaky answers 502 this many times, then 200
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      assert.equal(req.headers.authorization, `Bearer ${process.env.BUILD_WORKER_TOKEN}`);
      calls.push({ url: req.url!, body: JSON.parse(raw || "{}") });
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
  stub("git", `case "$1" in
  clone) for a; do d=$a; done; mkdir -p "$d";;
  merge-base) [ -n "$FAKE_NOT_ON_OTA" ] && exit 1;;
  log) echo "Fix the feed";;
esac
exit 0`);
  stub("yarn", "exit 0");
  stub("npx", `echo "  env $NODE_OPTIONS $EXPO_TOKEN $EXPO_PUBLIC_API_URL $EXPO_PUBLIC_SENTRY_DSN" >> "${cmdLog}"
case "$3" in
  update) echo '[{"group":"0f1e2d3c-4b5a","runtimeVersion":"1.0.0","platform":"android","message":"Fix the feed"},{"group":"0f1e2d3c-4b5a","runtimeVersion":"1.0.0","platform":"ios","message":"Fix the feed"}]';;
  channel:create) exit 1;;
  update:republish) [ -n "$FAKE_REPUBLISH_FAIL" ] && exit 1;;
esac
exit 0`);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  Object.assign(process.env, { EXPO_TOKEN: "expo-tok", APP_API_URL: "https://api.example/graphql", APP_SENTRY_DSN: "dsn" });
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
  await deliver({ type: "ota-candidate", commit: sha }, "c1");
  const npxUpdate = `npx -y eas-cli@27.2.0 update --branch ota-abcdef0 --message Fix the feed --platform all --non-interactive --json`;
  assert.deepEqual(commands(), [
    `git clone --filter=blob:none --no-checkout ${REPO} <work>/ota-${sha}`,
    `git merge-base --is-ancestor ${sha} origin/ota`,
    `git checkout --detach ${sha}`,
    `git log -1 --pretty=%s`,
    `yarn install --frozen-lockfile`,
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

  const send = { type: "ota-send", requestId: "r1", appId: "a1", groupId: "0f1e2d3c-4b5a", target: "app-com-brand-app", message: "Fix the feed" };
  await deliver(send, "s1");
  const eas = "npx -y eas-cli@27.2.0";
  assert.deepEqual(commands().filter((c) => !c.startsWith("  env")), [
    `git clone --depth 1 ${REPO} <work>/ota-send-r1`,
    `${eas} branch:create app-com-brand-app --non-interactive`,
    `${eas} channel:create app-com-brand-app --non-interactive`, // fails as "exists"; ignored
    `${eas} channel:edit app-com-brand-app --branch app-com-brand-app --non-interactive`,
    `${eas} update:republish --group 0f1e2d3c-4b5a --destination-branch app-com-brand-app --message Fix the feed --non-interactive --json`,
  ]);
  assert.deepEqual(events(), [{ event: "ota.sent", appId: "a1", requestId: "r1", status: "success" }]);
  assert.deepEqual(deleted.splice(0), ["s1"]);

  process.env.FAKE_REPUBLISH_FAIL = "1";
  await deliver(send, "s2");
  delete process.env.FAKE_REPUBLISH_FAIL;
  commands();
  assert.deepEqual(events(), [{ event: "ota.sent", appId: "a1", requestId: "r1", status: "failure", error: "[eas update:republish] Failed with exit code 1" }]);
  assert.deepEqual(deleted.splice(0), ["s2"]);

  // Bad input never reaches a command; too many deliveries give up with a failure event.
  await deliver({ ...send, target: "app-x; rm -rf /" }, "s3");
  await deliver(send, "s4", 4);
  assert.deepEqual(commands(), []);
  assert.deepEqual(events().map((e) => [e.status, e.error]), [
    ["failure", "Invalid target app-x; rm -rf /"],
    ["failure", "The build worker gave up after 3 attempts"],
  ]);
  await deliver({ type: "nope" }, "x1");
  assert.deepEqual(deleted.splice(0), ["s3", "s4", "x1"]);

  // Time limit kills the running command and fails the send.
  otaTimeLimit.ms = 200;
  stub("npx", "sleep 5");
  await deliver(send, "s5");
  const [timedOut] = events();
  assert.equal(timedOut.status, "failure");
  assert.match(timedOut.error, /Not started: Timed out after/);
  assert.ok(!commands().some((c) => c.includes("republish")));
  assert.deepEqual(deleted.splice(0), ["s5"]);

  // Heartbeat: while a job runs its message's hold is renewed (short), and it stops once the job ends.
  visibility.heartbeatMs = 50;
  otaTimeLimit.ms = 10_000;
  stub("npx", "sleep 0.4");
  const sqsCalls: { name: string; input: any }[] = [];
  worker.sqs = { send: async (cmd: any) => void sqsCalls.push({ name: cmd.constructor.name, input: cmd.input }) };
  await deliver(send, "h1");
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
