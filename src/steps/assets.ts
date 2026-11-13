import fs from "fs";
import path from "path";
import { MobilePublishPayload } from "../types";

import { AssetGenerator } from "../utils/assetGenerator";
import { BrandingEngine } from "../utils/brandingEngine";

export async function downloadAssets(
  workDir: string,
  payload: MobilePublishPayload,
): Promise<void> {
  console.log("Step 6: Download Assets");

  // A store build never ships a placeholder icon.
  if (!payload.branding.icon) throw new Error("The app has no icon (appIcon)");
  const download = async (url: string, file: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    fs.writeFileSync(path.join(workDir, file), Buffer.from(await response.arrayBuffer()));
    console.log(`Saved ${url} to ${file}`);
  };
  await download(payload.branding.icon, "logo.png");
  if (payload.branding.splash) await download(payload.branding.splash, "splash.png");
}

export async function applyBranding(
  workDir: string,
  payload: MobilePublishPayload,
): Promise<void> {
  console.log("Step 7: Apply Branding");
  await BrandingEngine.applyBranding(workDir, payload);
}

export async function generateAssets(
  workDir: string,
  payload: MobilePublishPayload,
): Promise<void> {
  console.log("Step 8: Generate Assets");

  let logoPath = path.join(workDir, "logo.png");
  if (!fs.existsSync(logoPath)) {
    logoPath = path.join(workDir, "logo.svg");
  }

  await AssetGenerator.generateIcons(logoPath, workDir);

  const splashPath = path.join(workDir, "splash.png");
  if (fs.existsSync(splashPath)) {
    console.log("Generating splash screens...");
    await AssetGenerator.generateSplash(splashPath, workDir);
  }
}
