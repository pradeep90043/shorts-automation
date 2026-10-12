import { execFile, execFileSync } from "child_process";
import os from "os";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";

export interface ShazamResult {
  matched: boolean;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  shazam_url?: string;
  isrc?: string;
  cover_art?: string;
  error?: string;
  message?: string;
}

const PYTHON3 = config.binaries.python3 || "python3";
const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/shazam_identify.py");

/**
 * Identify songs and audio tracks from an audio or video file using Shazam.
 *
 * @param filePath Path to the audio or video file
 * @returns ShazamResult with title, artist, genre, and Shazam URL when identified
 */
export async function identifyAudio(filePath: string): Promise<ShazamResult> {
  if (!fs.existsSync(filePath)) {
    return { matched: false, error: `File not found: ${filePath}` };
  }

  pipelineLogger.info(
    `[Shazam] Running audio identification on ${path.basename(filePath)}...`,
    "Shazam",
  );

  // Video/odd containers made the Shazam decoder log "invalid mpeg audio header" and fail: hand it a clean 20s mono WAV.
  let target = filePath;
  let tmpWav: string | undefined;
  try {
    tmpWav = path.join(os.tmpdir(), `shazam-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    execFileSync(config.binaries.ffmpeg, ["-y", "-loglevel", "error", "-i", filePath, "-vn", "-t", "20", "-ac", "1", "-ar", "16000", tmpWav], { timeout: 30000 });
    if (fs.existsSync(tmpWav) && fs.statSync(tmpWav).size > 1000) target = tmpWav;
  } catch {
    /* no audio stream or ffmpeg failure: fall back to the original file */
  }

  return new Promise((resolve) => {
    execFile(
      PYTHON3,
      [SCRIPT_PATH, target],
      { timeout: 25000, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (tmpWav) fs.rmSync(tmpWav, { force: true });
        if (error) {
          const errMsg = stderr.trim() || error.message;
          pipelineLogger.warn(
            `[Shazam] Identification failed for ${path.basename(filePath)}: ${errMsg.slice(0, 200)}`,
            "Shazam",
          );
          return resolve({ matched: false, error: errMsg });
        }

        try {
          const trimmed = stdout.trim();
          const parsed = JSON.parse(trimmed) as ShazamResult;
          if (parsed.matched) {
            pipelineLogger.info(
              `[Shazam] ✓ Matched: "${parsed.title}" by ${parsed.artist || "Unknown"} [${parsed.genre || "Music"}] (${parsed.shazam_url || ""})`,
              "Shazam",
            );
          } else {
            pipelineLogger.info(
              `[Shazam] No commercial match found for ${path.basename(filePath)} (likely royalty-free or original audio)`,
              "Shazam",
            );
          }
          resolve(parsed);
        } catch (jsonErr) {
          pipelineLogger.warn(
            `[Shazam] Failed to parse response: ${stdout.slice(0, 150)}`,
            "Shazam",
          );
          resolve({ matched: false, error: "Invalid response from Shazam CLI" });
        }
      },
    );
  });
}
