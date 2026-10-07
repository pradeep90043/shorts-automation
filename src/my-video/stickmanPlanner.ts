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
