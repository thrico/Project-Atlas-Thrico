import amqp from "amqplib";
import dotenv from "dotenv";

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
      name: "The shepherd Tribe",
      shortName: "the-shepherd-tribe",
      description: "Official the-shepherd-tribe App",
      version: "1.2.0",
      buildNumber: 12
    },

    android: {
      packageName: "com.the-shepherd-tribe.community",
      firebaseConfig: "s3://mobile/firebase/google-services.json",
      keystore: "s3://mobile/keystore/release.keystore",
      keystoreAlias: "release",
      keystorePasswordSecret: "secret/android-keystore-password",
      keyPasswordSecret: "secret/android-key-password"
    },

    ios: {
      bundleId: "com.the-shepherd-tribe.community",
      firebaseConfig: "s3://mobile/firebase/GoogleService-Info.plist",
      teamId: "ABCDE12345",
      keyId: "XYZ123456",
      issuerId: "550e8400-e29b-41d4-a716-446655440000",
      apiKeySecret: "secret/apple-api-key",
      provisionProfile: "AppStore_Profile.mobileprovision"
    },

    branding: {
      logo: "https://cdn.thrico.network/8b9ee2d3-4e92-4fa5-a84d-887bbbef0dd6/general/2b20d3c1-1188-4453-8e80-8ef2bca2455b/20260601-70fw1.webp",
      icon: "https://cdn.thrico.network/8b9ee2d3-4e92-4fa5-a84d-887bbbef0dd6/general/2b20d3c1-1188-4453-8e80-8ef2bca2455b/20260601-70fw1.webp",
      splash: "https://thrico-storage.s3.ap-south-1.amazonaws.com/android-splash.png",
      primaryColor: "#0055FF",
      secondaryColor: "#FFFFFF",
      accentColor: "#FFB800"
    },

    store: {
      appStoreName: "The shepherd Tribe",
      playStoreName: "The shepherd Tribe",
      privacyPolicy: "https://theshepherdtribe.in/privacy",
      terms: "https://theshepherdtribe.in/terms"
    },

    git: {
      repository: "git@github.com:thrico/mobile.git",
      branch: "main",
      commit: "latest"
    },

    artifacts: {
      output: `s3://mobile-builds/BUILD-${Date.now()}/`
    },

    createdBy: {
      userId: "USR-100",
      name: "Pankaj Verma"
    }
  };

  channel.sendToQueue(queueName, Buffer.from(JSON.stringify(payload)));
  console.log("Sent mock mobile.publish event:", payload);

  setTimeout(() => {
    connection.close();
    process.exit(0);
  }, 500);
}

testPublish().catch(console.error);
