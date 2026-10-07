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

const LOOKS = ["auto", "camera", "left", "right", "up", "down"];
const str = (x: unknown, max: number): string => (typeof x === "string" ? x.trim().slice(0, max) : "");
const strList = (x: unknown, max: number, itemMax: number): string[] =>
  Array.isArray(x) ? x.map((i) => str(i, itemMax)).filter(Boolean).slice(0, max) : [];

// Panels (right side of the frame). Limits mirror my-video/src/stickman/schema.ts.
function sanitizePanel(v: any): Record<string, unknown> {
  const code = v?.code;
  if (code && Array.isArray(code.lines)) {
    const lines = code.lines.map((l: unknown) => String(l ?? "").replace(/\t/g, "  ").replace(/\s+$/, "").slice(0, 56)).slice(0, 10);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.some((l: string) => l.trim())) {
      const highlight = (Array.isArray(code.highlight) ? code.highlight : [])
        .filter((n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < lines.length).slice(0, 3);
      return { code: { title: str(code.title, 40) || undefined, lines, highlight } };
    }
  }
  const steps = strList(v?.steps?.items, 8, 48);
  if (steps.length >= 2) {
    const cur = Number(v.steps.current);
    return { steps: { items: steps, current: Number.isInteger(cur) ? Math.min(Math.max(cur, 0), steps.length - 1) : 0 } };
  }
  const beans = strList(v?.container?.beans, 8, 24);
  if (beans.length && str(v?.container?.label, 40)) return { container: { label: str(v.container.label, 40), beans } };
  const q = v?.quiz;
  const options = strList(q?.options, 4, 60);
  if (str(q?.question, 90) && options.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < options.length) {
    return { quiz: { question: str(q.question, 90), options, answer: q.answer } };
  }
  return {};
}

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
  if (v.flip === true) visual.flip = true;
  const look = pick(v.look, LOOKS, "auto");
  if (look !== "auto") visual.look = look;
  const panel = sanitizePanel(v);
  Object.assign(visual, panel);
  // a panel owns the right side of the frame: props would sit on top of it
  if (Object.keys(panel).length) delete visual.props;
  if (v.hideFigure === true && Object.keys(panel).length === 0) visual.hideFigure = true;
  return visual;
}

/**
 * Variety pass: an LLM tends to repeat itself, so never keep the same pose three
 * scenes in a row or the same camera move twice in a row.
 */
