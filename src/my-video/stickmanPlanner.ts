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
const SETTINGS = ["none", "office", "classroom", "server", "city", "home", "stage", "space", "cloud"];

/** ~14 words is about 5-6 s of narration: short beats keep the visuals changing. */
const MAX_WORDS_PER_SCENE = 16;
const MIN_WORDS_PER_SCENE = 5;

export const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Strips what must never be spoken: markdown, quote marks and timing/section
 * labels such as "**Hook — 0–5 sec**" that script writers paste in.
 */
/** One scene of a structured production script (### Voiceover / ### Stickman / ### Remotion Visual sections). */
export interface StructuredScene { title: string; voiceover: string; notes: string }

/**
 * Production scripts mix what is SPOKEN with directions ("### Stickman: opens an old laptop", "### Remotion Visual: ```text ...```").
 * Only the "Voiceover"/"Narration" sections are narration; every other section is a visual direction for the AI director.
 * Returns null for plain scripts (no Voiceover/Narration heading).
 */
export function parseStructuredScript(raw: string): StructuredScene[] | null {
  const lines = raw.replace(/\r/g, "").split("\n");
  if (!lines.some((l) => /^#{1,6}\s*\**\s*(voice\s*-?\s*over|narration)\b/i.test(l.trim()))) return null;
  const scenes: { title: string; vo: string[]; notes: string[] }[] = [];
  let cur: { title: string; vo: string[]; notes: string[] } | null = null;
  let mode: "vo" | "notes" | "skip" | null = null;
  let inFence = false;
  const ensure = () => { if (!cur) { cur = { title: "", vo: [], notes: [] }; scenes.push(cur); } return cur; };
  for (const line of lines) {
    const t = line.trim();
    if (/^```/.test(t)) { inFence = !inFence; if (mode === "notes") ensure().notes.push(line); continue; }
    if (inFence) { if (mode === "notes") ensure().notes.push(line); continue; } // code/diagram blocks are never narrated
    const h = /^(#{1,6})\s*(.*)$/.exec(t);
    if (h) {
      const title = h[2].replace(/[*_`]/g, "").replace(/[:：]\s*$/, "").trim();
      if (/^(voice\s*-?\s*over|narration)\b/i.test(title)) { ensure(); mode = "vo"; continue; }
      if (/^(duration|time|timing|length)\b/i.test(title)) { mode = "skip"; continue; }
      if (/^(stickman|remotion|visual|animation|slide|screen|on[- ]?screen|b-?roll|sfx|music|sound|diagram|graphic|show|camera)/i.test(title)) {
        ensure().notes.push(`[${title}]`); mode = "notes"; continue;
      }
      // anything else with a heading starts a new scene (e.g. "# SCENE 02 — ANNOTATION VS XML")
      cur = { title, vo: [], notes: [] }; scenes.push(cur); mode = null; continue;
    }
    if (!cur) continue;
    if (mode === "vo") cur.vo.push(line);
    else if (mode === "notes") cur.notes.push(line);
  }
  const out = scenes
    .map((sc) => ({ title: sc.title, voiceover: sc.vo.join("\n").replace(/^\s*[-–—_*]{3,}\s*$/gm, "").trim(), notes: sc.notes.join("\n").replace(/\n{3,}/g, "\n\n").trim() }))
    .filter((sc) => sc.voiceover);
  return out.length ? out : null;
}

/** Which script section each beat belongs to, plus that section's visual directions. */
export function sceneNotesForBeats(raw: string, beats: string[]): { beatScene: number[]; notes: string[] } | null {
  const parsed = parseStructuredScript(raw);
  if (!parsed) return null;
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const vo = parsed.map((sc) => norm(sc.voiceover));
  let s = 0;
  const beatScene = beats.map((b) => {
    const key = norm(b).slice(0, 30);
    for (let k = s; k < Math.min(vo.length, s + 3); k++) if (vo[k].includes(key)) { s = k; break; }
    return s;
  });
  return { beatScene, notes: parsed.map((sc) => sc.notes.slice(0, 900)) };
}

