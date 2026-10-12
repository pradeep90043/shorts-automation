import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { audioDuration } from "./retime";

/**
 * The CodeOrCap verdict clip (assets/verdict-clips/codeorcap_verdict_bg.mp4) shows a person saying
 *   "The verdict of this video is ... out of ten. For more info, check the caption. For tech reels, follow."
 * with a ~0.6 s pause for the score. To keep ONE voice across the Short the recorded audio is replaced by the cloned voice:
 * four fixed phrases and ten numbers, generated once (assets/verdict-clips/cloned/) and placed where his lips move. Each is
 * sped up or slowed a little (0.9x-1.3x, pitch kept) to fit its window, and the clip's own audio is dropped.
 * Window times are from a Whisper pass over the recorded clip; the "wiggle" lets a phrase run a little past the end of the
 * lip movement into the silence that follows it.
 */
export const VERDICT_WINDOWS = {
  p1: { start: 0.56, window: 1.78 }, // "The verdict of this video is"
  number: { start: 2.38, window: 0.6 }, // the pause for the score
  p2: { start: 3.0, window: 0.66 }, // "out of ten."  (lips 0.50 s + wiggle)
  p3: { start: 4.3, window: 1.4 }, // "For more info, check the caption."  (1.20 s + wiggle)
  p4: { start: 6.7, window: 1.3 }, // "For tech reels, follow."  (1.10 s + wiggle)
} as const;

/** The cloned phrases are about 3.3 dB quieter than the recorded person (-19.5 vs -16.2 LUFS, measured). */
export const VERDICT_GAIN_DB = 3.3;
/** assets/verdict-clips/codeorcap_verdict_bg.mp4 is 9.54 s: the last word ends at ~7.8 s, then a short tail. The pipeline passes the real length. */
export const VERDICT_CLIP_SECONDS = 9.54;
const MIN_TEMPO = 0.9;
const MAX_TEMPO = 1.3;

export const clonedVerdictDir = (): string => path.join(config.paths.assetsDir, "verdict-clips", "cloned");
const files = (dir: string, score: number) => ({
  p1: path.join(dir, "verdict_p1.mp3"), p2: path.join(dir, "verdict_p2.mp3"), p3: path.join(dir, "verdict_p3.mp3"), p4: path.join(dir, "verdict_p4.mp3"),
  number: path.join(dir, `verdict_n${verdictNumber(score)}.mp3`),
});

export const verdictNumber = (score: number): number => Math.min(10, Math.max(1, Math.round(score)));

/** Tempo that fits a phrase of `naturalSec` into `windowSec`, kept inside 0.9x-1.3x (a short phrase is slowed down at most to 0.9x). */
export function verdictTempo(naturalSec: number, windowSec: number): number {
  if (!(naturalSec > 0) || !(windowSec > 0)) return 1;
  return Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, naturalSec / windowSec));
}

export function clonedVerdictAvailable(dir = clonedVerdictDir()): boolean {
  const f = files(dir, 5);
  return [f.p1, f.p2, f.p3, f.p4].every((x) => fs.existsSync(x)) && Array.from({ length: 10 }, (_, i) => path.join(dir, `verdict_n${i + 1}.mp3`)).every((x) => fs.existsSync(x));
}

const run = (bin: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => execFile(bin, args, { maxBuffer: 20 * 1024 * 1024 }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())));

/**
 * One wav, exactly as long as the verdict clip, with the cloned voice in place: `score` is spoken in the pause. Returns the
 * path, or null when the assets are missing or ffmpeg fails (the caller keeps the recorded audio).
 */
export async function buildClonedVerdictAudio(score: number, outPath: string, dir = clonedVerdictDir(), clipSeconds = VERDICT_CLIP_SECONDS): Promise<string | null> {
  try {
    if (!clonedVerdictAvailable(dir)) return null;
    const f = files(dir, score);
    const order = ["p1", "number", "p2", "p3", "p4"] as const;
    const inputs: string[] = [];
    const chains: string[] = [];
    for (let i = 0; i < order.length; i++) {
      const key = order[i];
      const w = VERDICT_WINDOWS[key];
      const tempo = verdictTempo(await audioDuration(f[key]), w.window);
      const delayMs = Math.round(w.start * 1000);
      inputs.push("-i", f[key]);
      chains.push(`[${i}:a]atempo=${tempo.toFixed(4)},adelay=${delayMs}|${delayMs}[a${i}]`);
    }
    const labels = order.map((_, i) => `[a${i}]`).join("");
    const graph =
      `${chains.join(";")};${labels}amix=inputs=${order.length}:duration=longest:normalize=0,` +
      `volume=${VERDICT_GAIN_DB}dB,alimiter=limit=0.9,apad=whole_dur=${clipSeconds}[out]`;
    await run(config.binaries.ffmpeg, ["-y", ...inputs, "-filter_complex", graph, "-map", "[out]", "-t", String(clipSeconds), "-ar", "44100", "-ac", "2", outPath]);
    pipelineLogger.info(`Cloned verdict audio built for score ${verdictNumber(score)}`, "ClonedVerdict");
    return outPath;
  } catch (err) {
    pipelineLogger.warn(`Cloned verdict audio failed (${err instanceof Error ? err.message : err}) -> recorded audio kept`, "ClonedVerdict");
    return null;
  }
}