export function diversifyVisuals(scenes: StickmanScene[]): void {
  const rotation = ["point", "present", "think", "shrug", "walk", "smug", "idle"];
  for (let i = 2; i < scenes.length; i++) {
    const a = scenes[i - 2].visual as any, b = scenes[i - 1].visual as any, c = scenes[i].visual as any;
    if (a?.pose === b?.pose && b?.pose === c?.pose) {
      c.pose = rotation.find((r) => r !== c.pose && r !== b.pose) ?? "idle";
    }
  }
  for (let i = 1; i < scenes.length; i++) {
    const prev = scenes[i - 1].visual as any, cur = scenes[i].visual as any;
    if (cur.camera !== "none" && cur.camera === prev.camera) cur.camera = "none";
  }
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
- Write for SPEECH, not reading: natural spoken sentences, short sentences for emphasis, a question or ellipsis where a dramatic pause helps. Never open with greetings such as "Hello everyone" or "Welcome back"; the opening line must create curiosity.
- Never change facts or technical meaning; keep estimates as estimates and avoid absolute claims.
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

const BATCH = 28;

const DIRECTOR_RULES = `You direct a professional tech-education explainer (CodeOrCap): modern, technical, educational, never a children's cartoon. The stickman is an ACTOR that reacts to the story; the screen panels do the real explaining. Be visual-first: every beat needs a purposeful visual, not a stickman standing and talking.

STORY: the video follows HOOK -> PROBLEM -> CONTEXT -> EXPLANATION -> EXAMPLE -> COMPARISON/INSIGHT -> TAKEAWAY -> CONCLUSION (skip parts the script does not have). Use "chapter" (max 40 chars, e.g. "2 · The fresher path") on the first beat of each new section and leave it out on the others.

POSES (map the intent): pointing at something -> point; explaining -> present; thinking/reading/planning -> think; confused or "I don't know" -> shrug; surprised -> shocked; mistake -> facepalm; worry/risk -> worried; success -> celebrate; moving/progress -> walk; sure of himself -> smug. Pair the pose with a fitting mood. Do not use the same pose three beats in a row. Use "flip": true now and then so he points toward the other side. "look": left/right/up/down/camera only when it supports the line.

PANELS (right side of the frame, at most ONE per beat, and never the same panel type twice in a row):
- "steps": roadmaps, timelines, checklists, request flows, stages. {"items":["Core Java","Spring Boot","Database","Production"],"current":1}. items are 2-8 short labels (max 48 chars); "current" is the step being discussed now, earlier ones show as done. Reuse the SAME items list for consecutive beats of one topic and move "current" forward as the narration moves.
- "code": only when the narration talks about code. Realistic simplified, technically correct code, 3-8 lines, each line max 50 chars, e.g. {"title":"UserController.java","lines":["@GetMapping(\"/users\")","public List<User> getUsers() {","    return userService.getUsers();","}"],"highlight":[2]}. "highlight" = 0-based lines the narration is on.
- "container": things living inside something (beans in a Spring container): {"label":"Spring Container","beans":["UserService","UserRepo"]}.
- "quiz": at most once or twice in the whole video, only where a question is asked to the viewer: {"question":"...","options":["..","..",".."],"answer":0}.
Use a panel when it explains something; for hooks, reactions and opinions use the stickman with a prop instead of forcing a panel.

PROPS (0-2, only when they match what is said): ${PROPS.join(", ")}. Not allowed together with a panel.

TEXT: "title" is a short headline (max 6 words) that stays the same while the topic stays the same. "callouts" are up to 3 punchy phrases of 3-8 words in UPPERCASE typography, e.g. "LEARNING ≠ JOB READY", "YOU ALREADY KNOW THE BASICS". Never copy the whole narration onto the screen.

VISUAL PACING: change something every 20-40 seconds of narration (new panel type, camera move, a reaction beat). Camera ("push" to emphasise, "pull" to reveal, pans to follow flows) only when it helps, otherwise "none". Do not bounce or overdo effects.

ACCURACY: never sacrifice technical accuracy; estimates stay estimates; no absolute claims such as "Java is always faster".`;

/** One LLM call for beats [start, start+count): returns the raw parsed object, or null on failure. */
async function directBatch(
  beats: string[], start: number, total: number, carry: string,
): Promise<{ meta: any; scenes: any[] } | null> {
  const slice = beats.slice(start, start + BATCH);
  const prompt = `${DIRECTOR_RULES}

The narration is already split into numbered beats - do NOT change the words. This is part of a ${total}-beat video; you are directing beats ${start}-${start + slice.length - 1}.${carry ? `\nContext from the previous part: ${carry}` : ""}

Allowed values:
- pose: ${POSES.join(", ")}
- mood: ${MOODS.join(", ")}
- accent: ${ACCENTS.join(", ")}
- camera: ${CAMERAS.join(", ")}

Beats:
${slice.map((b, i) => `${start + i}. ${b}`).join("\n")}

Return ONLY raw JSON, no markdown:
{${start === 0 ? '"title":"catchy YouTube title under 90 chars","description":"2-3 sentence description with 3-4 hashtags","tags":["8 relevant tags"],' : ""}"scenes":[{"pose":"","mood":"","accent":"","camera":"","chapter":"","title":"","flip":false,"callouts":[],"props":[{"type":""}],"steps":null,"code":null,"container":null,"quiz":null}]}
"scenes" must have exactly ${slice.length} entries, in the same order as the beats. Use null or omit fields you do not need.`;
  try {
    const raw = await askLlm(prompt);
    if (!raw) return null;
    const parsed = parseAiJson<any>(raw);
    if (Array.isArray(parsed?.scenes) && parsed.scenes.length === slice.length) return { meta: parsed, scenes: parsed.scenes };
    pipelineLogger.warn(`Stickman director returned ${parsed?.scenes?.length ?? 0} scenes for ${slice.length} beats (batch @${start})`, "StickmanPlanner");
  } catch (err: any) {
    pipelineLogger.warn(`Could not parse stickman plan from LLM: ${err.message}`, "StickmanPlanner");
  }
  return null;
}

/**
 * Turns the user's script into stickman scenes. The narration is split
 * deterministically (the script is never rewritten); the LLM only directs the
 * visuals (pose, mood, panels, props, on-screen text) and writes the YouTube
 * metadata. Long scripts are directed in batches so one bad answer only
 * costs that batch, which falls back to rule-based visuals.
 */
export async function planStickmanVideo(script: string, titleHint?: string): Promise<StickmanPlan> {
  script = cleanScript(script);
  const beats = splitScriptIntoBeats(script);
  if (!beats.length) throw new Error("Script is empty");

  const visuals: any[] = [];
  let meta: any = null;
  let okBatches = 0;
  let carry = "";
  for (let start = 0; start < beats.length; start += BATCH) {
    let res = await directBatch(beats, start, beats.length, carry);
    if (!res) res = await directBatch(beats, start, beats.length, carry); // one retry
    if (res) {
      okBatches++;
      if (start === 0) meta = res.meta;
      visuals.push(...res.scenes);
      const last = res.scenes[res.scenes.length - 1] ?? {};
      const chapter = [...res.scenes].reverse().find((x: any) => x?.chapter)?.chapter;
      carry = `current chapter "${chapter ?? ""}", last pose ${last.pose ?? "?"}, last panel ${last.steps ? "steps" : last.code ? "code" : last.container ? "container" : last.quiz ? "quiz" : "none"}`;
    } else {
      visuals.push(...beats.slice(start, start + BATCH).map(() => undefined));
    }
  }

  const aiVisuals = okBatches > 0;
  const scenes: StickmanScene[] = beats.map((text, i) => ({
    id: `s${String(i + 1).padStart(2, "0")}`,
    text,
    visual: sanitizeVisual(visuals[i], i),
  }));
  diversifyVisuals(scenes);

  const fallbackTitle = titleHint?.trim() || beats[0].slice(0, 80);
  return {
    title: titleHint?.trim() || (typeof meta?.title === "string" && meta.title.trim()) || fallbackTitle,
    description: (typeof meta?.description === "string" && meta.description.trim()) || beats.slice(0, 2).join(" "),
    tags: Array.isArray(meta?.tags) ? meta.tags.filter((t: unknown) => typeof t === "string").slice(0, 10) : [],
    scenes,
    aiVisuals,
  };
}
