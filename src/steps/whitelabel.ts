import { executeCommand } from "../utils/command";
import { MobilePublishPayload } from "../types";

export async function applyDynamicWhitelabeling(workDir: string, payload: MobilePublishPayload): Promise<void> {
  console.log("Step 10: Apply Dynamic Whitelabeling");

  // Changing the App Font
  if (payload.branding.font) {
    console.log(`Installing font: ${payload.branding.font}`);
    await executeCommand("npx", ["yarn", "add", payload.branding.font], workDir, "YARN ADD FONT");
    
    console.log(`Running font injector script for: ${payload.branding.font}`);
    await executeCommand("node", ["scripts/ci-set-font.js", payload.branding.font], workDir, "SET FONT");
  }

  // Changing the App Theme
  if (payload.branding.primaryColor) {
    const themeArgs = [
      "scripts/ci-set-theme.js",
      payload.branding.primaryColor,
    ];
    
    if (payload.branding.secondaryColor) {
      themeArgs.push(payload.branding.secondaryColor);
    }
    
    if (payload.branding.accentColor) {
      themeArgs.push(payload.branding.accentColor);
    }

    if (payload.branding.primaryGradientStart) {
      themeArgs.push(payload.branding.primaryGradientStart);
    }

    if (payload.branding.primaryGradientEnd) {
      themeArgs.push(payload.branding.primaryGradientEnd);
    }

    console.log(`Running theme injector script...`);
    await executeCommand("node", themeArgs, workDir, "SET THEME");
  }
}