export function cleanScript(script: string): string {
  const structured = parseStructuredScript(script);
  if (structured) script = structured.map((sc) => sc.voiceover).join("\n\n");
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
    setting: pick(v.setting, SETTINGS, "none"),
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

/**
 * Asks the LLM, hedged: FreeLLMAPI first; if it has not answered within HEDGE_MS (or fails) Gemini is asked too
 * and whichever returns text first wins. One slow provider (60 s timeouts) no longer stalls a batch for minutes.
 */
let geminiDownUntil = 0;
// planning answers are long structured JSON: the router often needs 60-120 s, so give each call longer than the 60 s default
const PLAN_CALL_TIMEOUT_MS = Number(process.env.PLAN_CALL_TIMEOUT_MS) || 150_000;
const HEDGE_MS = Number(process.env.PLAN_HEDGE_MS) || 25_000;
async function askLlm(prompt: string): Promise<string> {
  const providers: { name: string; ask: () => Promise<string> }[] = [];
  if (config.ai.provider === "freellmapi" || process.env.FREELLMAPI_KEY) {
    providers.push({ name: "FreeLLMAPI", ask: () => new FreeLlmApiClient().generateText(prompt, PLAN_CALL_TIMEOUT_MS) });
  }
  if (process.env.GEMINI_API_KEY) {
    providers.push({
      name: "Gemini",
      ask: async () => {
        if (Date.now() < geminiDownUntil) throw new Error("skipped (quota exhausted a moment ago)");
        try {
          return await new GeminiClient().generateText(prompt, { json: true });
        } catch (err: any) {
          // out of quota / model gone: stop spending calls (and minutes) on it for a while
          if (/status (429|404)|RESOURCE_EXHAUSTED|quota/i.test(String(err?.message))) geminiDownUntil = Date.now() + 10 * 60_000;
          throw err;
        }
      },
    });
  }
  if (!providers.length) return "";
  return new Promise<string>((resolve) => {
    let settled = false, launched = 0, failed = 0;
    let hedge: NodeJS.Timeout | undefined;
    const finish = (text: string) => { if (!settled) { settled = true; if (hedge) clearTimeout(hedge); resolve(text); } };
    const launch = () => {
      if (settled || launched >= providers.length) return;
      const p = providers[launched++];
      p.ask().then((text) => {
        if (text && text.trim()) finish(text);
        else onFail();
      }).catch((err: any) => {
        pipelineLogger.warn(`${p.name} failed for stickman plan: ${err.message}`, "StickmanPlanner");
        onFail();
      });
      if (launched < providers.length) hedge = setTimeout(launch, HEDGE_MS);
    };
    const onFail = () => {
      failed++;
      if (hedge) clearTimeout(hedge);
      if (launched < providers.length) launch();
      else if (failed >= providers.length) finish("");
    };
    launch();
  });
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

const BATCH = 12; // small batches: shorter answers rarely get truncated or miscounted by the LLM

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

SETTING (animated backdrop behind the scene, one per beat): office (careers, jobs, teams, interviews), classroom (learning, concepts, tutorials, roadmaps), server (backend, databases, infrastructure), city (industry, market, real world), home (personal advice, study habits, motivation), stage (hooks, intros, outros, big announcements), space (AI, futuristic, big ideas), cloud (cloud, DevOps, deployment, networks). Keep the SAME setting while the topic stays the same and change it only when the topic changes. Never use "none".

PROPS (0-2, only when they match what is said): ${PROPS.join(", ")}.

TEXT: "title" is a short headline (max 6 words) that stays the same while the topic stays the same. "callouts" are up to 3 punchy phrases of 3-8 words in UPPERCASE typography, e.g. "LEARNING ≠ JOB READY", "YOU ALREADY KNOW THE BASICS". Never copy the whole narration onto the screen.

VISUAL PACING: change something every 20-40 seconds of narration (new panel type, camera move, a reaction beat). Camera ("push" to emphasise, "pull" to reveal, pans to follow flows) only when it helps, otherwise "none". Do not bounce or overdo effects.

ACCURACY: never sacrifice technical accuracy; estimates stay estimates; no absolute claims such as "Java is always faster".`;

/** Pulls every complete top-level {...} object out of the "scenes" array of a broken/truncated JSON answer. */
export function salvageScenes(raw: string): any[] {
  const at = raw.indexOf('"scenes"');
  const open = at >= 0 ? raw.indexOf("[", at) : -1;
  if (open < 0) return [];
  const out: any[] = [];
  let depth = 0, begin = -1, inStr = false, esc = false;
  for (let i = open + 1; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth++ === 0) begin = i; }
    else if (c === "}" && --depth === 0 && begin >= 0) {
      try { out.push(JSON.parse(raw.slice(begin, i + 1))); } catch { out.push(undefined); }
      begin = -1;
    }
  }
  return out;
}

const PANEL_KEYS = ["steps", "flow", "code", "terminal", "browser", "compare", "counter", "chart", "progress", "table", "alert", "svg", "container", "quiz"];
export const isThin = (v: any): boolean =>
  !v || (!(Array.isArray(v.callouts) && v.callouts.some((c: unknown) => typeof c === "string" && c.trim())) &&
    !(Array.isArray(v.props) && v.props.length) && !PANEL_KEYS.some((k) => v[k]));

/**
 * The full director prompt for the given beat numbers. Used by the built-in LLM call and, with `echoText`, handed to
 * the user so they can run it in any external chat model and import the JSON it returns.
 */
export function buildDirectorPrompt(
  beats: string[], idxs: number[], total: number, notes?: { beatScene: number[]; notes: string[] } | null, echoText = false,
): string {
  // the script author's own visual directions for the sections these beats belong to (never narrated)
  const sections = notes ? [...new Set(idxs.map((i) => notes.beatScene[i]))].filter((k) => notes.notes[k]) : [];
  const notesBlock = sections.length
    ? `\nAUTHOR'S VISUAL DIRECTIONS (NOT narration - never put these sentences on screen verbatim; use them to choose the setting, props, panels, pose and mood):\n${sections.map((k) => `- ${notes!.notes[k]}`).join("\n")}\n`
    : "";
  return `${DIRECTOR_RULES}
${notesBlock}
The narration is already split into numbered beats - do NOT change the words. This is part of a ${total}-beat video; you are directing the ${idxs.length} beats below.

Allowed values:
- pose: ${POSES.join(", ")}
- mood: ${MOODS.join(", ")}
- accent: ${ACCENTS.join(", ")}
- camera: ${CAMERAS.join(", ")}
- setting: ${SETTINGS.filter((x) => x !== "none").join(", ")}

${idxs.length <= 3 ? `Context only (do NOT direct these): previous beat: "${beats[idxs[0] - 1] ?? ""}"; next beat: "${beats[idxs[idxs.length - 1] + 1] ?? ""}".\n` : ""}Beats:
${idxs.map((i) => `${i}. ${beats[i]}`).join("\n")}

Return ONLY raw JSON, no markdown:
{${idxs.includes(0) ? '"title":"catchy YouTube title under 90 chars","description":"2-3 sentence description with 3-4 hashtags","tags":["8 relevant tags"],' : ""}"scenes":[{"i":${idxs[0]},${echoText ? '"text":"the beat copied EXACTLY, word for word",' : ""}"pose":"","mood":"","accent":"","camera":"","setting":"","title":"","callouts":["..."]}]}
Add optional keys to a scene ONLY when needed: "chapter","flip","props":[{"type":""}] and at most one panel key ("steps","flow","code","terminal","browser","compare","counter","chart","progress","table","alert","svg","container","quiz") with the structure described above. Do NOT output keys with null values.
"scenes" must have exactly ${idxs.length} entries, one per beat, in order; "i" is the beat number it directs (${idxs[0]} for the first beat below, counting up in the order given). Every scene needs a setting and at least one of: callouts, props or a panel.`;
}

/** One LLM call for the given beat numbers: returns the scenes it directed, keyed by beat number (possibly partial). */
export async function directBeats(
  beats: string[], idxs: number[], total: number, notes?: { beatScene: number[]; notes: string[] } | null,
): Promise<{ meta: any; byIndex: Map<number, any> } | null> {
  const prompt = buildDirectorPrompt(beats, idxs, total, notes);
  try {
    const raw = await askLlm(prompt);
    if (!raw) return null;
    let parsed: any = null;
    try { parsed = parseAiJson<any>(raw); } catch (err: any) {
      pipelineLogger.warn(`Stickman plan JSON broken (${err.message}); salvaging complete scenes`, "StickmanPlanner");
    }
    const got: any[] = Array.isArray(parsed?.scenes) ? parsed.scenes : salvageScenes(raw);
    const byIndex = new Map<number, any>();
    const valid = got.filter((sc) => sc && typeof sc === "object");
    const inSet = new Set(idxs);
    const absIds = valid.map((sc) => sc.i);
    // The model echoes "i": usually the beat number, but often 0..n-1 (relative) or nothing. Trust it only when it is
    // a unique, complete mapping onto the beats we asked for; otherwise fall back to order, which is what a model that
    // returned the right number of scenes almost always kept.
    const absOk = valid.length > 0 && absIds.every((v) => Number.isInteger(v) && inSet.has(v)) && new Set(absIds).size === valid.length;
    if (absOk) {
      valid.forEach((sc) => byIndex.set(sc.i, sc));
    } else {
      valid.forEach((sc, pos) => { if (pos < idxs.length && !byIndex.has(idxs[pos])) byIndex.set(idxs[pos], sc); });
    }
    if (byIndex.size < idxs.length) {
      pipelineLogger.warn(`Stickman director gave ${byIndex.size}/${idxs.length} usable scenes`, "StickmanPlanner");
    }
    return byIndex.size ? { meta: parsed ?? {}, byIndex } : null;
  } catch (err: any) {
    pipelineLogger.warn(`Stickman plan call failed: ${err.message}`, "StickmanPlanner");
    return null;
  }
}

/** Runs `tasks` with at most `limit` in flight. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) { const k = next++; if (k >= tasks.length) return; out[k] = await tasks[k](); }
  }));
  return out;
}

/**
 * Turns the user's script into stickman scenes. The narration is split
 * deterministically (the script is never rewritten); the LLM directs the
 * visuals (pose, mood, backdrop, panels, props, on-screen text) and writes the
 * YouTube metadata. There is NO plain-stickman fallback: beats the AI missed or
 * left bare are re-asked in smaller groups, and if it still cannot direct the
 * video the plan throws so nothing is rendered.
 */
export async function planStickmanVideo(
  script: string, titleHint?: string, notes?: { beatScene: number[]; notes: string[] } | null,
  /** scenes the user imported from an external model: kept as-is, the AI only directs the remaining beats */
  prefilled?: { byIndex: Map<number, any>; meta: any },
): Promise<StickmanPlan> {
  script = cleanScript(script);
  const beats = splitScriptIntoBeats(script);
  if (!beats.length) throw new Error("Script is empty");

  const visuals: any[] = new Array(beats.length).fill(undefined);
  const locked = new Set<number>();
  let meta: any = prefilled && Object.keys(prefilled.meta ?? {}).length ? prefilled.meta : null;
  if (prefilled) for (const [i, sc] of prefilled.byIndex) if (i >= 0 && i < beats.length) { visuals[i] = sc; locked.add(i); }
  const merge = (res: { meta: any; byIndex: Map<number, any> } | null) => {
    if (!res) return;
    if (!meta && res.byIndex.has(0)) meta = res.meta;
    for (const [i, sc] of res.byIndex) if (isThin(visuals[i]) || !isThin(sc)) visuals[i] = sc;
  };

  // round 1: everything in batches; later rounds: only beats that are missing or bare, in smaller groups
  const all = beats.map((_, i) => i);
  const groups = (idxs: number[], size: number) => Array.from({ length: Math.ceil(idxs.length / size) }, (_, g) => idxs.slice(g * size, g * size + size));
  const ROUNDS = [BATCH, 8, 5, 3, 2, 1, 1, 1]; // keeps shrinking: a stubborn beat is asked alone, with its neighbours as context
  const planStart = Date.now();
  const PLAN_BUDGET_MS = (Number(process.env.PLAN_BUDGET_MIN) || 14) * 60_000; // never sit in "planning" for an hour
  for (let r = 0; r < ROUNDS.length; r++) {
    if (r > 0 && Date.now() - planStart > PLAN_BUDGET_MS) { pipelineLogger.warn("Stickman director: planning time budget used up", "StickmanPlanner"); break; }
    // early rounds also re-ask bare scenes; the last rounds only chase scenes the AI never directed at all
    const open = all.filter((i) => !locked.has(i));
    const todo = r === 0 ? open : open.filter((i) => (r < 4 ? isThin(visuals[i]) : !visuals[i]));
    if (!todo.length) break;
    const results = await pool(groups(todo, ROUNDS[r]).map((g) => () => directBeats(beats, g, beats.length, notes)), 4);
    results.forEach(merge);
    const left = open.filter((i) => isThin(visuals[i])).length;
    pipelineLogger.info(`Stickman director round ${r + 1}/${ROUNDS.length}: ${beats.length - left}/${beats.length} beats directed`, "StickmanPlanner");
  }
  const missing = all.filter((i) => !visuals[i]).length;
  const bare = all.filter((i) => !locked.has(i) && visuals[i] && isThin(visuals[i])).length;
  if (missing || bare > Math.ceil(beats.length * 0.3)) {
    throw new Error(
      `The AI visual director could not direct ${missing} of ${beats.length} scenes (${bare} had no visuals) after several retries, so no video was created. ` +
        "This is usually a temporary LLM problem - start the video again.",
    );
  }
  return finalizePlan(beats, visuals, meta, script, titleHint);
}

/** Shared by every way of getting a plan (AI, imported with a script, plan-only): consistent backdrops, sanitising, variety. */
function finalizePlan(beats: string[], visuals: any[], meta: any, script: string, titleHint?: string): StickmanPlan {
  // backdrops persist while the topic stays the same: a beat without one keeps the previous setting
  let lastSetting = "office";
  for (const v of visuals) {
    const st = typeof v?.setting === "string" && SETTINGS.includes(v.setting) && v.setting !== "none" ? v.setting : lastSetting;
    if (v) v.setting = st;
    lastSetting = st;
  }

  const aiVisuals = true;
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


// ── Importing a plan made outside the app (any chat model) ─────────────────────────────────────────────────────

/** A plan the user pasted was rejected; `details` says exactly why, `missing` lists beats that have no scene. */
export class PlanImportError extends Error {
  constructor(message: string, public details: string[] = [], public missing: number[] = []) {
    super(message);
    this.name = "PlanImportError";
  }
}

/** Director prompts for the whole script, split into chunks small enough for one external chat answer. */
export function buildImportPrompts(
  script: string, chunkSize = 40,
): { beatCount: number; prompts: { from: number; to: number; prompt: string }[] } {
  const cleaned = cleanScript(script);
  const beats = splitScriptIntoBeats(cleaned);
  if (!beats.length) throw new PlanImportError("Script is empty");
  const notes = sceneNotesForBeats(script, beats);
  const size = Math.max(5, Math.min(80, Math.round(chunkSize) || 40));
  const prompts: { from: number; to: number; prompt: string }[] = [];
  for (let from = 0; from < beats.length; from += size) {
    const idxs = beats.slice(from, from + size).map((_, k) => from + k);
    prompts.push({ from, to: idxs[idxs.length - 1], prompt: buildDirectorPrompt(beats, idxs, beats.length, notes, true) });
  }
  return { beatCount: beats.length, prompts };
}

/** Every complete top-level {...} / [...] value in pasted text; prose and ``` fences around them are ignored. */
function topLevelJson(raw: string): string[] {
  const out: string[] = [];
  let depth = 0, begin = -1, inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"' && depth > 0) inStr = true;
    else if (c === "{" || c === "[") { if (depth++ === 0) begin = i; }
    else if ((c === "}" || c === "]") && depth > 0 && --depth === 0 && begin >= 0) { out.push(raw.slice(begin, i + 1)); begin = -1; }
  }
  return out;
}

/** Reads the pasted answer(s): one JSON object, several answers pasted one after another, or a bare scenes array. */
export function parsePlanText(raw: string): { meta: any; scenes: any[] } {
  const scenes: any[] = [];
  let meta: any = {};
  const take = (v: any) => {
    const objects = (list: any[]) => list.filter((x) => x && typeof x === "object");
    if (Array.isArray(v)) { scenes.push(...objects(v)); return; }
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v.scenes)) {
      scenes.push(...objects(v.scenes));
      if (!meta.title && !meta.description && !meta.tags) meta = { title: v.title, description: v.description, tags: v.tags };
    } else if (Number.isInteger(v.i)) scenes.push(v);
  };
  const chunks = topLevelJson(raw);
  for (const chunk of chunks) {
    try { take(JSON.parse(chunk)); } catch {
      try { take(parseAiJson<any>(chunk)); } catch {
        scenes.push(...salvageScenes(chunk).filter((x) => x && typeof x === "object"));
      }
    }
  }
  if (!chunks.length && raw.includes('"scenes"')) scenes.push(...salvageScenes(raw).filter((x) => x && typeof x === "object")); // truncated answer
  if (!scenes.length) throw new PlanImportError("No scenes found in the pasted JSON", ['Paste the JSON the other model returned: an object with a "scenes" array.']);
  return { meta, scenes };
}

