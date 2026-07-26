import path from "path";
import fs from "fs";
import dotenv from "dotenv";

// Load .env from project root (works for both local and prod env files)
const envFile = process.env.ENV_FILE || ".env";
dotenv.config({ path: path.resolve(__dirname, "../../", envFile) });

import { YouTubeService } from "../youtube";
import { config } from "../config";

async function main() {
  const videoPath = process.argv[2];
  if (!videoPath) {
    console.error("Usage: ts-node src/test/upload_manual.ts <path-to-video.mp4>");
    process.exit(1);
  }
  if (!fs.existsSync(videoPath)) {
    console.error(`File not found: ${videoPath}`);
    process.exit(1);
  }

  console.log(`\nVideo:  ${videoPath}`);
  console.log(`Size:   ${(fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`YT App: clientId=${config.youtube.clientId ? "✓" : "MISSING"}`);
  console.log(`Channels configured: ${config.youtube.channels.length}`);
  config.youtube.channels.forEach((ch) =>
    console.log(`  - ${ch.name}: refreshToken=${ch.refreshToken ? "✓" : "MISSING"}`),
  );

  if (!config.youtube.clientId || config.youtube.channels.length === 0) {
    console.error("\nYouTube credentials not loaded — check your .env file.");
    process.exit(1);
  }

  const metadata = {
    title: "Test Upload — Short Video",
    description: "Test upload from upload_manual.ts",
    tags: ["test", "shorts"],
  };

  console.log("\nStarting YouTube upload...");
  const youtube = new YouTubeService();
  const results = await youtube.uploadToAllChannels(videoPath, metadata);

  if (results.length === 0) {
    console.error("\nUpload failed — check logs above for the error.");
    process.exit(1);
  }

  console.log("\nSuccess!");
  results.forEach((r) => console.log(`  ${r.channelName}: ${r.url}`));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
