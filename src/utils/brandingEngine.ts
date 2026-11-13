import fs from 'fs';
import path from 'path';
import xml2js from 'xml2js';
import sharp from 'sharp';
import { MobilePublishPayload } from '../types';

export class BrandingEngine {
  static async applyBranding(workingDir: string, payload: MobilePublishPayload) {
    console.log(`Applying branding for ${payload.app.name}...`);

    // 1. Android - Update App Name in strings.xml
    const androidStringsPath = path.join(workingDir, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
    if (fs.existsSync(androidStringsPath)) {
      const xmlString = fs.readFileSync(androidStringsPath, 'utf8');
      const parser = new xml2js.Parser();
      const builder = new xml2js.Builder();
      const result = await parser.parseStringPromise(xmlString);

      if (result.resources && result.resources.string) {
        for (const str of result.resources.string) {
          if (str.$ && str.$.name === 'app_name') {
            str._ = payload.app.name;
          }
        }
      }
      fs.writeFileSync(androidStringsPath, builder.buildObject(result));
      console.log('Updated Android app name');
    }

    // 2. iOS - Update App Name and Version in Info.plist (Simulated via naive replacement for POC)
    const iosInfoPlistPath = path.join(workingDir, 'ios', 'Thrico', 'Info.plist');
    if (fs.existsSync(iosInfoPlistPath)) {
      let plistContent = fs.readFileSync(iosInfoPlistPath, 'utf8');

      // Update App Name
      const nameRegex = /<key>CFBundleDisplayName<\/key>\s*<string>.*?<\/string>/;
      plistContent = plistContent.replace(nameRegex, `<key>CFBundleDisplayName</key>\n\t<string>${payload.app.name}</string>`);

      // Update Version Name
      const vName = payload.ios?.version || payload.app.version;
      const vCode = payload.ios?.buildNumber || payload.app.buildNumber;

      const versionRegex = /<key>CFBundleShortVersionString<\/key>\s*<string>.*?<\/string>/;
      plistContent = plistContent.replace(versionRegex, `<key>CFBundleShortVersionString</key>\n\t<string>${vName}</string>`);

      // Update Build Number
      const buildRegex = /<key>CFBundleVersion<\/key>\s*<string>.*?<\/string>/;
      plistContent = plistContent.replace(buildRegex, `<key>CFBundleVersion</key>\n\t<string>${vCode}</string>`);

      // Update hardcoded permission names
      plistContent = plistContent.replace(/Thrico needs/g, `${payload.app.name} needs`);

      fs.writeFileSync(iosInfoPlistPath, plistContent);
      console.log(`Updated iOS app name to ${payload.app.name}, version ${vName} (${vCode})`);
    }

    // 3. Inject colors (simulate creating a branding.json or theme.json for RN)
    const themePath = path.join(workingDir, 'src', 'theme', 'branding.json');
    if (fs.existsSync(path.dirname(themePath)) || true) {
      fs.mkdirSync(path.dirname(themePath), { recursive: true });
      fs.writeFileSync(themePath, JSON.stringify(payload.branding, null, 2));
      console.log('Updated app color theme');
    }

    // 4. Update iOS Bundle ID in project.pbxproj
    const pbxprojPath = path.join(workingDir, 'ios', 'Thrico.xcodeproj', 'project.pbxproj');
    if (fs.existsSync(pbxprojPath)) {
      let pbxprojContent = fs.readFileSync(pbxprojPath, 'utf8');
      const bundleIdRegex = /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*[^;]+;/g;
      pbxprojContent = pbxprojContent.replace(bundleIdRegex, `PRODUCT_BUNDLE_IDENTIFIER = ${payload.ios.bundleId};`);
      fs.writeFileSync(pbxprojPath, pbxprojContent);
      console.log('Updated iOS Bundle ID');
    }

    // Sanitize Android package name to ensure it is a valid Java package (no hyphens)
    const sanitizedPackageName = payload.android.packageName.replace(/-/g, '_');

    // 5. Update Android applicationId, versionCode, and versionName in app/build.gradle
    const androidBuildGradlePath = path.join(workingDir, 'android', 'app', 'build.gradle');
    if (fs.existsSync(androidBuildGradlePath)) {
      let gradleContent = fs.readFileSync(androidBuildGradlePath, 'utf8');

      const appIdRegex = /applicationId\s+["'][^"']+["']/g;
      gradleContent = gradleContent.replace(appIdRegex, `applicationId "${sanitizedPackageName}"`);

      const vName = payload.android?.versionName || payload.app.version;
      const vCode = payload.android?.versionCode || payload.app.buildNumber;

      const vNameRegex = /versionName\s+["'][^"']+["']/g;
      gradleContent = gradleContent.replace(vNameRegex, `versionName "${vName}"`);

      const vCodeRegex = /versionCode\s+\d+/g;
      gradleContent = gradleContent.replace(vCodeRegex, `versionCode ${vCode}`);

      fs.writeFileSync(androidBuildGradlePath, gradleContent);
      console.log(`Updated Android applicationId, versionName (${vName}) and versionCode (${vCode})`);
    }

    // 6. Patch google-services.json to prevent build failures due to package name mismatch
    const googleServicesPath = path.join(workingDir, 'android', 'app', 'google-services.json');
    if (fs.existsSync(googleServicesPath)) {
      try {
        const gsContent = fs.readFileSync(googleServicesPath, 'utf8');
        const gsJson = JSON.parse(gsContent);
        if (gsJson.client && gsJson.client.length > 0 && gsJson.client[0].client_info) {
          gsJson.client[0].client_info.android_client_info.package_name = sanitizedPackageName;
          fs.writeFileSync(googleServicesPath, JSON.stringify(gsJson, null, 2));
          console.log('Updated Android google-services.json package name');
        }
      } catch (e) {
        console.error('Failed to parse or update google-services.json', e);
      }
    }

    // 7. Overwrite in-app assets (assets/logo.png AND assets/images/logo.png)
    const rootLogoPath = path.join(workingDir, 'logo.png');

    if (fs.existsSync(rootLogoPath)) {
      const inAppLogoDir1 = path.join(workingDir, 'assets');
      const inAppLogoDir2 = path.join(workingDir, 'assets', 'images');

      if (!fs.existsSync(inAppLogoDir1)) fs.mkdirSync(inAppLogoDir1, { recursive: true });
      if (!fs.existsSync(inAppLogoDir2)) fs.mkdirSync(inAppLogoDir2, { recursive: true });

      // Use sharp to convert WebP/mismatched format to a true PNG to prevent AAPT compilation errors
      await sharp(rootLogoPath)
        .png()
        .toFile(path.join(inAppLogoDir1, 'logo.png'));

      await sharp(rootLogoPath)
        .png()
        .toFile(path.join(inAppLogoDir2, 'logo.png'));

      console.log('Updated in-app assets/logo.png and assets/images/logo.png (converted to true PNG)');
    }

    // 8. Inject Environment Variables into .env
    const envPath = path.join(workingDir, '.env');
    // App-wide settings come from the worker's environment (see .env.example), never from source.
    const required = (name: string) => {
      const value = process.env[name];
      if (!value) throw new Error(`Missing ${name} in the build worker's environment`);
      return value;
    };
    const envVars = [
      `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY="${required('APP_GOOGLE_MAPS_API_KEY')}"`,
      `EXPO_PUBLIC_SENTRY_DSN=${process.env.APP_SENTRY_DSN ?? ''}`,
      `EXPO_PUBLIC_API_URL=${required('APP_API_URL')}`,
      `EXPO_PUBLIC_WS_URL=${required('APP_WS_URL')}`,
      'EXPO_PUBLIC_APP_TYPE=custom',
      `EXPO_PUBLIC_ENTITY_ID="${payload.android?.packageName}"`,

      `EXPO_PUBLIC_PACKAGE="${payload.android?.packageName}"`
    ].join('\n');

    if (fs.existsSync(envPath)) {
      fs.appendFileSync(envPath, '\n' + envVars + '\n');
    } else {
      fs.writeFileSync(envPath, envVars + '\n');
    }
    console.log('Injected environment variables into .env');
  }
}
