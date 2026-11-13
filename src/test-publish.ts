import amqp from "amqplib";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

async function testPublish() {
  const rabbitMqUrl = process.env.RABBITMQ_URL || "amqp://localhost";
  const connection = await amqp.connect(rabbitMqUrl);
  const channel = await connection.createChannel();
  const queueName = "mobile.publish";

  await channel.assertQueue(queueName, { durable: true });

  const payload = {
    buildId: `BUILD-${Date.now()}`,
    jobId: "JOB-001",
    entityId: "ENT-1001",
    appId: "APP-1001",
    platform: "both",
    environment: "production",

    app: {
      name: "Thrico Social",
      shortName: "Thrico Social",
      description: "Official Thrico Social App",
      version: "1.2.0",
      buildNumber: 12,
    },

    android: {
      packageName: "com.thricosocial.thricosocial",
      serviceJsonPath: "f5827d97-eedf-4b89-b5be-535ca09d5854/mobile_app/secure-ja7jq-thrico-4e091-a29e53b7d58c.json",
      googleServicesJsonPath: "f5827d97-eedf-4b89-b5be-535ca09d5854/mobile_app/secure-mbyc7-google-services__4_.json",
      keystorePath: "f5827d97-eedf-4b89-b5be-535ca09d5854/mobile_app/secure-hwrqz-thricosocial-release.keystore",
      keystoreAlias: "thricosocial",
      keystorePasswordSecret: process.env.TEST_KEYSTORE_PASSWORD ?? "",
      keyPasswordSecret: process.env.TEST_KEY_PASSWORD ?? "",
      versionName: "1.2.11",
      versionCode: 21,
      track: "production",
      releaseStatus: "draft",
    },

    ios: {
      bundleId: "com.thricosocial.thricosocial",
      firebaseConfig: path.join(__dirname, "ios-cert", "GoogleService-Info.plist"),
      teamId: "ZQHJSX736B",
      keyId: "2X5A72PNTG",
      issuerId: "bbb982a2-0b05-4f70-9d43-d40b3f72858d",
      apiKeySecret: path.join(__dirname, "ios-cert", "AuthKey_2X5A72PNTG.p8"),
      provisionProfile: path.join(__dirname, "ios-cert", "ThricoSocial_App_Store_Profile.mobileprovision"),
      signingCertPath: path.join(__dirname, "ios-cert", "distribution.p12"),
      signingCertPassword: process.env.TEST_P12_PASSWORD ?? "",
      exportMethod: "app-store",
      version: "1.2.10",
      buildNumber: 20,
    },

    branding: {
      logo: "https://pulseplaydigital.sgp1.digitaloceanspaces.com/20260721-57azx-chatgpt-image-jul-21--2026--01-53-13-pm",
      icon: "https://pulseplaydigital.sgp1.digitaloceanspaces.com/20260721-57azx-chatgpt-image-jul-21--2026--01-53-13-pm",
      splash:
        "https://pulseplaydigital.sgp1.digitaloceanspaces.com/20260721-omri5-ios",
      font: "@expo-google-fonts/geist",
      primaryColor: "#00FFA4",
      secondaryColor: "#4AAFF7",
      accentColor: "#FF0055",
      primaryGradientStart: "#00FFA4",
      primaryGradientEnd: "#4AAFF7",
    },

    store: {
      appStoreName: "The shepherd Tribe",
      playStoreName: "The shepherd Tribe",
      privacyPolicy: "https://theshepherdtribe.in/privacy",
      terms: "https://theshepherdtribe.in/terms",
    },

    git: {
      repository: "git@github.com:thrico/mobile.git",
      branch: "develop",
      commit: "latest",
    },

    artifacts: {
      output: `s3://mobile-builds/BUILD-${Date.now()}/`,
    },

    createdBy: {
      userId: "USR-100",
      name: "Pankaj Verma",
    },
  };

  channel.sendToQueue(queueName, Buffer.from(JSON.stringify(payload)));
  console.log("Sent mock mobile.publish event:", payload);

  setTimeout(() => {
    connection.close();
    process.exit(0);
  }, 500);
}

testPublish().catch((error) => {
  console.error("Error occurred while publishing:", error);
  process.exit(1);
});
