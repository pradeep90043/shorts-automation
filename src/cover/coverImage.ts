import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { pipelineLogger } from "../utils/logger";
import { switchOn } from "../utils/switches";
import { config } from "../config";

/**
 * Cover images (YouTube thumbnail, Instagram Reel cover) for Shorts and long videos.
 *
 * The picture is AI-generated (Pollinations, flux) from the video's topic in the channel's look; the headline is NOT left to the AI
 * (it garbles text) but drawn on top with a dark gradient for contrast. If the AI is down the cover is a branded gradient, so a
 * cover is almost always produced. Never throws: null = no cover (the upload goes on without one).
 * COVER_IMAGES=off turns the whole feature off.
 */
export type CoverAspect = "landscape" | "portrait";

export interface Brand {
  name: string;
  bg: string;
  accent: string;
  style: string;
}

const BRANDS: Record<string, Brand> = {
  codeorcap: { name: "CODE OR CAP", bg: "#0B0B0B", accent: "#FFB800", style: "premium money and career look: modern Indian city office, young professional, rupee and growth visuals, warm gold accents, cinematic lighting, high contrast" },
  storiyum: { name: "STORIYUM", bg: "#14101F", accent: "#FF8A3D", style: "cinematic storybook illustration, warm dramatic light, emotional atmosphere, rich colours" },
  infoonspot: { name: "INFOONSPOT", bg: "#0A1220", accent: "#00D1FF", style: "breaking news style, bold modern tech visuals, deep blue tones, dramatic lighting" },
  prompt_gag: { name: "PROMPT GAG", bg: "#12081C", accent: "#B26BFF", style: "playful satirical illustration, vivid colours, funny expressive scene" },
};
const DEFAULT_BRAND: Brand = { name: "", bg: "#0B0B0B", accent: "#FFB800", style: "modern cinematic scene, dramatic lighting, high contrast" };

const SIZES: Record<CoverAspect, { w: number; h: number }> = { landscape: { w: 1280, h: 720 }, portrait: { w: 1080, h: 1920 } };
const MAX_BYTES = 1_900_000; // YouTube allows 2 MB

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const coverEnabled = (): boolean => switchOn("COVER_IMAGES");

/** Words -> lines of at most `maxChars`, at most `maxLines` (the rest is dropped with no ellipsis: a headline is a hook, not a sentence). */
export function wrapHeadline(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > maxChars) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

/** What the headline says: the AI's hook if there is one, else the title without channel suffixes, emoji and hashtags. */
export function headlineFor(meta: { title?: string; coverHeadline?: string; thumbnailText?: string }): string {
  const raw = (meta.coverHeadline || meta.thumbnailText || meta.title || "")
    .split("|")[0]
    .replace(/#\w+/g, " ")
    .replace(/[\p{Extended_Pictographic}️‍]/gu, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return raw.toUpperCase();
}

/** Gemini's image model (a few seconds, good quality). Free-tier quota can be 0: any failure just moves on to the next provider. */
async function geminiBackground(prompt: string, aspect: CoverAspect): Promise<Buffer | null> {
  const key = config.ai.geminiApiKey;
  if (!key || !switchOn("COVER_GEMINI")) return null;
  const model = process.env.COVER_GEMINI_MODEL || "gemini-2.5-flash-image";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${prompt} Aspect ratio ${aspect === "portrait" ? "9:16" : "16:9"}.` }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const part = (json.candidates?.[0]?.content?.parts || []).find((p: any) => p.inlineData?.data);
    if (!part) throw new Error("no image in the answer");
    const buf = Buffer.from(part.inlineData.data, "base64");
    await sharp(buf).metadata();
    return buf;
  } catch (err) {
    pipelineLogger.warn(`Cover: Gemini image failed (${err instanceof Error ? err.message : err})`, "Cover");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The owner's own image endpoint (a Cloudflare worker): POST {"prompt"} -> an image (1024x1024, cropped to the cover's shape later).
 * COVER_IMAGE_API_KEY (a secret on the server, never in this public repo) is required; COVER_IMAGE_API_URL overrides the built-in address.
 */
const DEFAULT_IMAGE_API_URL = "https://image-api.spamhu93.workers.dev";

async function workerBackground(prompt: string): Promise<Buffer | null> {
  const url = process.env.COVER_IMAGE_API_URL || DEFAULT_IMAGE_API_URL; // the address is not a secret: it lives in code; the key never does
  const key = process.env.COVER_IMAGE_API_KEY;
  if (!url || !key) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await sharp(buf).metadata();
      return buf;
    } catch (err) {
      pipelineLogger.warn(`Cover: image API attempt ${attempt}/2 failed (${err instanceof Error ? err.message : err})`, "Cover");
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Pollinations answered 402 (it wants payment now): stop asking it for the rest of this process instead of waiting ~10 s per picture. */
let pollinationsPaywalled = false;

async function aiBackground(prompt: string, w: number, h: number): Promise<Buffer | null> {
  if (pollinationsPaywalled) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75_000);
    try {
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&model=flux&nologo=true&enhance=false&seed=${Math.floor(Math.random() * 1e6)}`;
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 402) pollinationsPaywalled = true;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await sharp(buf).metadata(); // really an image?
      return buf;
    } catch (err) {
      pipelineLogger.warn(`Cover: AI image attempt ${attempt}/2 failed (${err instanceof Error ? err.message : err})`, "Cover");
    } finally {
      clearTimeout(timer);
    }
    if (pollinationsPaywalled) return null;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 4000));
  }
  return null;
}

