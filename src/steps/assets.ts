import fs from "fs";
import path from "path";
import { MobilePublishPayload } from "../types";
import { BrandingEngine } from "../utils/brandingEngine";
import { AssetGenerator } from "../utils/assetGenerator";

export async function downloadAssets(
  workDir: string,
  payload: MobilePublishPayload,
): Promise<void> {
  console.log("Step 6: Download Assets");

  if (payload.branding && payload.branding.icon) {
    console.log(`Downloading icon from ${payload.branding.icon}`);
    try {
      const response = await fetch(payload.branding.icon);
      if (!response.ok)
        throw new Error(`Failed to fetch image: ${response.statusText}`);

      const buffer = await response.arrayBuffer();
      const logoPath = path.join(workDir, "logo.png");
      fs.writeFileSync(logoPath, Buffer.from(buffer));
      console.log(`Saved icon to ${logoPath}`);
      
      // Also download splash if present
      if (payload.branding.splash) {
        console.log(`Downloading splash from ${payload.branding.splash}`);
        const splashRes = await fetch(payload.branding.splash);
        if (splashRes.ok) {
          const splashBuffer = await splashRes.arrayBuffer();
          fs.writeFileSync(path.join(workDir, "splash.png"), Buffer.from(splashBuffer));
          console.log(`Saved splash to splash.png`);
        }
      }
    } catch (err) {
      console.error("Failed to download icon, using fallback mock", err);
      // Fallback
      createMockLogo(workDir);
    }
  } else {
    createMockLogo(workDir);
  }
}

function createMockLogo(workDir: string) {
  const mockLogoSvg = `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">
    <rect width="1024" height="1024" fill="#000" />
    <circle cx="512" cy="512" r="256" fill="#f00" />
  </svg>`;
  fs.writeFileSync(path.join(workDir, "logo.svg"), mockLogoSvg);
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
