import { FreeLlmApiClient } from "../ai/freellmapi";
import { GeminiClient } from "../ai/gemini";
import { config } from "../config";
import { parseAiJson } from "../utils/json";
import { pipelineLogger } from "../utils/logger";
import type { StickmanScene } from "./myVideoService";

// Mirrors my-video/src/stickman/schema.ts (that repo is not importable from here).
const POSES = ["idle", "point", "present", "shrug", "think", "celebrate", "worried", "facepalm", "shocked", "walk", "angry", "laugh", "cry", "smug"];
const MOODS = ["neutral", "happy", "worried", "shocked", "sad", "angry", "excited", "confused", "smug", "crying"];
const PROPS = ["laptop", "bulb", "chartUp", "chartDown", "warning", "clock", "money", "robot", "question", "check", "cross", "rocket", "lock", "gear", "magnifier", "bug", "code"];
const ACCENTS = ["red", "blue", "gold", "green"];
const CAMERAS = ["none", "push", "pull", "pan-left", "pan-right"];

/** ~14 words is about 5-6 s of narration: short beats keep the visuals changing. */
const MAX_WORDS_PER_SCENE = 16;
const MIN_WORDS_PER_SCENE = 5;

export const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Strips what must never be spoken: markdown, quote marks and timing/section
 * labels such as "**Hook — 0–5 sec**" that script writers paste in.
 */
