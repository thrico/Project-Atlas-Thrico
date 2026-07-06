"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadArtifacts = uploadArtifacts;
exports.cleanupBuild = cleanupBuild;
const shelljs_1 = __importDefault(require("shelljs"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function uploadArtifacts(workDir, buildId) {
    return __awaiter(this, void 0, void 0, function* () {
        console.log("Step 12: Uploading Artifacts");
        // Move artifacts to a persistent directory for POC
        const artifactsDir = path_1.default.join(process.cwd(), "artifacts", buildId);
        shelljs_1.default.mkdir("-p", artifactsDir);
        // The APK is typically output to this location after assembleRelease
        const apkPath = path_1.default.join(workDir, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
        if (fs_1.default.existsSync(apkPath)) {
            shelljs_1.default.cp(apkPath, artifactsDir);
            console.log(`Copied APK to ${artifactsDir}`);
        }
        else {
            console.warn("Could not find generated APK at", apkPath);
        }
        if (fs_1.default.existsSync(path_1.default.join(workDir, "Application.ipa"))) {
            shelljs_1.default.cp(path_1.default.join(workDir, "Application.ipa"), artifactsDir);
            console.log(`Copied IPA to ${artifactsDir}`);
        }
        console.log(`Artifacts uploaded to ${artifactsDir}`);
    });
}
function cleanupBuild(workDir) {
    console.log("Step 13: Cleanup");
    shelljs_1.default.rm("-rf", workDir);
}



