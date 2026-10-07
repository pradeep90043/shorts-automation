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


// ── Free-form diagram ("svg" panel): a validated shape language, never raw SVG ──
const SHAPE_COLOR = /^(ink|accent|red|green|blue|gold|faint|bg|white|#[0-9a-fA-F]{6})$/;
const SVG_W = 1300, SVG_H = 700;

const clampNum = (x: unknown, min: number, max: number): number | null =>
  typeof x === "number" && Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : null;

function sanitizeShape(raw: any): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const base: Record<string, unknown> = {};
  if (Number.isInteger(raw.step)) base.step = Math.min(40, Math.max(0, raw.step));
  for (const k of ["fill", "stroke"] as const) if (typeof raw[k] === "string" && SHAPE_COLOR.test(raw[k])) base[k] = raw[k];
  const sw = clampNum(raw.sw, 1, 16);
  if (sw !== null) base.sw = sw;
  const X = (v: unknown) => clampNum(v, -100, 1400), Y = (v: unknown) => clampNum(v, -100, 800);
  switch (raw.t) {
    case "rect": {
      const x = X(raw.x), y = Y(raw.y), w = clampNum(raw.w, 1, 1400), h = clampNum(raw.h, 1, 800);
      if (x === null || y === null || w === null || h === null) return null;
      const rx = clampNum(raw.rx, 0, 200);
      return { t: "rect", x, y, w, h, ...(rx !== null ? { rx } : {}), ...base };
    }
    case "circle": {
      const cx = X(raw.cx), cy = Y(raw.cy), r = clampNum(raw.r, 1, 500);
      return cx === null || cy === null || r === null ? null : { t: "circle", cx, cy, r, ...base };
    }
    case "line": {
      const x1 = X(raw.x1), y1 = Y(raw.y1), x2 = X(raw.x2), y2 = Y(raw.y2);
      if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
      return { t: "line", x1, y1, x2, y2, ...(raw.arrow === true ? { arrow: true } : {}), ...(raw.dash === true ? { dash: true } : {}), ...base };
    }
    case "path":
      return typeof raw.d === "string" && raw.d.length <= 400 && /^[MLHVCSQTAZmlhvcsqtaz0-9 ,.\-]+$/.test(raw.d) ? { t: "path", d: raw.d, ...base } : null;
    case "text": {
      const x = X(raw.x), y = Y(raw.y), text = str(raw.text, 40);
      if (x === null || y === null || !text) return null;
      return { t: "text", x, y, text, size: clampNum(raw.size, 24, 96) ?? 40, anchor: ["start", "middle", "end"].includes(raw.anchor) ? raw.anchor : "middle", ...base };
    }
    default:
      return null;
  }
}

/** Text boxes (approximate) of an svg panel, used to reject unreadable layouts. */
function textBoxes(shapes: any[]): { x0: number; x1: number; y0: number; y1: number }[] {
  return shapes.filter((s) => s.t === "text").map((s) => {
    const w = s.text.length * s.size * 0.6;
    const x0 = s.anchor === "start" ? s.x : s.anchor === "end" ? s.x - w : s.x - w / 2;
    return { x0, x1: x0 + w, y0: s.y - s.size * 0.85, y1: s.y + s.size * 0.25 };
  });
}

const rectArea = (r: any) => r.w * r.h;
const insideRect = (px: number, py: number, r: any, inset: number) =>
  px > r.x + inset && px < r.x + r.w - inset && py > r.y + inset && py < r.y + r.h - inset;

