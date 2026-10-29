import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { brandFor, generateBackgroundImage, wrapHeadline } from "../cover/coverImage";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { iconFor, iconSvg } from "./rowIcons";
import { renderListCardHtml } from "./htmlCardRenderer";

/**
 * Format "image_music": one list card (our own AI picture + our own layout, never a frame of the source) that is shown for a few
 * seconds over a synthesised music bed. The facts come from the source reel's text; the wording and the picture are ours.
 */
export interface ListCardContent {
  title: string;
  rows: Array<{ label: string; value: string }>;
  closing?: string;
  /** a photo scene for the AI picture, no text in it */
  image: string;
}

/** every item of the source is shown: the card grows taller and the video pans down it (only a runaway answer is cut) */
export const MAX_ROWS = 60;

const clip = (s: unknown, max: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The prompt that turns a source reel's text into a list card. `hindi` = Devanagari wording (all channels but CodeOrCap). */
export function listCardPrompt(material: string, hindi: boolean): string {
  return (
    `From the MATERIAL below (the text of a short video) make a LIST CARD in ${hindi ? "Hindi written in Devanagari script (numbers as digits)" : "English"}. ` +
    `Use the facts and numbers of the material but write your own wording; NEVER invent a number, price or claim that is not in the material. Ignore calls to action in the material (follow, subscribe, comment, DM, link in bio, join a list): they are not facts. ` +
    `Answer with JSON only: {"title": hook of at most 55 characters that contains the main number or promise, ` +
    `"rows": one object per item of the material, ALL of them in order with nothing left out (a "top 10" has 10 rows, a table of 25 has 25). ` +
    `For a table of numbers/prices/metrics, use {"label": metric name at most 30 chars, "value": compact number/price at most 12 chars e.g. "₹15 LPA" or "250-300"}. ` +
    `For tips, advice, mistakes, steps, ideas, or rules, use {"label": the full point/advice as a single clear sentence of at most 60 chars, "value": ""}. ` +
    `"closing": one short sentence of at most 90 characters (a caveat or takeaway), ` +
    `"image": one photo scene that fits the topic, described in English, no text, no people's faces}.\n\nMATERIAL:\n${material.slice(0, 1800)}\n/no_think`
  );
}

/** The JSON object in an LLM answer, validated and clamped. null = unusable (the caller falls back or skips the format). */
export function parseListCard(raw: string): ListCardContent | null {
  const m = /\{[\s\S]*\}/.exec(raw || "");
  if (!m) return null;
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const title = clip(j?.title, 60);
  const rows = (Array.isArray(j?.rows) ? j.rows : [])
    .filter((r: any) => r?.label && clip(r.label, 80).length > 0)
    .map((r: any) => {
      let label = clip(r?.label, 80);
      let value = clip(r?.value, 40);
      // If value is a sentence/phrase (>16 chars or >3 words without numeric patterns), merge into label
      if (value.length > 16 || (value.split(/\s+/).length > 3 && !/^[₹$€£\d\s\-.,%a-zA-Z/+]+$/.test(value))) {
        if (!value.toLowerCase().includes(label.toLowerCase()) && label.length <= 25) {
          label = `${label}: ${value}`;
        } else if (value.length >= label.length) {
          label = value;
        }
        value = "";
      }
      return { label, value };
    })
    .slice(0, MAX_ROWS);
  if (!title || rows.length < 3) return null;
  return { title, rows, closing: clip(j?.closing, 100) || undefined, image: clip(j?.image, 200) || title };
}

/** "label :- value" / "label: value" lines of an OCR text (what a static list card Short looks like), when the LLM is unavailable. */
export function listCardFromLines(text: string, title: string): ListCardContent | null {
  const rows: Array<{ label: string; value: string }> = [];
  for (const line of (text || "").split(/\n+/)) {
    const m = /^\s*([^:]{2,40}?)\s*(?::-|:|–|—)\s*(.{1,30})$/.exec(line);
    if (m) rows.push({ label: clip(m[1], 80), value: clip(m[2], 40) });
  }
  if (rows.length < 3) return null;
  return { title: clip(title, 60) || "Quick facts", rows: rows.slice(0, MAX_ROWS), image: clip(title, 200) || "a clean modern workspace" };
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const FONT = "Noto Sans, Noto Sans Devanagari, DejaVu Sans, Arial, Helvetica, sans-serif";
/** average glyph width as a share of the font size (Devanagari and bold Latin are wide; the font differs per machine) */
export const GLYPH = 0.62;
/** a light mood for every picture: the SCENE decides what is shown (the channel cover style would put a developer desk in every scene) */
export const PICTURE_MOOD = "photorealistic, cinematic dramatic lighting, dark moody tones with warm golden highlights, shallow depth of field";
export const CARD_W = 1080;
export const CARD_H = 1920;

/** The card's SVG and its height: 1920 when everything fits on one screen, taller when it does not (the video then pans down). */
export function cardLayout(c: ListCardContent, accent: string, footer?: string): { svg: string; height: number } {
  const titleLines = wrapHeadline(c.title, 20, 4);
  const titleSize = Math.max(64, Math.min(96, Math.floor((CARD_W * 0.88) / (Math.max(...titleLines.map((l) => l.length), 1) * GLYPH))));
  const titleY0 = 230;
  const titleH = Math.round(titleSize * 1.2);
  const title = titleLines
    .map((l, i) => `<text x="${CARD_W / 2}" y="${titleY0 + i * titleH}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${titleSize}" fill="${i === 0 ? accent : "#fff"}" stroke="#000" stroke-opacity="0.45" stroke-width="3" paint-order="stroke">${esc(l)}</text>`)
    .join("");
  const ruleY = titleY0 + (titleLines.length - 1) * titleH + 44;

  // one readable size for every row; a long label wraps onto more lines instead of shrinking the text
  const rowSize = 44;
  const valueSize = Math.round(rowSize * 1.12);
  const lineH = Math.round(rowSize * 1.25);
  // each row starts with an icon of what it is about (rowIcons.ts: a stored icon set, no extra AI picture)
  const iconSize = 64;
  const textX = 100 + iconSize + 26; // = 190
  const inner = CARD_W - 100 - textX; // = 790
  const hasDevanagari = (s: string) => /[\u0900-\u097F]/.test(s);

  // Check if every row has a compact metric value (numbers, currency, units <= 15 chars)
  const isMetricVal = (v: string) => {
    const s = (v || "").trim();
    if (!s || s.length > 15) return false;
    const words = s.split(/\s+/);
    return words.length <= 3 || /^[₹$€£\d\s\-.,%a-zA-Z/+]+$/.test(s);
  };
  const isMetricCard = c.rows.length > 0 && c.rows.every((r) => isMetricVal(r.value));

  const laid = c.rows.map((r) => {
    const lblCharW = hasDevanagari(r.label) ? 0.72 : 0.54;
    const icon = iconFor(r.label || r.value);

    if (isMetricCard) {
      // 2-Column Metric Table: left column label, right column compact number
      const valCharW = hasDevanagari(r.value) ? 0.75 : 0.60;
      const valueW = Math.max(120, Math.min(260, r.value.length * valueSize * valCharW));
      const availableLabelW = Math.max(180, inner - valueW - 35);
      const perLine = Math.max(6, Math.floor(availableLabelW / (rowSize * lblCharW)));
      const lines = wrapHeadline(r.label, perLine, 4);
      return { ...r, lines, icon, isMetric: true, h: Math.max(lines.length * lineH, iconSize) + Math.round(rowSize * 1.0) };
    } else {
      // Full-Width Item Card: tips, rules, mistakes, ideas wrap across the entire inner width
      const fullText = r.value && r.value !== r.label ? `${r.label} — ${r.value}` : r.label;
      const perLine = Math.max(10, Math.floor(inner / (rowSize * lblCharW)));
      const lines = wrapHeadline(fullText, perLine, 4);
      return { ...r, lines, icon, isMetric: false, h: Math.max(lines.length * lineH, iconSize) + Math.round(rowSize * 1.0) };
    }
  });

  const cardTop = ruleY + 60;
  const cardH = laid.reduce((sum, r) => sum + r.h, 0) + 36;
  let y = cardTop + 18;
  const rows = laid
    .map((r, i) => {
      const top = y;
      y += r.h;
      const base = top + Math.round(rowSize * 0.5) + lineH - Math.round(lineH * 0.2);
      const sep = i < laid.length - 1 ? `<line x1="100" x2="${CARD_W - 100}" y1="${y}" y2="${y}" stroke="${accent}" stroke-opacity="0.3" stroke-width="2"/>` : "";
      const label = r.lines
        .map((l, k) => `<text x="${textX}" y="${base + k * lineH}" font-family="${FONT}" font-size="${rowSize}" fill="#fff" fill-opacity="0.9">${esc(l)}</text>`)
        .join("");
      // the icon sits on the first line of the label
      const icon = iconSvg(r.icon, 100, base - Math.round(rowSize * 0.36) - iconSize / 2, iconSize, accent);
      const val = r.isMetric
        ? `<text x="${CARD_W - 100}" y="${base}" text-anchor="end" font-family="${FONT}" font-weight="700" font-size="${valueSize}" fill="${i >= laid.length - 2 ? accent : "#fff"}">${esc(r.value)}</text>`
        : "";
      return icon + label + val + sep;
    })
    .join("");

  const closingLines = c.closing ? wrapHeadline(c.closing, 34, 4) : [];
  const closingTop = cardTop + cardH + 80;
  const closing = closingLines
    .map((l, i) => `<text x="${CARD_W / 2}" y="${closingTop + i * 62}" text-anchor="middle" font-family="${FONT}" font-size="46" fill="#fff" fill-opacity="0.92">${esc(l)}</text>`)
    .join("");
  const blockTop = titleY0 - titleSize;
  const blockBottom = closingLines.length ? closingTop + (closingLines.length - 1) * 62 : cardTop + cardH;
  // taller than one screen: the card grows (with room for the footer) and the video pans down it
  const height = Math.max(CARD_H, blockBottom + 200);
  // fits on one screen: centre the block so a short card does not leave the lower half empty
  const shift = height === CARD_H ? Math.max(0, Math.round(CARD_H / 2 - (blockTop + blockBottom) / 2)) : 0;
  const foot = footer ? `<text x="${CARD_W / 2}" y="${height - 70}" text-anchor="middle" font-family="${FONT}" font-size="30" fill="#fff" fill-opacity="0.7">${esc(footer)}</text>` : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${height}">
<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${HERO_H}"><stop offset="0" stop-color="#050b1c" stop-opacity="0.28"/><stop offset="0.45" stop-color="#050b1c" stop-opacity="0.5"/><stop offset="1" stop-color="#050b1c" stop-opacity="0.97"/></linearGradient></defs>
<rect width="${CARD_W}" height="${height}" fill="url(#g)"/><g transform="translate(0,${shift})">${title}
<rect x="${CARD_W / 2 - 110}" y="${ruleY}" width="220" height="6" rx="3" fill="${accent}"/>
<rect x="60" y="${cardTop}" width="${CARD_W - 120}" height="${cardH}" rx="46" fill="#080e1e" fill-opacity="0.86" stroke="${accent}" stroke-width="3"/>${rows}${closing}</g>${foot}</svg>`;
  return { svg, height };
}

/** Height of the AI hero picture at the top of the card; below it the card fades into the brand's dark colour. */
export const HERO_H = 1400;

export function cardSvg(c: ListCardContent, accent: string, footer?: string): string {
  return cardLayout(c, accent, footer).svg;
}

export interface RenderCardOptions {
  footer?: string;
  /** a ready background (tests, or a picture already made); undefined = generate one with the AI providers */
  background?: Buffer | null;
}

/** The card as a 1080x1920 PNG. Uses HTML/Flexbox via Puppeteer for collision-free layout, falling back to SVG. */
export async function renderListCardPng(c: ListCardContent, brandKey: string, outPng: string, opts: RenderCardOptions = {}): Promise<string> {
  const brand = brandFor(brandKey);
  const prompt = `${c.image}. ${PICTURE_MOOD}. No text, no letters, no words, no logos, no watermark. vertical composition`;
  const bg = opts.background !== undefined ? opts.background : await generateBackgroundImage(prompt, CARD_W, CARD_H, c.image);

  try {
    return await renderListCardHtml(c, brand.accent, outPng, { heroBuffer: bg, footer: opts.footer });
  } catch (htmlErr: any) {
    pipelineLogger.warn(
      `HTML card render failed (${String(htmlErr?.message || htmlErr).slice(0, 200)}); falling back to SVG layout`,
      "ListCard"
    );
    const { svg, height } = cardLayout(c, brand.accent, opts.footer);
    // the AI picture is the hero at the top (behind the title); the rest of a tall card is the dark brand colour
    const base = bg
      ? sharp(await sharp({ create: { width: CARD_W, height, channels: 3, background: "#050b1c" } })
          .composite([{ input: await sharp(bg).resize(CARD_W, Math.min(height, HERO_H), { fit: "cover" }).toBuffer(), top: 0, left: 0 }])
          .png().toBuffer())
      : sharp(await sharp({ create: { width: CARD_W, height, channels: 3, background: brand.bg } })
          .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${height}"><defs><radialGradient id="r" cx="0.7" cy="0.15" r="0.8"><stop offset="0" stop-color="${brand.accent}" stop-opacity="0.45"/><stop offset="1" stop-color="${brand.accent}" stop-opacity="0"/></radialGradient></defs><rect width="${CARD_W}" height="${height}" fill="url(#r)"/></svg>`) }])
          .png().toBuffer());
    fs.mkdirSync(path.dirname(outPng), { recursive: true });
    await base.composite([{ input: Buffer.from(svg) }]).png().toFile(outPng);
    pipelineLogger.info(`List card (SVG fallback): "${c.title}", ${c.rows.length} rows`, "ListCard");
    return outPng;
  }
}

