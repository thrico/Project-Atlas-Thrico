import sharp from "sharp";
import fs from "fs";
import path from "path";

export class AssetGenerator {
  static async generateIcons(sourceImage: string, outputDir: string) {
    if (!fs.existsSync(sourceImage)) {
      throw new Error(`Source image not found: ${sourceImage}`);
    }

    const androidResDir = path.join(
      outputDir,
      "android",
      "app",
      "src",
      "main",
      "res",
    );
    const iosAssetsDir = path.join(
      outputDir,
      "ios",
      "Thrico",
      "Images.xcassets",
      "AppIcon.appiconset",
    );

    // Make sure output directories exist (in a real scenario they'd be part of the cloned repo)
    if (!fs.existsSync(androidResDir)) {
      fs.mkdirSync(androidResDir, { recursive: true });
    }
    if (!fs.existsSync(iosAssetsDir)) {
      fs.mkdirSync(iosAssetsDir, { recursive: true });
    }

    // Android: generate legacy and adaptive foreground icons
    const androidSizes = [
      { name: "mipmap-mdpi", size: 48, foregroundSize: 108 },
      { name: "mipmap-hdpi", size: 72, foregroundSize: 162 },
      { name: "mipmap-xhdpi", size: 96, foregroundSize: 216 },
      { name: "mipmap-xxhdpi", size: 144, foregroundSize: 324 },
      { name: "mipmap-xxxhdpi", size: 192, foregroundSize: 432 },
    ];

    for (const size of androidSizes) {
      const dir = path.join(androidResDir, size.name);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await sharp(sourceImage)
        .resize(size.size, size.size)
        .toFile(path.join(dir, "ic_launcher.png"));
      await sharp(sourceImage)
        .resize(size.size, size.size)
        .toFile(path.join(dir, "ic_launcher_round.png"));
      await sharp(sourceImage)
        .resize(size.foregroundSize, size.foregroundSize)
        .toFile(path.join(dir, "ic_launcher_foreground.png"));
    }

    // iOS: generate AppIcon sizes and Contents.json
    const iosSizes = [
      { size: 20, scale: 1, idiom: "ipad" },
      { size: 20, scale: 2, idiom: "iphone" },
      { size: 20, scale: 3, idiom: "iphone" },
      { size: 29, scale: 1, idiom: "ipad" },
      { size: 29, scale: 2, idiom: "iphone" },
      { size: 29, scale: 3, idiom: "iphone" },
      { size: 40, scale: 1, idiom: "ipad" },
      { size: 40, scale: 2, idiom: "iphone" },
      { size: 40, scale: 3, idiom: "iphone" },
      { size: 60, scale: 2, idiom: "iphone" },
      { size: 60, scale: 3, idiom: "iphone" },
      { size: 76, scale: 1, idiom: "ipad" },
      { size: 76, scale: 2, idiom: "ipad" },
      { size: 83.5, scale: 2, idiom: "ipad" },
      { size: 1024, scale: 1, idiom: "ios-marketing" },
    ];

    const contentsJson = {
      images: [] as any[],
      info: { version: 1, author: "xcode" },
    };

    for (const s of iosSizes) {
      const actualSize = Math.round(s.size * s.scale);
      // Use 'appstore.png' specifically for the 1024x1024 marketing icon to overwrite the existing one
      const filename =
        s.idiom === "ios-marketing"
          ? "appstore.png"
          : `Icon-${s.size}@${s.scale}x.png`;

      // iOS icons cannot have alpha channels (especially the 1024 App Store icon)
      await sharp(sourceImage)
        .resize(actualSize, actualSize)
        .removeAlpha()
        .toFile(path.join(iosAssetsDir, filename));

      contentsJson.images.push({
        size: `${s.size}x${s.size}`,
        idiom: s.idiom,
        filename: filename,
        scale: `${s.scale}x`,
      });
    }

    fs.writeFileSync(
      path.join(iosAssetsDir, "Contents.json"),
      JSON.stringify(contentsJson, null, 2),
    );

    console.log(`Assets generated successfully in ${outputDir}`);
  }

  static async generateSplash(sourceImage: string, outputDir: string) {
    if (!fs.existsSync(sourceImage)) {
      throw new Error(`Splash source image not found: ${sourceImage}`);
    }

    const androidResDir = path.join(
      outputDir,
      "android",
      "app",
      "src",
      "main",
      "res",
    );
    const iosAssetsDir = path.join(
      outputDir,
      "ios",
      "Thrico",
      "Images.xcassets",
      "SplashIcon.imageset",
    );

    if (!fs.existsSync(androidResDir)) {
      fs.mkdirSync(androidResDir, { recursive: true });
    }
    if (!fs.existsSync(iosAssetsDir)) {
      fs.mkdirSync(iosAssetsDir, { recursive: true });
    }

    // Android: generate splash images in drawable-*
    const androidSplashSizes = [
      { name: "drawable-mdpi", width: 480, height: 800 },
      { name: "drawable-hdpi", width: 720, height: 1280 },
      { name: "drawable-xhdpi", width: 960, height: 1600 },
      { name: "drawable-xxhdpi", width: 1440, height: 2560 },
      { name: "drawable-xxxhdpi", width: 1920, height: 3200 },
    ];

    for (const size of androidSplashSizes) {
      const dir = path.join(androidResDir, size.name);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await sharp(sourceImage)
        .resize(size.width, size.height, { fit: "cover" })
        .toFile(path.join(dir, "splashscreen_image.png"));
    }

    // iOS: generate SplashIcon sizes and Contents.json
    const iosSplashSizes = [
      { width: 414, height: 896, scale: 1, filename: "splash@1x.png" }, // 1x
      { width: 828, height: 1792, scale: 2, filename: "splash@2x.png" }, // 2x
      { width: 1242, height: 2688, scale: 3, filename: "splash@3x.png" }, // 3x
    ];

    const contentsJson = {
      images: [] as any[],
      info: { version: 1, author: "xcode" },
    };

    for (const s of iosSplashSizes) {
      await sharp(sourceImage)
        .resize(s.width, s.height, { fit: "cover" })
        .toFile(path.join(iosAssetsDir, s.filename));

      contentsJson.images.push({
        idiom: "universal",
        filename: s.filename,
        scale: `${s.scale}x`,
      });
    }

    fs.writeFileSync(
      path.join(iosAssetsDir, "Contents.json"),
      JSON.stringify(contentsJson, null, 2),
    );

    console.log(`Splash screens generated successfully in ${outputDir}`);
  }
}