/** Why a drawing is unreadable, or null when it is fine. */
function svgLayoutProblem(shapes: any[]): string | null {
  const boxes = textBoxes(shapes);
  if (boxes.some((b) => b.x0 < -10 || b.x1 > SVG_W + 10 || b.y0 < -10 || b.y1 > SVG_H + 10)) return "text off the panel";
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ox > 0 && oy > 0 && (ox * oy) / Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0)) > 0.25) return "overlapping text";
    }
  }
  // "node" rects: not a background / container (those legitimately hold other shapes)
  const nodes = shapes.filter((s) => s.t === "rect" && rectArea(s) < SVG_W * SVG_H * 0.3);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 4 && oy > 4 && (ox * oy) / Math.min(rectArea(a), rectArea(b)) > 0.1) return "overlapping boxes";
    }
  }
  // a line must not run through a box or a label (it may start / end on one)
  for (const l of shapes.filter((s) => s.t === "line")) {
    const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
    for (let d = 14; d < len - 14; d += 8) {
      const px = l.x1 + ((l.x2 - l.x1) * d) / len, py = l.y1 + ((l.y2 - l.y1) * d) / len;
      if (nodes.some((r) => insideRect(px, py, r, 6))) return "line crosses a box";
      if (boxes.some((b) => px > b.x0 && px < b.x1 && py > b.y0 && py < b.y1)) return "line crosses text";
    }
  }
  return null;
}

/**
 * Returns the panel, or null when the AI's drawing would be unreadable. Unreadable drawings are
 * not thrown away: their labels become a step list (see svgFallback), so the scene keeps a visual.
 */
export function sanitizeSvg(raw: any): Record<string, unknown> | null {
  if (!raw || !Array.isArray(raw.shapes)) return null;
  const shapes = raw.shapes.slice(0, 40).map(sanitizeShape).filter((s: unknown): s is Record<string, unknown> => s !== null);
  if (shapes.length < 2) return null;
  if (svgLayoutProblem(shapes)) return null;
  // the scene's own headline already names the diagram, so the panel carries no title
  return { shapes };
}

