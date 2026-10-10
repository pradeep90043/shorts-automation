import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import type { TTSService } from "./tts";

/**
 * The spoken score in the CodeOrCap verdict clip. The recorded person says "The verdict of this video is … out of 10":
 * he leaves a ~0.6 s pause for the number, which is filled here.
 *
 * What goes wrong with a raw TTS digit: Edge returns "Six." as 0.18 s of silence + the word + ~1.3 s of trailing silence
 * (1.87 s for one word), at default pace and much quieter than a person, and the old mix delayed it to 1.45 s, so "six"
 * landed on top of "this video". So the word is trimmed, sped up to fit the pause, peak-matched to his speech, faded, and
 * placed in the pause. A recording of your own, `assets/verdict-clips/scores/codeorcap_<n>.(wav|mp3|m4a)`, is used instead of
 * TTS when present, so the number can be in the same voice as the rest of the line.
 */
export const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export const numberWord = (score: number): string => NUMBER_WORDS[Math.min(10, Math.max(0, Math.round(score)))];

/** Peak the number is normalised to: just under the recorded person's peak (-0.8 dBFS), so it sits at his level. */
const TARGET_PEAK_DB = -3;
const MAX_TEMPO = 1.5;
/** A TTS word shorter than this is re-spoken at a slower rate. */
const MIN_WORD_SEC = 0.3;

/** atempo factor that makes a word of `naturalSec` fit `windowSec` (1 = unchanged: shorter words are not stretched). */
export function tempoToFit(naturalSec: number, windowSec: number): number {
  if (!(naturalSec > 0) || !(windowSec > 0) || naturalSec <= windowSec) return 1;
  return Math.min(MAX_TEMPO, naturalSec / windowSec);
}

/** Gain (dB) to bring a word whose peak is `peakDb` to the target peak, within +-15 dB. */
export function gainToTarget(peakDb: number, targetDb = TARGET_PEAK_DB): number {
  if (!Number.isFinite(peakDb)) return 0;
  return Math.max(-15, Math.min(15, targetDb - peakDb));
}

const run = (bin: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(`${stdout}\n${stderr}`)));
  });

async function durationOf(file: string): Promise<number> {
  const out = await run(config.binaries.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return parseFloat(out.trim());
}

async function peakDb(file: string): Promise<number> {
  const out = await run(config.binaries.ffmpeg, ["-hide_banner", "-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"]);
  const m = out.match(/max_volume:\s*(-?[\d.]+) dB/);
  return m ? parseFloat(m[1]) : NaN;
}

const TRIM = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.01";

/**
 * A short, clean audio file of the spoken score, at most `windowSec` long, at the recorded person's level.
 * Returns the file path and its duration, or null when nothing could be produced (the caller keeps the silent gap).
 */
export async function prepareScoreAudio(
  score: number,
  tempDir: string,
  tts: TTSService,
  windowSec: number,
  recordedDir: string,
): Promise<{ path: string; durationSec: number } | null> {
  try {
    const n = Math.min(10, Math.max(1, Math.round(score)));
    let source = "";
    for (const ext of ["wav", "mp3", "m4a"]) {
      const candidate = path.join(recordedDir, `codeorcap_${n}.${ext}`);
      if (fs.existsSync(candidate)) { source = candidate; break; }
    }
    const usedRecording = !!source;
    const trimmed = path.join(tempDir, "verdict_number_trim.wav");
    // 1 — trim the silence before and after the word (Edge pads ~0.2 s before and ~1.3 s after)
    const trimInto = (input: string) =>
      run(config.binaries.ffmpeg, ["-y", "-i", input, "-af", `${TRIM},areverse,${TRIM},areverse`, "-ac", "1", "-ar", "44100", trimmed]);
    if (!source) {
      source = path.join(tempDir, "verdict_number_raw.mp3");
      await tts.generateVoiceover(numberWord(n), source, "codeorcap");
    }
    await trimInto(source);
    let natural = await durationOf(trimmed);
    if (!usedRecording && natural < MIN_WORD_SEC) {
      // a one-syllable word ("ten") comes out as a ~0.2 s click: say it a little slower so it is clear
      await tts.generateVoiceover(numberWord(n), source, "codeorcap", "-25%");
      await trimInto(source);
      natural = await durationOf(trimmed);
    }
    if (!(natural > 0.05)) throw new Error(`number audio is empty (${natural}s)`);

    // 2 — fit the pause: speed a long word up (never stretch a short one), then match his level and soften the edges
    const tempo = tempoToFit(natural, windowSec);
    const fitted = natural / tempo;
    const gain = gainToTarget(await peakDb(trimmed));
    const outPath = path.join(tempDir, "verdict_number.wav");
    const filters = [
      ...(tempo > 1.001 ? [`atempo=${tempo.toFixed(3)}`] : []),
      `volume=${gain.toFixed(2)}dB`,
      "alimiter=limit=0.9",
      `afade=t=in:d=0.01`,
      `afade=t=out:st=${Math.max(0, fitted - 0.04).toFixed(3)}:d=0.04`,
    ];
    await run(config.binaries.ffmpeg, ["-y", "-i", trimmed, "-af", filters.join(","), "-ac", "1", "-ar", "44100", outPath]);
    fs.unlinkSync(trimmed);
    const durationSec = await durationOf(outPath);
    pipelineLogger.info(
      `Verdict score "${numberWord(n)}" (${usedRecording ? "recording" : "TTS"}): ${natural.toFixed(2)}s -> ${durationSec.toFixed(2)}s for a ${windowSec.toFixed(2)}s pause, ${gain >= 0 ? "+" : ""}${gain.toFixed(1)} dB`,
      "VerdictNumber",
    );
    return { path: outPath, durationSec };
  } catch (err) {
    pipelineLogger.warn(`Verdict score audio failed — leaving the pause silent: ${err instanceof Error ? err.message : err}`, "VerdictNumber");
    return null;
  }
}