const MUSIC_DIR = path.join(__dirname, "../../assets/music-synth");
export const MUSIC_BEDS = ["bed_uplift", "bed_calm", "bed_drive", "bed_serious"] as const;

/** One of the synthesised beds, the same one for the same seed (a shortcode) so a re-run sounds the same. */
export function pickMusicBed(seed: string, dir = MUSIC_DIR): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const file = path.join(dir, `${MUSIC_BEDS[h % MUSIC_BEDS.length]}.m4a`);
  return fs.existsSync(file) ? file : path.join(dir, `${MUSIC_BEDS[0]}.m4a`);
}

/** Pan speed down a card taller than the screen, and the pauses at its top and bottom. */
const PAN_PX_PER_SEC = 140;
const PAN_HOLD_TOP = 1.5;
const PAN_HOLD_END = 2.0;

/** How long a card is shown: `seconds`, or longer when it is tall enough to need a pan down its whole length. */
export function stillReelSeconds(height: number, seconds = 6): number {
  if (height <= CARD_H) return seconds;
  return Math.max(seconds, Math.ceil((PAN_HOLD_TOP + (height - CARD_H) / PAN_PX_PER_SEC + PAN_HOLD_END) * 10) / 10);
}

/**
 * ffmpeg arguments, in HD (crf 16, the still-image tune, sharp lanczos scaling). A card of one screen gets a slow push-in;
 * a taller card pans down at a steady speed after a short hold on the title. Fades at both ends; the music loops to the
 * length at -16 LUFS.
 */