const sameText = (a: string, b: string): boolean => {
  const n = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return n(a) === n(b);
};

export interface PlanCheck {
  beatCount: number;
  /** imported scenes that line up with a beat of the script */
  byIndex: Map<number, any>;
  meta: any;
  /** beats of the script that have no scene yet */
  missing: number[];
  /** things that make the plan unusable (wrong text, out-of-range or duplicate beat numbers) */
  errors: string[];
}

/** Lines the pasted plan up against the script's beats without using any AI. */
export function checkImportedPlan(script: string, plan: unknown): PlanCheck {
  const beats = splitScriptIntoBeats(cleanScript(script));
  if (!beats.length) throw new PlanImportError("Script is empty");
  const parsed = typeof plan === "string" ? parsePlanText(plan) : Array.isArray(plan) ? { meta: {}, scenes: plan } : parsePlanText(JSON.stringify(plan ?? {}));
  const errors: string[] = [];
  const byIndex = new Map<number, any>();
  const short = (t: string) => (t.length > 60 ? `${t.slice(0, 57)}...` : t);
  parsed.scenes.forEach((sc, pos) => {
    if (!sc || typeof sc !== "object") { errors.push(`Scene #${pos + 1} is not an object`); return; }
    const idx = Number.isInteger(sc.i) ? (sc.i as number) : parsed.scenes.length === beats.length ? pos : -1;
    if (idx < 0) { errors.push(`Scene #${pos + 1} has no beat number "i"`); return; }
    if (idx >= beats.length) { errors.push(`Scene "i": ${idx} does not exist - the script has ${beats.length} beats (0-${beats.length - 1})`); return; }
    if (byIndex.has(idx)) { errors.push(`Beat ${idx} appears more than once`); return; }
    if (typeof sc.text === "string" && sc.text.trim() && !sameText(sc.text, beats[idx])) {
      errors.push(`Beat ${idx} text does not match the script: got "${short(sc.text.trim())}", expected "${short(beats[idx])}"`);
      return;
    }
    byIndex.set(idx, sc);
  });
  const missing = beats.map((_, i) => i).filter((i) => !byIndex.has(i));
  return { beatCount: beats.length, byIndex, meta: parsed.meta ?? {}, missing, errors };
}