function overlaySvg(brand: Brand, lines: string[], w: number, h: number, aspect: CoverAspect): string {
  const portrait = aspect === "portrait";
  const maxLen = Math.max(...lines.map((l) => l.length), 1);
  // the longest line has to fit 84% of the width; heavy sans-serif capitals are up to ~0.78 em wide (the font differs per machine)
  const fit = Math.floor((w * 0.84) / (maxLen * 0.78));
  const size = Math.max(40, Math.min(portrait ? 150 : 130, fit));
  const lineH = Math.round(size * 1.12);
  const blockH = lineH * lines.length;
  const y0 = portrait ? Math.round(h * 0.66) : Math.round(h - 60 - blockH + size * 0.85);
  const accentIdx = lines.length - 1; // the last line carries the accent colour
  const text = lines
    .map((l, i) => `<text x="${portrait ? w / 2 : 64}" y="${y0 + i * lineH}" text-anchor="${portrait ? "middle" : "start"}" font-family="Arial Black, Impact, Helvetica, Arial, sans-serif" font-weight="900" font-size="${size}" fill="${i === accentIdx ? brand.accent : "#FFFFFF"}" stroke="#000" stroke-width="${Math.round(size / 14)}" paint-order="stroke" stroke-linejoin="round">${esc(l)}</text>`)
    .join("");
  const tag = brand.name
    ? `<text x="${portrait ? w / 2 : 64}" y="${portrait ? 150 : 70}" text-anchor="${portrait ? "middle" : "start"}" font-family="Arial Black, Impact, Helvetica, Arial, sans-serif" font-weight="900" font-size="${portrait ? 54 : 38}" fill="${brand.accent}" letter-spacing="6" stroke="#000" stroke-width="3" paint-order="stroke">${esc(brand.name)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.45"/><stop offset="0.35" stop-color="#000" stop-opacity="0.05"/><stop offset="0.6" stop-color="#000" stop-opacity="0.55"/><stop offset="1" stop-color="#000" stop-opacity="0.9"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>${tag}${text}</svg>`;
}

/** The best photo URL of a Pexels search answer (portrait crop first), or null. Pure, so it can be tested without the network. */
export function pexelsPhotoUrl(json: any, aspect: CoverAspect): string | null {
  const photo = (json?.photos ?? []).find((p: any) => p?.src);
  if (!photo) return null;
  const s = photo.src;
  return (aspect === "portrait" ? s.portrait || s.large2x : s.landscape || s.large2x) || s.large || s.original || null;
}