export function stillReelArgs(png: string, bed: string, out: string, seconds: number, height = CARD_H): string[] {
  const frames = Math.round(seconds * 30);
  const fo = Math.max(0, seconds - 0.4).toFixed(2);
  const af = Math.max(0, seconds - 0.9).toFixed(2);
  const motion = height > CARD_H
    ? `crop=w=${CARD_W}:h=${CARD_H}:x=0:y='min(ih-oh,max(0,(t-${PAN_HOLD_TOP})*${PAN_PX_PER_SEC}))'`
    : `scale=1296:2304:flags=lanczos,zoompan=z='1+0.05*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30`;
  return [
    "-y", "-loop", "1", "-framerate", "30", "-i", png, "-stream_loop", "-1", "-i", bed,
    "-filter_complex",
    `[0:v]${motion},fade=t=in:st=0:d=0.3,fade=t=out:st=${fo}:d=0.3,format=yuv420p[v];` +
      `[1:a]atrim=0:${seconds},asetpts=PTS-STARTPTS,afade=t=in:d=0.4,afade=t=out:st=${af}:d=0.8,loudnorm=I=-16:TP=-1.5:LRA=7,aformat=sample_rates=44100:channel_layouts=stereo[a]`,
    "-map", "[v]", "-map", "[a]", "-t", String(seconds), "-r", "30",
    "-c:v", "libx264", "-preset", "medium", "-tune", "stillimage", "-crf", "16", "-profile:v", "high",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
  ];
}

export async function renderStillReel(png: string, bed: string, out: string, seconds = 6): Promise<string> {
  const height = (await sharp(png).metadata()).height ?? CARD_H;
  const length = stillReelSeconds(height, seconds);
  return new Promise((resolve, reject) => {
    execFile(config.binaries.ffmpeg || "ffmpeg", stillReelArgs(png, bed, out, length, height), { maxBuffer: 16 * 1024 * 1024 }, (err, _so, se) =>
      err ? reject(new Error(`still reel: ${String(se).slice(-300) || err.message}`)) : resolve(out),
    );
  });
}
