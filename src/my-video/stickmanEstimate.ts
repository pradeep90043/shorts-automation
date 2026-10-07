import fs from "fs";
import path from "path";
import { config } from "../config";
import { cleanScript, countWords, splitScriptIntoBeats, targetWordsFor, WORDS_PER_SEC } from "./stickmanPlanner";

const FPS = 30;
const MIN_RATE_PCT = -20;
const MAX_RATE_PCT = 30;
const DEFAULT_RATE_PCT = 5;

export type StageKey = "plan" | "audio" | "merge" | "bundle" | "render" | "finalize";
export const STAGE_ORDER: StageKey[] = ["plan", "audio", "merge", "bundle", "render", "finalize"];
export const STAGE_LABELS: Record<StageKey, string> = {
  plan: "Planning scenes",
  audio: "Generating voiceover",
  merge: "Mixing audio",
  bundle: "Preparing renderer",
  render: "Rendering frames",
  finalize: "Branding & quality check",
};

export interface Timings {
  /** seconds of wall-clock per rendered frame (measured, per orientation) */
  secPerFrame: number;
  /** seconds per scene for text-to-speech */
  secPerScene: number;
  /** fixed seconds to bundle the Remotion project */
  bundleSec: number;
}

// Priors for a small shared-CPU VM; replaced by measured values once videos have been made.
const PRIORS: Timings = { secPerFrame: 0.35, secPerScene: 2.5, bundleSec: 25 };

interface HistoryEntry extends Timings {
  at: string;
}

const historyFile = () => path.join(config.paths.dataDir, "stickman-history.json");

function readHistory(): HistoryEntry[] {
  try {
    return JSON.parse(fs.readFileSync(historyFile(), "utf8"));
  } catch {
    return [];
  }
}

export function recordTimings(t: Timings): void {
  try {
    fs.mkdirSync(config.paths.dataDir, { recursive: true });
    const next = [...readHistory(), { ...t, at: new Date().toISOString() }].slice(-10);
    fs.writeFileSync(historyFile(), JSON.stringify(next, null, 2));
  } catch {
    /* estimates just stay on the priors */
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function currentTimings(): { timings: Timings; samples: number } {
  const h = readHistory();
  if (!h.length) return { timings: PRIORS, samples: 0 };
  return {
    samples: h.length,
    timings: {
      secPerFrame: median(h.map((e) => e.secPerFrame)),
      secPerScene: median(h.map((e) => e.secPerScene)),
      bundleSec: median(h.map((e) => e.bundleSec)),
    },
  };
}

export interface StickmanEstimate {
  words: number;
  scenes: number;
  /** length of the finished video */
  videoSec: number;
  /** requested length, if any */
  targetSec?: number;
  /** TTS rate (e.g. "+12%") chosen so the narration lands on the requested length */
  rate: string;
  /** set when the script will be rewritten to fit the target: the word count it will be fitted to */
  fitToWords?: number;
  /** set when the target can't be reached even with a rewrite */
  note?: string;
  stageSec: Record<StageKey, number>;
  totalSec: number;
  basedOnSamples: number;
}

/**
 * `fitted` = the script has already been rewritten to the target (inside a job),
 * so don't plan another rewrite.
 */
export function estimateStickman(script: string, targetSec?: number, resolution: 720 | 1080 = 720, fitted = false): StickmanEstimate {
  script = cleanScript(script);
  const beats = splitScriptIntoBeats(script);
  const words = countWords(script);
  const scenes = beats.length;
  const pauseSec = scenes * 0.35;
  const naturalSec = words / WORDS_PER_SEC + pauseSec;

  let ratePct = DEFAULT_RATE_PCT;
  let note: string | undefined;
  let fitToWords: number | undefined;
  let videoSec = naturalSec;
  if (targetSec && targetSec > 0 && words > 0) {
    const goal = targetWordsFor(targetSec);
    if (!fitted && Math.abs(words - goal) > goal * 0.1) {
      // the script gets rewritten to the target before rendering: plan for that
      fitToWords = goal;
      videoSec = targetSec;
    } else {
      // fine-tune with the TTS rate so the narration lands on the target
      const neededSpeed = (words / WORDS_PER_SEC) / Math.max(1, targetSec - pauseSec); // relative to the default rate
      ratePct = Math.min(MAX_RATE_PCT, Math.max(MIN_RATE_PCT, Math.round((neededSpeed * (1 + DEFAULT_RATE_PCT / 100) - 1) * 100)));
      const speed = (1 + ratePct / 100) / (1 + DEFAULT_RATE_PCT / 100);
      videoSec = (words / WORDS_PER_SEC) / speed + pauseSec;
      if (Math.abs(videoSec - targetSec) > targetSec * 0.12) note = `Video will run about ${fmt(videoSec)} instead of ${fmt(targetSec)}.`;
    }
  }

  const { timings, samples } = currentTimings();
  const frames = Math.round(videoSec * FPS);
  // 1080 renders ~2.2x the pixels of 720
  const resFactor = resolution === 1080 ? 2.2 : 1;
  const stageSec: Record<StageKey, number> = {
    plan: fitToWords ? 25 : 10, // a script rewrite adds an LLM round trip
    audio: scenes * timings.secPerScene,
    merge: 3 + videoSec * 0.05,
    bundle: timings.bundleSec,
    render: frames * timings.secPerFrame * resFactor,
    finalize: 5 + videoSec * 0.3,
  };
  const totalSec = Object.values(stageSec).reduce((a, b) => a + b, 0);
  return {
    words,
    scenes,
    videoSec,
    targetSec,
    rate: `${ratePct >= 0 ? "+" : ""}${ratePct}%`,
    fitToWords,
    note,
    stageSec,
    totalSec,
    basedOnSamples: samples,
  };
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}
