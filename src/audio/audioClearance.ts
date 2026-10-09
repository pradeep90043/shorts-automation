import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { identifyAudio } from "./shazam";
import { extractVocals } from "./vocalExtractor";

export interface ClearanceResult {
  /** The audio was fingerprinted (false when disabled, silent, or the file is missing). */
  checked: boolean;
  /** Recognisable music was found in the video's audio. */
  musicFound: boolean;
  /** Music was found and a music-free copy was written to `outputPath`. */
  removed: boolean;
  /** What Shazam matched, e.g. `"Title" by Artist`. */
  match?: string;
  /** The video to publish: the music-free copy when `removed`, otherwise the input path. */
  outputPath: string;
}

const run = (cmd: string): Promise<void> =>
  new Promise((resolve, reject) =>
    exec(cmd, { timeout: 10 * 60 * 1000, killSignal: "SIGKILL", maxBuffer: 20 * 1024 * 1024 }, (err) => (err ? reject(err) : resolve())),
  );

const hasAudio = (file: string): Promise<boolean> =>
  new Promise((resolve) =>
    exec(
      `"${config.binaries.ffprobe}" -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${file}"`,
      (err, out) => resolve(!err && out.trim().includes("audio")),
    ),
  );

/**
 * Last gate before a video is published: fingerprint its final audio and, if it still contains
 * recognisable music (an Instagram song that survived the mix, a library track, anything), strip the
 * music and keep only the speech — the AI voiceover when there is one, otherwise the vocals isolated
 * from the audio (Demucs), otherwise nothing (muted). The video stream is never re-encoded.
 *
 * Fingerprinting can only catch tracks the services know; royalty-free library tracks that are
 * registered with Content ID later are invisible here (that is what assets/music/blocklist.list is for).
 */
export async function clearBackgroundMusic(
  videoPath: string,
  outputPath: string,
  opts: { voiceoverPath?: string; tempDir: string },
): Promise<ClearanceResult> {
  const unchanged: ClearanceResult = { checked: false, musicFound: false, removed: false, outputPath: videoPath };
  if (!config.audioClearance.enabled || !fs.existsSync(videoPath) || !(await hasAudio(videoPath))) return unchanged;

  const shazam = await identifyAudio(videoPath);
  if (!shazam.matched) return { ...unchanged, checked: true };

  const match = `"${shazam.title}" by ${shazam.artist || "Unknown"}`;
  pipelineLogger.warn(`[AudioClearance] Music detected in final audio: ${match} — removing it before publish`, "AudioClearance");

  const ffmpeg = config.binaries.ffmpeg;
  const voiceover = opts.voiceoverPath && fs.existsSync(opts.voiceoverPath) ? opts.voiceoverPath : undefined;
  const speech = voiceover ?? (await extractVocals(videoPath, opts.tempDir));

  try {
    if (speech) {
      // apad + -shortest keeps the output exactly as long as the video even if the speech is shorter
      await run(
        `"${ffmpeg}" -y -i "${videoPath}" -i "${speech}" -filter_complex "[1:a]apad[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${outputPath}"`,
      );
    } else {
      pipelineLogger.warn("[AudioClearance] No speech track available (no voiceover, Demucs missing) — muting the video", "AudioClearance");
      await run(`"${ffmpeg}" -y -i "${videoPath}" -an -c:v copy "${outputPath}"`);
    }
  } catch (err) {
    // Never publish a video we know carries music: fall back to a muted copy
    pipelineLogger.error("[AudioClearance] Music removal failed — muting instead", err, "AudioClearance");
    await run(`"${ffmpeg}" -y -i "${videoPath}" -an -c:v copy "${outputPath}"`);
  }

  const removed = fs.existsSync(outputPath) && path.resolve(outputPath) !== path.resolve(videoPath);
  return { checked: true, musicFound: true, removed, match, outputPath: removed ? outputPath : videoPath };
}