/** Pexels stock photo (Pexels License: free for commercial use, no credit needed). Needs PEXELS_API_KEY; null on any failure. */
async function pexelsPhoto(query: string, aspect: CoverAspect): Promise<Buffer | null> {
  const key = (process.env.PEXELS_API_KEY || process.env.PIXELS_API_KEY || process.env.PEXEL_API_KEY || "").trim();
  const q = query.replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  if (!key || !q) return null;
  try {
    const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&orientation=${aspect}&size=large&per_page=5`, {
      headers: { Authorization: key },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = pexelsPhotoUrl(await res.json(), aspect);
    if (!url) throw new Error("no photo for the query");
    const img = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!img.ok) throw new Error(`photo HTTP ${img.status}`);
    const buf = Buffer.from(await img.arrayBuffer());
    await sharp(buf).metadata();
    pipelineLogger.info(`Background: Pexels stock photo for "${q}"`, "Cover");
    return buf;
  } catch (err) {
    pipelineLogger.warn(`Background: Pexels failed (${err instanceof Error ? err.message : err})`, "Cover");
    return null;
  }
}

/** The channel's look (colours + picture style), for other image features that must match the covers. */
export const brandFor = (key?: string): Brand => BRANDS[(key || "").toLowerCase()] ?? DEFAULT_BRAND;

/**
 * A picture for `prompt` from the same provider chain as the covers (worker, Gemini, free Pollinations), already cropped to w x h.
 * Never throws: null = every provider failed (the caller draws a branded background instead).
 */
export async function generateBackgroundImage(prompt: string, w: number, h: number, photoQuery?: string): Promise<Buffer | null> {
  const aspect: CoverAspect = h >= w ? "portrait" : "landscape";
  let ai = (await workerBackground(prompt)) ?? (await geminiBackground(prompt, aspect));
  let logoCut = false;
  if (!ai) {
    ai = await aiBackground(prompt, w, h);
    logoCut = !!ai;
  }
  // every AI provider failed: a licensed stock photo of the scene is better than a plain colour
  if (!ai && photoQuery) ai = await pexelsPhoto(photoQuery, aspect);
  if (!ai) return null;
  try {
    const meta = await sharp(ai).metadata();
    const keep = Math.round((meta.height || h) * (logoCut ? 0.91 : 1)); // the free service stamps a logo in the bottom corner
    return await sharp(await sharp(ai).extract({ left: 0, top: 0, width: meta.width || w, height: keep }).toBuffer()).resize(w, h, { fit: "cover" }).png().toBuffer();
  } catch {
    return null;
  }
}

const cache = new Map<string, Promise<string | null>>();

export interface CoverRequest {
  title?: string;
  coverHeadline?: string;
  thumbnailText?: string;
  brandKey?: string;
  aspect: CoverAspect;
}

/** A JPEG file for the request, or null. The same request (brand, aspect, headline) is made once and shared by YouTube and Instagram. */
export function makeCover(req: CoverRequest): Promise<string | null> {
  if (!coverEnabled()) return Promise.resolve(null);
  const brand = BRANDS[(req.brandKey || "").toLowerCase()] ?? DEFAULT_BRAND;
  const headline = headlineFor(req);
  if (!headline) return Promise.resolve(null);
  const key = `${(req.brandKey || "").toLowerCase()}|${req.aspect}|${headline}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = build(brand, headline, req).catch((err) => {
    pipelineLogger.warn(`Cover: failed (${err instanceof Error ? err.message : err}) -> no cover`, "Cover");
    return null;
  });
  cache.set(key, p);
  p.then((f) => { if (!f) cache.delete(key); });
  return p;
}

async function build(brand: Brand, headline: string, req: CoverRequest): Promise<string | null> {
  const { w, h } = SIZES[req.aspect];
  const topic = (req.title || headline).replace(/[\p{Extended_Pictographic}️‍#|]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const prompt = `${brand.style}, scene about: ${topic}. No text, no letters, no words, no logos, no watermark. ${req.aspect === "portrait" ? "vertical composition, subject in the upper middle" : "wide composition, subject on the right"}`;
  const started = Date.now();
  let ai = (await workerBackground(prompt)) ?? (await geminiBackground(prompt, req.aspect));
  let logoCut = false;
  if (!ai) {
    ai = await aiBackground(prompt, w, h);
    logoCut = !!ai;
  }
  // the free service stamps a small logo in the bottom-right corner: cut the bottom 9% off, then fill the canvas
  let base: sharp.Sharp;
  if (ai) {
    const meta = await sharp(ai).metadata();
    const keep = Math.round((meta.height || h) * (logoCut ? 0.91 : 1));
    base = sharp(await sharp(ai).extract({ left: 0, top: 0, width: meta.width || w, height: keep }).toBuffer()).resize(w, h, { fit: "cover" });
  } else {
    // no AI picture: brand colour with an accent glow, so the cover still looks designed
    const glow = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><radialGradient id="r" cx="0.75" cy="0.3" r="0.7"><stop offset="0" stop-color="${brand.accent}" stop-opacity="0.45"/><stop offset="1" stop-color="${brand.accent}" stop-opacity="0"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#r)"/></svg>`);
    base = sharp(await sharp({ create: { width: w, height: h, channels: 3, background: brand.bg } }).composite([{ input: glow }]).png().toBuffer());
  }
  const lines = wrapHeadline(headline, req.aspect === "portrait" ? 14 : 20, req.aspect === "portrait" ? 5 : 3);
  const svg = overlaySvg(brand, lines, w, h, req.aspect);
  const out = path.join(os.tmpdir(), "covers");
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `cover_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
  let buf: Buffer = Buffer.alloc(0);
  for (const q of [90, 80, 70, 60]) {
    buf = await base.clone().composite([{ input: Buffer.from(svg) }]).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (buf.length <= MAX_BYTES) break;
  }
  fs.writeFileSync(file, buf);
  pipelineLogger.info(`Cover (${req.aspect}, ${ai ? "AI image" : "brand background"}): "${headline}" ${Math.round(buf.length / 1024)} KB in ${Math.round((Date.now() - started) / 1000)}s`, "Cover");
  return file;
}
