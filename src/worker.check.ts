// Self-check for the parts that talk to thrico-logic: log batching and key files. No network, no build.
//   npm run check
import assert from "assert";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { BuildReporter } from "./api";
import { prepareBuild } from "./steps/config";
import { BuildBundle } from "./types";

(async () => {
  const calls: { url: string; body: any }[] = [];
  let logStatus = 200;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      assert.equal(req.headers.authorization, `Bearer ${process.env.BUILD_WORKER_TOKEN}`);
      calls.push({ url: req.url!, body: JSON.parse(raw || "{}") });
      res.statusCode = req.url!.endsWith("/logs") ? logStatus : 200;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.THRICO_API_URL = `http://127.0.0.1:${(server.address() as any).port}/`;
  process.env.BUILD_WORKER_TOKEN = "t".padEnd(32, "x");

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

  fs.rmSync(workDir, { recursive: true, force: true });
  server.close();
  console.log("worker.check: ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
