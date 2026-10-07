import fs from "fs";
import path from "path";
import { config } from "../config";
import { countWords, splitScriptIntoBeats } from "./stickmanPlanner";

/** Edge-TTS Hindi/Hinglish speaks ~2.4 words/s at the default +5% rate. */
const WORDS_PER_SEC = 2.4;
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
  /** set when the script can't reach the requested length within a natural speaking speed */
  note?: string;
  stageSec: Record<StageKey, number>;
  totalSec: number;
  basedOnSamples: number;
}

export function estimateStickman(script: string, targetSec?: number, resolution: 720 | 1080 = 720): StickmanEstimate {
  const beats = splitScriptIntoBeats(script);
  const words = countWords(script);
  const scenes = beats.length;
  const pauseSec = scenes * 0.35;
  const naturalSec = words / WORDS_PER_SEC + pauseSec;

  let ratePct = DEFAULT_RATE_PCT;
  let note: string | undefined;
  let videoSec = naturalSec;
  if (targetSec && targetSec > 0 && words > 0) {
    // speaking time scales ~1/(1+rate): solve for the rate that hits the target
    const neededSpeed = (words / WORDS_PER_SEC) / Math.max(1, targetSec - pauseSec); // relative to the default rate
    const wanted = Math.round((neededSpeed * (1 + DEFAULT_RATE_PCT / 100) - 1) * 100);
    ratePct = Math.min(MAX_RATE_PCT, Math.max(MIN_RATE_PCT, wanted));
    const speed = (1 + ratePct / 100) / (1 + DEFAULT_RATE_PCT / 100);
    videoSec = (words / WORDS_PER_SEC) / speed + pauseSec;
    if (Math.abs(videoSec - targetSec) > targetSec * 0.12) {
      note = videoSec > targetSec
        ? `Script is too long for ${fmt(targetSec)} - it will run about ${fmt(videoSec)}. Trim ~${Math.ceil((videoSec - targetSec) * WORDS_PER_SEC)} words to hit the target.`
        : `Script is short for ${fmt(targetSec)} - it will run about ${fmt(videoSec)}. Add ~${Math.ceil((targetSec - videoSec) * WORDS_PER_SEC)} words to fill the target.`;
    }
  }

  const { timings, samples } = currentTimings();
  const frames = Math.round(videoSec * FPS);
  // 1080 renders ~2.2x the pixels of 720
  const resFactor = resolution === 1080 ? 2.2 : 1;
  const stageSec: Record<StageKey, number> = {
    plan: 8,
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
