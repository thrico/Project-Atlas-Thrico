export interface MobilePublishPayload {
  buildId: string;
  jobId: string;
  entityId: string;
  appId: string;
  platform: 'android' | 'ios' | 'both';
  environment: string;

  app: {
    name: string;
    shortName: string;
    description: string;
    version: string;
    buildNumber: number;
  };

  android: {
    packageName: string;
    firebaseConfig?: string;
    keystore?: string;
    serviceJsonPath?: string;
    googleServicesJsonPath?: string;
    keystorePath?: string;
    keystoreAlias: string;
    keystorePasswordSecret: string;
    keyPasswordSecret: string;
    versionName?: string;
    versionCode?: number;
    track?: string;
    releaseStatus?: string;
  };

  ios: {
    bundleId: string;
    firebaseConfig: string;
    teamId: string;
    keyId: string;
    issuerId: string;
    apiKeySecret: string;
    provisionProfile: string;
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

  store: {
    appStoreName: string;
    playStoreName: string;
    privacyPolicy: string;
    terms: string;
  };

  git: {
    repository: string;
    branch: string;
    commit: string;
  };

  artifacts: {
    output: string;
  };

  createdBy: {
    userId: string;
    name: string;
  };
}

export interface EntityConfig {
  appName: string;
  packageName: string;
  bundleId: string;
  theme: string;
  colors: {
    primary: string;
    secondary: string;
    background: string;
  };
  version: string;
}