/** Throws a PlanImportError unless the plan matches the script (and, without `repair`, covers every beat). */
export function assertImportablePlan(script: string, plan: unknown, repair: boolean): PlanCheck {
  const check = checkImportedPlan(script, plan);
  const cap = (list: string[]) => (list.length > 12 ? [...list.slice(0, 12), `...and ${list.length - 12} more`] : list);
  if (check.errors.length) {
    throw new PlanImportError(`The imported plan does not match your script (${check.errors.length} problem${check.errors.length > 1 ? "s" : ""})`, cap(check.errors), check.missing);
  }
  if (check.missing.length && !repair) {
    throw new PlanImportError(
      `The imported plan has no scene for ${check.missing.length} of ${check.beatCount} beats - paste the rest, or tick "Let the AI fill missing beats"`,
      [`Missing beat numbers: ${check.missing.slice(0, 40).join(", ")}${check.missing.length > 40 ? ", ..." : ""}`],
      check.missing,
    );
  }
  return check;
}

/**
 * Builds the video plan from an imported one. Imported scenes are sanitised like AI ones; with `repair` the AI directs
 * only the beats the import left out. Throws PlanImportError on any mismatch with the script.
 */
export async function importStickmanPlan(
  script: string, plan: unknown, opts: { repair?: boolean; titleHint?: string; notes?: { beatScene: number[]; notes: string[] } | null } = {},
): Promise<StickmanPlan> {
  const check = assertImportablePlan(script, plan, !!opts.repair);
  return planStickmanVideo(script, opts.titleHint, opts.notes, { byIndex: check.byIndex, meta: check.meta });
}