export function cleanScript(script: string): string {
  return script
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => {
      const t = line.replace(/[*#_`>]/g, "").trim();
      if (!t) return true;
      const isTimeLabel = /\b\d+(?:[:.]\d+)?\s*[–—-]\s*\d+(?:[:.]\d+)?\s*(?:sec|secs|seconds|s|min)\b/i.test(t);
      return !(isTimeLabel && countWords(t) <= 8);
    })
    .join("\n")
    .replace(/[*#_`]+/g, "")
    .replace(/[“”"]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Splits a script into narration beats without rewriting a single word. */
export function splitScriptIntoBeats(script: string): string[] {
  const sentences = script
    .replace(/\r/g, "")
    .split(/(?<=[.!?।…])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // break over-long sentences at commas/dashes, then at word count
  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (countWords(sentence) <= MAX_WORDS_PER_SCENE) {
      pieces.push(sentence);
      continue;
    }
    let current = "";
    for (const part of sentence.split(/(?<=[,;:—–-])\s+/)) {
      if (current && countWords(`${current} ${part}`) > MAX_WORDS_PER_SCENE) {
        pieces.push(current);
        current = part;
      } else {
        current = current ? `${current} ${part}` : part;
      }
    }
    if (current) pieces.push(current);
  }

  // glue very short pieces onto their neighbour
  const beats: string[] = [];
  for (const piece of pieces) {
    const last = beats[beats.length - 1];
    if (last && (countWords(last) < MIN_WORDS_PER_SCENE || countWords(piece) < MIN_WORDS_PER_SCENE) &&
        countWords(`${last} ${piece}`) <= MAX_WORDS_PER_SCENE + 4) {
      beats[beats.length - 1] = `${last} ${piece}`;
    } else {
      beats.push(piece);
    }
  }
  return beats;
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** Keeps only values my-video's schema accepts, so a sloppy LLM answer can't fail the render. */
export function sanitizeVisual(raw: any, index: number): Record<string, unknown> {
  const v = raw && typeof raw === "object" ? raw : {};
  const visual: Record<string, unknown> = {
    pose: pick(v.pose, POSES, POSES[index % POSES.length]),
    mood: pick(v.mood, MOODS, "neutral"),
    accent: pick(v.accent, ACCENTS, ACCENTS[Math.floor(index / 3) % ACCENTS.length]),
    camera: pick(v.camera, CAMERAS, index % 4 === 0 ? "push" : "none"),
    transition: index > 0 && index % 5 === 0 ? "wipe" : "cut",
  };
  if (typeof v.title === "string" && v.title.trim()) visual.title = v.title.trim().slice(0, 60);
  if (typeof v.chapter === "string" && v.chapter.trim()) visual.chapter = v.chapter.trim().slice(0, 40);
  if (Array.isArray(v.callouts)) {
    visual.callouts = v.callouts.filter((c: unknown) => typeof c === "string" && c.trim()).slice(0, 3).map((c: string) => c.trim().slice(0, 48));
  }
  if (Array.isArray(v.props)) {
    visual.props = v.props
      .filter((p: any) => p && (PROPS as string[]).includes(p.type))
      .slice(0, 2)
      .map((p: any, i: number) => ({ type: p.type, x: i === 0 ? 0.72 : 0.88, delay: 8 + i * 8 }));
  }
  return visual;
}

/** Edge-TTS Hindi/Hinglish speaks about this many words per second at the default rate. */
export const WORDS_PER_SEC = 2.4;
/** Share of the target length left for narration (the rest is pauses between scenes). */
const SPEECH_SHARE = 0.93;
const FIT_TOLERANCE = 0.1;

export const targetWordsFor = (targetSec: number): number => Math.round(targetSec * WORDS_PER_SEC * SPEECH_SHARE);

export interface FitResult {
  script: string;
  adjusted: boolean;
  fromWords: number;
  toWords: number;
  /** why nothing changed, or how it was adjusted */
  note: string;
}

/**
 * Rewrites the script so its narration fits the requested length: expands a
 * short script, condenses a long one. Falls back to the original (the TTS rate
 * is then tuned instead) if the LLM is unavailable or misses the target.
 */
export async function fitScriptToDuration(script: string, targetSec?: number): Promise<FitResult> {
  const fromWords = countWords(script);
  if (!targetSec || targetSec <= 0 || !fromWords) {
    return { script, adjusted: false, fromWords, toWords: fromWords, note: "No target length" };
  }
  const goal = targetWordsFor(targetSec);
  if (Math.abs(fromWords - goal) <= goal * FIT_TOLERANCE) {
    return { script, adjusted: false, fromWords, toWords: fromWords, note: "Script already fits the target length" };
  }

  const direction = fromWords > goal ? "shorten" : "expand";
  let best: { text: string; words: number } | null = null;
  let feedback = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = `You are a script editor for a spoken stickman explainer video.
Rewrite the narration below to ${direction} it to about ${goal} words (it must be spoken in about ${Math.round(targetSec)} seconds).

Rules:
- Keep the same language and tone (if it is Hinglish, stay in Hinglish with the same romanised spelling style).
- Keep the hook at the start and the closing line/call-to-action at the end.
- ${direction === "shorten" ? "Cut repetition and minor details, keep every key point." : "Add concrete examples, a relatable analogy and a short recap - no filler, no repetition."}
- Plain spoken sentences only: no markdown, no headings, no timestamps, no stage directions, no emojis, no quotation marks.
- Output ONLY the final narration text.${feedback}

Narration:
${script}`;

    let raw = "";
    try {
      raw = await askLlm(prompt);
    } catch {
      break;
    }
    const text = cleanScript(raw.replace(/^```[a-z]*\n?|```$/gim, "").trim());
    const words = countWords(text);
    if (!words) break;
    if (!best || Math.abs(words - goal) < Math.abs(best.words - goal)) best = { text, words };
    if (Math.abs(words - goal) <= goal * FIT_TOLERANCE) break;
    feedback = `\n- IMPORTANT: your last attempt had ${words} words; the target is ${goal} words (+/-10%). Count carefully.`;
  }

  const improved = best && Math.abs(best.words - goal) < Math.abs(fromWords - goal);
  if (best && improved) {
    return { script: best.text, adjusted: true, fromWords, toWords: best.words, note: `Script ${direction === "shorten" ? "shortened" : "expanded"} from ${fromWords} to ${best.words} words to fit ${Math.round(targetSec)}s` };
  }
  return { script, adjusted: false, fromWords, toWords: fromWords, note: "Could not rewrite the script (AI unavailable); voice speed is adjusted instead" };
}

export interface StickmanPlan {
  title: string;
  description: string;
  tags: string[];
  scenes: StickmanScene[];
  /** false when the LLM was unavailable and visuals were assigned by rule */
  aiVisuals: boolean;
}

async function askLlm(prompt: string): Promise<string> {
  if (config.ai.provider === "freellmapi" || process.env.FREELLMAPI_KEY) {
    try {
      return await new FreeLlmApiClient().generateText(prompt);
    } catch (err: any) {
      pipelineLogger.warn(`FreeLLMAPI failed for stickman plan: ${err.message}`, "StickmanPlanner");
    }
  }
  if (process.env.GEMINI_API_KEY) {
    try {
      return await new GeminiClient().generateText(prompt);
    } catch (err: any) {
      pipelineLogger.warn(`Gemini failed for stickman plan: ${err.message}`, "StickmanPlanner");
    }
  }
  return "";
}

/**
 * Turns the user's script into stickman scenes. The narration is split
 * deterministically (the script is never rewritten); the LLM only picks the
 * visuals (pose, mood, props, on-screen title) and the YouTube metadata.
 */
export async function planStickmanVideo(script: string, titleHint?: string): Promise<StickmanPlan> {
  script = cleanScript(script);
  const beats = splitScriptIntoBeats(script);
  if (!beats.length) throw new Error("Script is empty");

  const prompt = `You are the director of a stickman explainer video. The narration is already split into numbered beats - do NOT change the words.
For every beat choose how the stickman and the screen look.

Allowed values:
- pose: ${POSES.join(", ")}
- mood: ${MOODS.join(", ")}
- accent: ${ACCENTS.join(", ")}
- camera: ${CAMERAS.join(", ")}
- props (0-2 per beat, only when they match what is said): ${PROPS.join(", ")}
- title: short on-screen headline (max 6 words), repeat the same one while the topic stays the same
- callouts: up to 3 short on-screen phrases (max 6 words each), optional

Beats:
${beats.map((b, i) => `${i}. ${b}`).join("\n")}

Return ONLY raw JSON, no markdown:
{"title":"catchy YouTube title under 90 chars","description":"2-3 sentence description with 3-4 hashtags","tags":["8 relevant tags"],"scenes":[{"pose":"","mood":"","accent":"","camera":"","title":"","callouts":[],"props":[{"type":""}]}]}
"scenes" must have exactly ${beats.length} entries, in the same order as the beats.`;

  let parsed: any = null;
  try {
    const raw = await askLlm(prompt);
    if (raw) parsed = parseAiJson<any>(raw);
  } catch (err: any) {
    pipelineLogger.warn(`Could not parse stickman plan from LLM: ${err.message}`, "StickmanPlanner");
  }

  const visuals: any[] = Array.isArray(parsed?.scenes) ? parsed.scenes : [];
  const aiVisuals = visuals.length === beats.length;
  const scenes: StickmanScene[] = beats.map((text, i) => ({
    id: `s${String(i + 1).padStart(2, "0")}`,
    text,
    visual: sanitizeVisual(aiVisuals ? visuals[i] : undefined, i),
  }));

  const fallbackTitle = titleHint?.trim() || beats[0].slice(0, 80);
  return {
    title: titleHint?.trim() || (typeof parsed?.title === "string" && parsed.title.trim()) || fallbackTitle,
    description: (typeof parsed?.description === "string" && parsed.description.trim()) || beats.slice(0, 2).join(" "),
    tags: Array.isArray(parsed?.tags) ? parsed.tags.filter((t: unknown) => typeof t === "string").slice(0, 10) : [],
    scenes,
    aiVisuals,
  };
}