/** Labels of a rejected drawing, top to bottom, as an ordered step list. */
export function svgFallback(raw: any): Record<string, unknown> | null {
  if (!raw || !Array.isArray(raw.shapes)) return null;
  const texts = raw.shapes.map(sanitizeShape).filter((s: any) => s?.t === "text") as any[];
  const labels: string[] = [];
  for (const t of [...texts].sort((a, b) => a.y - b.y || a.x - b.x)) if (!labels.includes(t.text)) labels.push(t.text.slice(0, 48));
  return labels.length >= 2 ? { steps: { items: labels.slice(0, 8), current: 0 } } : null;
}

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
  const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const compare = v?.compare;
  if (Array.isArray(compare?.cards) && compare.cards.length >= 2) {
    const cards = compare.cards.slice(0, 3).filter((c: any) => str(c?.title, 28)).map((c: any) => ({
      title: str(c.title, 28), points: strList(c.points, 4, 40), winner: c.winner === true,
    }));
    if (cards.length >= 2) return { compare: { mode: compare.mode === "beforeAfter" ? "beforeAfter" : "versus", cards } };
  }
  const nodes = strList(v?.flow?.nodes, 5, 24);
  if (nodes.length >= 2) {
    const active = Number.isInteger(v.flow.active) && v.flow.active >= 0 && v.flow.active < nodes.length ? v.flow.active : undefined;
    return { flow: { nodes, active, packet: str(v.flow.packet, 20) || undefined } };
  }
  const tLines = (Array.isArray(v?.terminal?.lines) ? v.terminal.lines : []).map((l: unknown) => String(l ?? "").slice(0, 64)).filter((l: string) => l.trim()).slice(0, 10);
  if (tLines.length) return { terminal: { title: str(v.terminal.title, 30) || undefined, lines: tLines } };
  const b = v?.browser;
  const bLines = (Array.isArray(b?.lines) ? b.lines : []).map((l: unknown) => String(l ?? "").replace(/\s+$/, "").slice(0, 44)).filter((l: string) => l.trim()).slice(0, 8);
  if (str(b?.url, 48) && bLines.length) {
    return { browser: { url: str(b.url, 48), kind: b.kind === "json" ? "json" : "page", heading: str(b.heading, 40) || undefined, lines: bLines } };
  }
  const cItems = (Array.isArray(v?.counter?.items) ? v.counter.items : []).slice(0, 3)
    .filter((i: any) => num(i?.value) !== null && str(i?.label, 26))
    .map((i: any) => ({ value: i.value, from: num(i.from) ?? 0, prefix: str(i.prefix, 4), suffix: str(i.suffix, 10), label: str(i.label, 26) }));
  if (cItems.length) {
    const d = Number(v.counter.decimals);
    return { counter: { items: cItems, decimals: Number.isInteger(d) ? Math.min(Math.max(d, 0), 2) : 0 } };
  }
  const ch = v?.chart;
  const labels = strList(ch?.labels, 6, 14);
  const values = (Array.isArray(ch?.values) ? ch.values : []).map(num).filter((n: number | null): n is number => n !== null).slice(0, 6);
  if (labels.length >= 2 && labels.length === values.length) {
    const hl = Number.isInteger(ch.highlight) && ch.highlight >= 0 && ch.highlight < values.length ? ch.highlight : undefined;
    return { chart: { kind: ch.kind === "line" ? "line" : "bar", title: str(ch.title, 40) || undefined, labels, values, unit: str(ch.unit, 8), highlight: hl } };
  }
  const pItems = (Array.isArray(v?.progress?.items) ? v.progress.items : []).slice(0, 5)
    .filter((i: any) => str(i?.label, 28) && num(i?.value) !== null)
    .map((i: any) => ({ label: str(i.label, 28), value: Math.min(100, Math.max(0, i.value)) }));
  if (pItems.length) return { progress: { items: pItems } };
  const tb = v?.table;
  const cols = strList(tb?.columns, 5, 14);
  const rows = (Array.isArray(tb?.rows) ? tb.rows : []).slice(0, 5)
    .map((r: unknown) => (Array.isArray(r) ? r.map((c) => String(c ?? "").slice(0, 18)) : []))
    .filter((r: string[]) => r.length === cols.length);
  if (cols.length >= 2 && rows.length) {
    const hr = Number.isInteger(tb.highlightRow) && tb.highlightRow >= 0 && tb.highlightRow < rows.length ? tb.highlightRow : undefined;
    return { table: { name: str(tb.name, 30) || undefined, columns: cols, rows, highlightRow: hr } };
  }
  if (v?.svg) {
    const svg = sanitizeSvg(v.svg);
    if (svg) return { svg };
    const fallback = svgFallback(v.svg);
    if (fallback) return fallback;
  }
  const al = v?.alert;
  if (["error", "success", "warning"].includes(al?.kind) && str(al?.title, 40)) {
    return { alert: { kind: al.kind, title: str(al.title, 40), detail: str(al.detail, 90) || undefined } };
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
  // a panel owns the right side of the frame: props and callouts would sit on top of it
  if (Object.keys(panel).length) {
    delete visual.props;
    delete visual.callouts;
  }
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
    // hand-drawn diagrams are the riskiest visual: never two beats in a row
    if (cur.svg && prev.svg) delete cur.svg;
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


const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};

/** Every number the script itself states, as digits ("10", "3.5") or words ("three"). */
export function scriptNumbers(script: string): Set<number> {
  const found = new Set<number>();
  for (const m of script.matchAll(/\d[\d,]*(?:\.\d+)?/g)) found.add(Number(m[0].replace(/,/g, "")));
  for (const m of script.toLowerCase().matchAll(/[a-z]+/g)) if (m[0] in NUMBER_WORDS) found.add(NUMBER_WORDS[m[0]]);
  return found;
}

/**
 * Charts, counters and progress bars show numbers as facts. Drop the panel when it shows a figure
 * the script never states (the model must not invent statistics).
 */
export function dropInventedNumbers(scenes: StickmanScene[], script: string): number {
  const allowed = scriptNumbers(script);
  let dropped = 0;
  for (const sc of scenes) {
    const v = sc.visual as any;
    const shown: number[] = [
      ...(v.chart?.values ?? []),
      ...(v.counter?.items?.map((i: any) => i.value) ?? []),
      ...(v.progress?.items?.map((i: any) => i.value) ?? []),
    ];
    if (shown.length && shown.some((n) => !allowed.has(n))) {
      delete v.chart; delete v.counter; delete v.progress;
      dropped++;
    }
  }
  return dropped;
}