// ── Plan-only: the pasted JSON carries the narration itself (each scene's "text"), so no script and no AI is involved ──

/** A scene longer than this is not a "beat" any more: the visuals would sit still for far too long. */
const PLAN_ONLY_MAX_WORDS = 40;

export interface PlanOnlyCheck {
  scenes: { text: string; scene: any }[];
  meta: any;
  /** the narration, one scene per line */
  script: string;
  words: number;
  errors: string[];
}

const speakable = (t: string): string => t.replace(/[*#_`]+/g, "").replace(/[“”"]/g, "").replace(/\s+/g, " ").trim();

/** Reads and validates a plan-only JSON without any AI: scene order, narration present and of sensible length. */
export function checkPlanOnly(plan: unknown): PlanOnlyCheck {
  const parsed = typeof plan === "string" ? parsePlanText(plan) : Array.isArray(plan) ? { meta: {}, scenes: plan } : parsePlanText(JSON.stringify(plan ?? {}));
  const errors: string[] = [];
  const short = (t: string) => (t.length > 50 ? `${t.slice(0, 47)}...` : t);
  const withI = parsed.scenes.filter((s) => Number.isInteger(s?.i));
  // numbered scenes are put in order (answers pasted out of order are fine); unnumbered ones keep the pasted order
  const ordered = withI.length === parsed.scenes.length ? [...parsed.scenes].sort((a, b) => a.i - b.i) : parsed.scenes;
  if (withI.length === parsed.scenes.length) {
    const seen = new Set<number>();
    ordered.forEach((s) => { if (seen.has(s.i)) errors.push(`Scene number ${s.i} appears more than once`); seen.add(s.i); });
    const gaps = ordered.map((s) => s.i).filter((n, k) => k > 0 && n > ordered[k - 1].i + 1);
    if (ordered[0].i !== 0) errors.push(`Scenes must start at "i": 0 (the first one is ${ordered[0].i}) - a part is missing`);
    if (gaps.length) errors.push(`Scene numbers skip ahead before ${gaps.slice(0, 8).join(", ")} - part of the plan is missing`);
  }
  const scenes: { text: string; scene: any }[] = [];
  ordered.forEach((sc, pos) => {
    const label = Number.isInteger(sc.i) ? `Scene ${sc.i}` : `Scene #${pos + 1}`;
    const text = typeof sc.text === "string" ? speakable(sc.text) : "";
    if (!text) { errors.push(`${label} has no narration "text"`); return; }
    const n = countWords(text);
    if (n > PLAN_ONLY_MAX_WORDS) { errors.push(`${label} narration is ${n} words (max ${PLAN_ONLY_MAX_WORDS}) - split it into shorter scenes: "${short(text)}"`); return; }
    scenes.push({ text, scene: sc });
  });
  const script = scenes.map((s) => s.text).join("\n");
  return { scenes, meta: parsed.meta ?? {}, script, words: countWords(script), errors };
}

/** Throws a PlanImportError unless the plan-only JSON is complete and usable. */
export function assertPlanOnly(plan: unknown): PlanOnlyCheck {
  const check = checkPlanOnly(plan);
  if (check.errors.length) {
    const list = check.errors.length > 12 ? [...check.errors.slice(0, 12), `...and ${check.errors.length - 12} more`] : check.errors;
    throw new PlanImportError(`The plan cannot be used (${check.errors.length} problem${check.errors.length > 1 ? "s" : ""})`, list);
  }
  if (!check.scenes.length) throw new PlanImportError("The plan has no scenes");
  return check;
}

/** The video plan straight from the pasted JSON: no script, no length rewrite, no LLM. */
export function planFromPlanOnly(plan: unknown, titleHint?: string): StickmanPlan {
  const check = assertPlanOnly(plan);
  const beats = check.scenes.map((s) => s.text);
  return finalizePlan(beats, check.scenes.map((s) => s.scene), check.meta, check.script, titleHint);
}

/** What to give ChatGPT (with the transcript underneath) to get a plan-only JSON, in parts of `chunk` scenes. */
export function buildPlanOnlyPrompt(minutes: number, language: string, chunk = 40): string {
  const mins = Math.min(60, Math.max(1, Math.round(minutes) || 20));
  const words = targetWordsFor(mins * 60);
  const scenes = Math.round(words / 9);
  return `You are the scriptwriter AND the visual director for a finished video. Turn the TRANSCRIPT at the end into a ${mins}-minute narrated explainer, delivered as JSON scenes. Nothing else will edit your output: the JSON is fed straight into the video renderer.

NARRATION
- Total narration: about ${words} words (it is spoken at 2.4 words per second, so that is ${mins} minutes). About ${scenes} scenes, each scene = ONE beat of narration.
- Language: ${language}. Conversational, confident, technically accurate.
- Every scene's "text" is 6-16 words (never more than 25): one short spoken sentence or half-sentence. Plain text only: no markdown, no quotes, no emojis, no bullet points, no stage directions, no raw code (describe code aloud, show it in a "code" panel).
- Use only facts, names and numbers that appear in the transcript. Never invent statistics.

${DIRECTOR_RULES}

DELIVERY - IMPORTANT
- You will answer in PARTS of ${chunk} scenes. Numbering is continuous across parts: part 1 is "i": 0-${chunk - 1}, part 2 is "i": ${chunk}-${chunk * 2 - 1}, and so on.
- Part 1 only: include "title", "description" and "tags". Later parts: only "scenes".
- Each part is ONE raw JSON object and nothing else - no markdown fence, no explanation, no comments. Valid JSON only (double quotes, no trailing commas).
- After each part, stop. I will reply "next" and you continue with the following ${chunk} scenes. After the final scene of the video, end that part with the extra key "done": true.

Each scene looks like this:
{"i":0,"text":"the spoken narration for this beat","pose":"","mood":"","accent":"","camera":"","setting":"","title":"","callouts":["..."]}
Add optional keys to a scene ONLY when needed: "chapter","flip","props":[{"type":""}] and at most one panel key ("steps","flow","code","terminal","browser","compare","counter","chart","progress","table","alert","svg","container","quiz") with the structure described above. Do NOT output keys with null values.

Allowed values:
- pose: ${POSES.join(", ")}
- mood: ${MOODS.join(", ")}
- accent: ${ACCENTS.join(", ")}
- camera: ${CAMERAS.join(", ")}
- setting: ${SETTINGS.filter((x) => x !== "none").join(", ")}
Every scene needs a setting and at least one of: callouts, props or a panel.

Start with part 1 now.

TRANSCRIPT:
`;
}
