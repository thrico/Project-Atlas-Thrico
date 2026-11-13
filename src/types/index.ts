/** SQS message from thrico-logic: ids only, everything else comes from the bundle endpoint. */
export interface BuildMessage {
  buildId: string;
  appId: string;
  platform: 'android' | 'ios';
  gitRef: string;
}

/** GET /worker/builds/:id/bundle (thrico-logic src/schema/custom-app/builds.ts buildBundle). */
export interface BuildBundle {
  build: { id: string; platform: 'android' | 'ios'; gitRef: string; versionName: string; buildNumber: number };
  app: {
    id: string;
    entityId: string;
    appName: string;
    androidPackageName?: string;
    iosBundleId?: string;
    branding: Record<string, any>;
    android: { keystoreAlias?: string; [k: string]: any };
    ios: { appleTeamId?: string; [k: string]: any };
    eas: Record<string, any>;
    cdnUrl: string;
  };
  secrets: Record<string, { kind: 'text' | 'file'; fileName?: string; value: string }>;
}

export interface MobilePublishPayload {
  buildId: string;
  entityId: string;
  appId: string;
  platform: 'android' | 'ios';

  app: {
    name: string;
    shortName: string;
    description: string;
    version: string;
    buildNumber: number;
  };

  /** Key paths are absolute files inside the build folder, written from the bundle. */
  android: {
    packageName: string;
    serviceJsonPath?: string;
    keystorePath?: string;
    keystoreAlias: string;
    keystorePasswordSecret: string;
    keyPasswordSecret: string;
    versionName?: string;
    versionCode?: number;
  };

  ios: {
    bundleId: string;
    teamId: string;
    keyId: string;
    issuerId: string;
    apiKeySecret?: string;
    provisionProfile?: string;
    signingCertPath?: string;
    signingCertPassword?: string;
    exportMethod?: string;
    version?: string;
    buildNumber?: number;
  };

  branding: {
    logo: string;
    icon: string;
    splash: string;
    font?: string;
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    primaryGradientStart?: string;
    primaryGradientEnd?: string;
  };

  git: {
    branch: string;
  };
}
