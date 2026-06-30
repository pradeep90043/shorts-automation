import fs from "fs";
import path from "path";
import sharp from "sharp";
import { exec } from "child_process";
import { config } from "../config";
import { pipelineLogger } from "./logger";

export async function ensureAssetsExist(): Promise<void> {
  const assetsDir = config.paths.assetsDir;
  const musicDir = config.paths.musicDir;
  const tempDir = config.paths.tempDir;
  const outputDir = config.paths.outputDir;

  // Create directories if they do not exist
  [assetsDir, musicDir, tempDir, outputDir].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  const logoPath = path.join(assetsDir, "logo.png");
  const watermarkPath = path.join(assetsDir, "watermark.png");

  // 1. Generate default CodeOrCap logo if missing
  if (!fs.existsSync(logoPath)) {
    pipelineLogger.info(
      "Logo not found, generating default branding logo...",
      "Assets",
    );
    try {
      // Create a premium 400x120 SVG banner logo with dark cyber-tech gradient
      const svgLogo = `
        <svg width="400" height="120" viewBox="0 0 400 120" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="cyber-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#00F0FF" />
              <stop offset="50%" stop-color="#7000FF" />
              <stop offset="100%" stop-color="#FF007B" />
            </linearGradient>
            <style>
              .logo-text { font-family: 'Courier New', Courier, monospace, sans-serif; font-weight: 900; font-size: 38px; fill: #FFFFFF; letter-spacing: 2px; }
              .sub-text { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-weight: 500; font-size: 14px; fill: #00F0FF; letter-spacing: 5px; }
              .symbol { font-family: 'Courier New', monospace; font-weight: bold; font-size: 42px; fill: url(#cyber-grad); }
            </style>
          </defs>
          <!-- Background pill -->
          <rect x="5" y="5" width="390" height="110" rx="20" fill="#0A0E17" stroke="url(#cyber-grad)" stroke-width="3" />
          <!-- Code symbol < /> -->
          <text x="35" y="72" class="symbol">&lt;/&gt;</text>
          <!-- Text -->
          <text x="140" y="58" class="logo-text">CodeOrCap</text>
          <text x="142" y="85" class="sub-text">AI GENERATED</text>
        </svg>
      `;

      await sharp(Buffer.from(svgLogo)).png().toFile(logoPath);
      pipelineLogger.checkpoint("Default logo.png generated");
    } catch (err) {
      pipelineLogger.error(
        "Failed to generate default logo.png",
        err,
        "Assets",
      );
    }
  }

  // 2. Generate default watermark.png if missing
  if (!fs.existsSync(watermarkPath)) {
    pipelineLogger.info(
      "Watermark not found, generating default watermark...",
      "Assets",
    );
    try {
      // 500x500 diagonal semi-transparent text watermark
      const svgWatermark = `
        <svg width="500" height="500" viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg">
          <style>
            .watermark { 
              font-family: 'Helvetica Neue', Arial, sans-serif; 
              font-size: 40px; 
              font-weight: 900;
              fill: rgba(255, 255, 255, 0.07); 
              text-anchor: middle;
            }
          </style>
          <g transform="rotate(-35 250 250)">
            <text x="250" y="230" class="watermark">CODE OR CAP</text>
            <text x="250" y="280" class="watermark">@CodeOrCap</text>
          </g>
        </svg>
      `;

      await sharp(Buffer.from(svgWatermark)).png().toFile(watermarkPath);
      pipelineLogger.checkpoint("Default watermark.png generated");
    } catch (err) {
      pipelineLogger.error(
        "Failed to generate default watermark.png",
        err,
        "Assets",
      );
    }
  }

  // 3. Generate default background audio if music folder is empty
  const musicFiles = fs.readdirSync(musicDir).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return [".mp3", ".wav", ".m4a", ".aac", ".ogg"].includes(ext);
  });

  if (musicFiles.length === 0) {
    const defaultMusicPath = path.join(musicDir, "ambient_synth.aac");
    pipelineLogger.info(
      `No music tracks found in ${musicDir}. Synthesizing default ambient track via FFmpeg...`,
      "Assets",
    );

    // Command to generate 20 seconds of synth-like wave sound using lavfi filter (sine sweep/beeps with reverb effects)
    // -f lavfi -i "sine=frequency=220:beep_factor=4:duration=20" -af "apulsator=hz=0.25,aecho=0.8:0.88:60:0.4"
    const cmd = `ffmpeg -y -f lavfi -i "sine=frequency=350:duration=20" -af "apulsator=hz=1.5,aecho=0.8:0.88:200:0.4,volume=0.9" -c:a aac -b:a 128k "${defaultMusicPath}"`;

    await new Promise<void>((resolve, reject) => {
      exec(cmd, (error, _stdout, stderr) => {
        if (error) {
          pipelineLogger.error(
            `Failed to synthesize default music: ${stderr}`,
            error,
            "Assets",
          );
          // If FFmpeg synth fails, create a silent track as absolute fallback
          const silentCmd = `ffmpeg -y -f lavfi -i "anullsrc=r=44100:cl=stereo" -t 20 -c:a aac -b:a 64k "${defaultMusicPath}"`;
          exec(silentCmd, (silentError, _, silentStderr) => {
            if (silentError) {
              pipelineLogger.error(
                `Failed to create silent fallback audio: ${silentStderr}`,
                silentError,
                "Assets",
              );
              reject(silentError);
            } else {
              pipelineLogger.checkpoint("Default silent audio synthesized");
              resolve();
            }
          });
        } else {
          pipelineLogger.checkpoint("Default ambient_synth.aac synthesized");
          resolve();
        }
      });
    }).catch((err) => {
      pipelineLogger.warn(
        `Audio generation bypassed: ${err.message}. Please place an audio file in '${musicDir}'`,
      );
    });
  }
}
