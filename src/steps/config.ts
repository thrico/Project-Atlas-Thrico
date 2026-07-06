import { EntityConfig } from "../types";

export async function fetchConfig(entityId: string): Promise<EntityConfig> {
  console.log(`Step 5: Fetch Entity Configuration for ${entityId}`);
  // In a real scenario: const response = await axios.get(`\${process.env.BACKEND_API_URL}/mobile/config/\${entityId}`);
  // MOCK config for POC
  return {
    appName: "My Entity App",
    packageName: "com.thrico.myentity",
    bundleId: "com.thrico.myentity",
    theme: "dark",
    colors: {
      primary: "#FF0000",
      secondary: "#00FF00",
      background: "#000000",
    },
    version: "1.0.0",
  };
}