const BATCH = 28;

const DIRECTOR_RULES = `You direct a professional tech-education explainer (CodeOrCap): modern, technical, educational, never a children's cartoon. The stickman is an ACTOR that reacts to the story; the screen panels do the real explaining. Be visual-first: every beat needs a purposeful visual, not a stickman standing and talking.

STORY: the video follows HOOK -> PROBLEM -> CONTEXT -> EXPLANATION -> EXAMPLE -> COMPARISON/INSIGHT -> TAKEAWAY -> CONCLUSION (skip parts the script does not have). Use "chapter" (max 40 chars, e.g. "2 · The fresher path") on the first beat of each new section and leave it out on the others.

POSES (map the intent): pointing at something -> point; explaining -> present; thinking/reading/planning -> think; confused or "I don't know" -> shrug; surprised -> shocked; mistake -> facepalm; worry/risk -> worried; success -> celebrate; moving/progress -> walk; sure of himself -> smug. Pair the pose with a fitting mood. Do not use the same pose three beats in a row. Use "flip": true now and then so he points toward the other side. "look": left/right/up/down/camera only when it supports the line.

PANELS (right side of the frame, at most ONE per beat, never the same panel type twice in a row, and no callouts/props on a panel beat). Pick the panel that matches what is being said:
- "steps": roadmaps, timelines, checklists, stages. {"items":["Core Java","Spring Boot","Database","Production"],"current":1}. 2-8 labels (max 48 chars); "current" = the step being discussed, earlier ones show as done. Reuse the SAME items for consecutive beats of one topic and move "current" forward.
- "flow": architecture / request flow, animated packet travelling through the nodes. {"nodes":["Controller","Service","Repository","Database"],"packet":"GET /users"} (2-5 nodes, max 24 chars; optional "active" = node index the packet stops at).
- "code": only when the narration talks about code. Realistic, technically correct, 3-8 lines, each max 50 chars: {"title":"UserController.java","lines":["@GetMapping(\"/users\")","public List<User> getUsers() {","    return userService.getUsers();","}"],"highlight":[2]}.
- "terminal": commands and their output. Lines starting with "$ " are typed as commands: {"title":"zsh","lines":["$ mvn spring-boot:run","Started Application in 3.2 seconds"]}.
- "browser": a web page or an API response. {"url":"localhost:8080/users","kind":"json","lines":["{","  \"id\": 1,","  \"name\": \"Asha\"","}"]} or kind "page" with "heading" and short row lines.
- "compare": options side by side, or a transformation. {"mode":"versus","cards":[{"title":"Java","points":["Strong typing","Huge ecosystem"],"winner":true},{"title":"Node.js","points":["Fast to start"]}]} (2-3 cards, max 4 points of max 40 chars). Use mode "beforeAfter" with two cards for before/after.
- "counter": big animated numbers for durations, sizes, counts: {"items":[{"value":6,"suffix":" mo","label":"FRESHER"}]} (1-3 items; label max 26 chars).
- "chart": comparing quantities. {"kind":"bar","title":"Months to job-ready","labels":["Fresher","Frontend","Backend"],"values":[5,3,2],"unit":"mo","highlight":0} (kind "bar" or "line", 2-6 points; labels and values must have the same length). Only use numbers that appear in, or are clearly implied by, the narration.
- "progress": skill / completion bars: {"items":[{"label":"Core Java","value":90}]} (1-5 items, value 0-100).
- "table": database rows / query results: {"name":"users","columns":["id","name","role"],"rows":[["1","Asha","admin"]],"highlightRow":0} (2-5 columns, 1-5 rows, every row has one cell per column, cells max 18 chars).
- "alert": an error, success or warning state: {"kind":"error","title":"NullPointerException","detail":"user is null"}.
- "svg": LAST RESORT. A custom diagram YOU draw, only for things the panels above cannot show: a tree (inheritance, hierarchy), a 2x2 matrix, a layered stack, a cycle. A simple chain or request path is a "flow" or "steps", NOT an svg. Never use svg on two beats in a row. Canvas is 1300 wide x 700 tall. Shapes: rect{x,y,w,h,rx}, circle{cx,cy,r}, line{x1,y1,x2,y2,arrow,dash}, path{d}, text{x,y,text,size,anchor}. Colours: ink, accent, red, green, blue, gold, faint, bg, white or #rrggbb ("white" text on accent/green/blue/red boxes, "ink" text on gold/faint boxes). Shapes appear in the order given (same "step" = together): build the diagram in the order it is explained.
  LAYOUT RULES (drawings that break them are discarded): put boxes on a grid, boxes 300x100, rows at y=60 / 250 / 440 (a 4th row at 600 only for a short chain), column centres x=250 / 650 / 1050 (so a box at centre c has x=c-150); text centred in its box with x=centre and y=box y+66 for size 44; arrows run only through the GAP between boxes (from the bottom edge of one box to the top edge of the next, e.g. y1=160 to y2=250), never through a box or a label; text size 32-48, at most 24 characters; 4-14 shapes; never overlap boxes; no title (the scene headline names it).
  Example tree (Animal with children Dog and Cat): [{"t":"rect","x":500,"y":60,"w":300,"h":100,"rx":22,"fill":"accent","stroke":"ink","step":0},{"t":"text","x":650,"y":126,"text":"Animal","size":44,"fill":"white","step":0},{"t":"line","x1":600,"y1":160,"x2":300,"y2":250,"arrow":true,"step":1},{"t":"line","x1":700,"y1":160,"x2":1000,"y2":250,"arrow":true,"step":1},{"t":"rect","x":100,"y":250,"w":300,"h":100,"rx":22,"fill":"green","stroke":"ink","step":2},{"t":"text","x":250,"y":316,"text":"Dog","size":44,"fill":"white","step":2},{"t":"rect","x":900,"y":250,"w":300,"h":100,"rx":22,"fill":"gold","stroke":"ink","step":2},{"t":"text","x":1050,"y":316,"text":"Cat","size":44,"fill":"ink","step":2}]
- "quiz": at most once or twice in the whole video, only where a question is asked to the viewer: {"question":"...","options":["..","..",".."],"answer":0}.
- "container": things living inside something (beans in a Spring container): {"label":"Spring Container","beans":["UserService","UserRepo"]}.
Use a panel when it explains something; for hooks, reactions and opinions use the stickman with a prop and callouts instead of forcing a panel. Never invent statistics: numbers in counter/chart/progress must come from the script.

PROPS (0-2, only when they match what is said): ${PROPS.join(", ")}.

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
{${start === 0 ? '"title":"catchy YouTube title under 90 chars","description":"2-3 sentence description with 3-4 hashtags","tags":["8 relevant tags"],' : ""}"scenes":[{"pose":"","mood":"","accent":"","camera":"","chapter":"","title":"","flip":false,"callouts":[],"props":[{"type":""}],"steps":null,"flow":null,"code":null,"terminal":null,"browser":null,"compare":null,"counter":null,"chart":null,"progress":null,"table":null,"alert":null,"svg":null,"container":null,"quiz":null}]}
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
      carry = `current chapter "${chapter ?? ""}", last pose ${last.pose ?? "?"}, last panel ${["steps", "flow", "code", "terminal", "browser", "compare", "counter", "chart", "progress", "table", "alert", "svg", "container", "quiz"].find((k) => last[k]) ?? "none"}`;
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
  const invented = dropInventedNumbers(scenes, script);
  if (invented) pipelineLogger.info(`Dropped ${invented} number panel(s) whose figures are not in the script`, "StickmanPlanner");

  const fallbackTitle = titleHint?.trim() || beats[0].slice(0, 80);
  return {
    title: titleHint?.trim() || (typeof meta?.title === "string" && meta.title.trim()) || fallbackTitle,
    description: (typeof meta?.description === "string" && meta.description.trim()) || beats.slice(0, 2).join(" "),
    tags: Array.isArray(meta?.tags) ? meta.tags.filter((t: unknown) => typeof t === "string").slice(0, 10) : [],
    scenes,
    aiVisuals,
  };
}
