import fs from "fs";
import path from "path";
import { BuildBundle, MobilePublishPayload } from "../types";

export const keysDir = (workDir: string) => path.join(workDir, ".build-keys");

/**
 * Writes the bundle's keys into the build folder (0600, removed with the folder at cleanup) and maps
 * the bundle onto the pipeline payload. File names are fixed here, never taken from the upload.
 */
export function prepareBuild(workDir: string, bundle: BuildBundle): MobilePublishPayload {
  const { build, app, secrets } = bundle;
  const dir = keysDir(workDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const text = (key: string) => (secrets[key]?.kind === "text" ? secrets[key].value : "");
  const file = (key: string, dest: string) => {
    const s = secrets[key];
    if (!s) return undefined;
    if (s.kind !== "file") throw new Error(`Key ${key} should be a file`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(s.value, "base64"), { mode: 0o600 });
    fs.chmodSync(dest, 0o600); // mode above applies only to new files
    return dest;
  };

  // Firebase configs go where the native projects read them (also inside the build folder).
  file("android_googleServicesJson", path.join(workDir, "android", "app", "google-services.json"));
  file("ios_googleServiceInfoPlist", path.join(workDir, "ios", "GoogleService-Info.plist"));

  const b = app.branding ?? {};
  const image = (key: string) => {
    const v = b[key];
    return !v ? "" : /^https?:\/\//.test(v) ? v : `${app.cdnUrl.replace(/\/$/, "")}/${v}`;
  };

  return {
    buildId: build.id,
    entityId: app.entityId,
    appId: app.id,
    platform: build.platform,
    app: {
      name: app.appName,
      shortName: b.shortName || app.appName,
      description: b.description || "",
      version: build.versionName,
      buildNumber: build.buildNumber,
    },
    android: {
      packageName: app.androidPackageName || "",
      keystorePath: file("android_keystore", path.join(dir, "release.keystore")),
      serviceJsonPath: file("android_playServiceAccountJson", path.join(dir, "play-service-account.json")),
      keystoreAlias: app.android?.keystoreAlias || "",
      keystorePasswordSecret: text("android_keystorePassword"),
      keyPasswordSecret: text("android_keyPassword"),
      versionName: build.versionName,
      versionCode: build.buildNumber,
    },
    ios: {
      bundleId: app.iosBundleId || "",
      teamId: app.ios?.appleTeamId || "",
      keyId: text("ios_ascApiKeyId"),
      issuerId: text("ios_ascIssuerId"),
      apiKeySecret: file("ios_ascApiKeyP8", path.join(dir, "AuthKey.p8")),
      provisionProfile: file("ios_provisioningProfile", path.join(dir, "AppStore.mobileprovision")),
      signingCertPath: file("ios_distributionCertP12", path.join(dir, "distribution.p12")),
      signingCertPassword: text("ios_distributionCertPassword"),
      exportMethod: "app-store",
      version: build.versionName,
      buildNumber: build.buildNumber,
    },
    branding: {
      logo: image("logo"),
      icon: image("appIcon"),
      splash: image("splashImage"),
      font: b.font,
      primaryColor: b.primaryColor,
      secondaryColor: b.secondaryColor,
      accentColor: b.accentColor,
      primaryGradientStart: b.primaryGradientStart,
      primaryGradientEnd: b.primaryGradientEnd,
    },
    git: { branch: build.gitRef },
  };
}
