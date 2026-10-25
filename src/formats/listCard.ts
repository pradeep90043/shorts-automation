import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { brandFor, generateBackgroundImage, wrapHeadline } from "../cover/coverImage";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";

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

const clip = (s: unknown, max: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The prompt that turns a source reel's text into a list card. `hindi` = Devanagari wording (all channels but CodeOrCap). */
export function listCardPrompt(material: string, hindi: boolean): string {
  return (
    `From the MATERIAL below (the text of a short video) make a LIST CARD in ${hindi ? "Hindi written in Devanagari script (numbers as digits)" : "English"}. ` +
    `Use the facts and numbers of the material but write your own wording; NEVER invent a number, price or claim that is not in the material. ` +
    `Answer with JSON only: {"title": hook of at most 55 characters that contains the main number or promise, ` +
    `"rows": 4 to 7 objects {"label": at most 24 characters, "value": at most 20 characters, the number or short fact}, ` +
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
    .map((r: any) => ({ label: clip(r?.label, 26), value: clip(r?.value, 22) }))
    .filter((r: { label: string; value: string }) => r.label && r.value)
    .slice(0, 7);
  if (!title || rows.length < 3) return null;
  return { title, rows, closing: clip(j?.closing, 100) || undefined, image: clip(j?.image, 200) || title };
}

/** "label :- value" / "label: value" lines of an OCR text (what a static list card Short looks like), when the LLM is unavailable. */
export function listCardFromLines(text: string, title: string): ListCardContent | null {
  const rows: Array<{ label: string; value: string }> = [];
  for (const line of (text || "").split(/\n+/)) {
    const m = /^\s*([^:]{2,40}?)\s*(?::-|:|–|—)\s*(.{1,30})$/.exec(line);
    if (m) rows.push({ label: clip(m[1], 26), value: clip(m[2], 22) });
  }
  if (rows.length < 3) return null;
  return { title: clip(title, 60) || "Quick facts", rows: rows.slice(0, 7), image: clip(title, 200) || "a clean modern workspace" };
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const FONT = "Noto Sans, Noto Sans Devanagari, DejaVu Sans, Arial, Helvetica, sans-serif";
/** average glyph width as a share of the font size (Devanagari and bold Latin are wide; the font differs per machine) */
export const GLYPH = 0.62;
export const CARD_W = 1080;
export const CARD_H = 1920;

export function cardSvg(c: ListCardContent, accent: string, footer?: string): string {
  const titleLines = wrapHeadline(c.title, 20, 3);
  const titleSize = Math.max(64, Math.min(96, Math.floor((CARD_W * 0.88) / (Math.max(...titleLines.map((l) => l.length), 1) * GLYPH))));
  const titleY0 = 230;
  const titleH = Math.round(titleSize * 1.2);
  const title = titleLines
    .map((l, i) => `<text x="${CARD_W / 2}" y="${titleY0 + i * titleH}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${titleSize}" fill="${i === 0 ? accent : "#fff"}" stroke="#000" stroke-opacity="0.45" stroke-width="3" paint-order="stroke">${esc(l)}</text>`)
    .join("");
  const ruleY = titleY0 + (titleLines.length - 1) * titleH + 44;

  const maxLabel = Math.max(...c.rows.map((r) => r.label.length), 1);
  const maxValue = Math.max(...c.rows.map((r) => r.value.length), 1);
  const rowSize = Math.max(34, Math.min(52, Math.floor((CARD_W - 200) / ((maxLabel + maxValue + 2) * GLYPH))));
  const rowH = Math.round(rowSize * 2.3);
  const cardTop = ruleY + 60;
  const cardH = c.rows.length * rowH + 36;
  const rows = c.rows
    .map((r, i) => {
      const y = cardTop + 18 + i * rowH + Math.round(rowH * 0.62);
      const sep = i < c.rows.length - 1 ? `<line x1="100" x2="${CARD_W - 100}" y1="${cardTop + 18 + (i + 1) * rowH}" y2="${cardTop + 18 + (i + 1) * rowH}" stroke="${accent}" stroke-opacity="0.3" stroke-width="2"/>` : "";
      return `<text x="100" y="${y}" font-family="${FONT}" font-size="${rowSize}" fill="#fff" fill-opacity="0.9">${esc(r.label)}</text>` +
        `<text x="${CARD_W - 100}" y="${y}" text-anchor="end" font-family="${FONT}" font-weight="700" font-size="${Math.round(rowSize * 1.12)}" fill="${i >= c.rows.length - 2 ? accent : "#fff"}">${esc(r.value)}</text>${sep}`;
    })
    .join("");

  const closingLines = c.closing ? wrapHeadline(c.closing, 34, 3) : [];
  const closingTop = cardTop + cardH + 80;
  const closing = closingLines
    .map((l, i) => `<text x="${CARD_W / 2}" y="${closingTop + i * 62}" text-anchor="middle" font-family="${FONT}" font-size="46" fill="#fff" fill-opacity="0.92">${esc(l)}</text>`)
    .join("");
  // centre the whole block in the safe area: a card of 4 rows must not leave the lower half of the frame empty
  const blockTop = titleY0 - titleSize;
  const blockBottom = closingLines.length ? closingTop + (closingLines.length - 1) * 62 : cardTop + cardH;
  const shift = Math.max(0, Math.round(CARD_H / 2 - (blockTop + blockBottom) / 2));
  const foot = footer ? `<text x="${CARD_W / 2}" y="${CARD_H - 70}" text-anchor="middle" font-family="${FONT}" font-size="28" fill="#fff" fill-opacity="0.6">${esc(footer)}</text>` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#050b1c" stop-opacity="0.55"/><stop offset="0.45" stop-color="#050b1c" stop-opacity="0.66"/><stop offset="1" stop-color="#050b1c" stop-opacity="0.95"/></linearGradient></defs>
<rect width="${CARD_W}" height="${CARD_H}" fill="url(#g)"/><g transform="translate(0,${shift})">${title}
<rect x="${CARD_W / 2 - 110}" y="${ruleY}" width="220" height="6" rx="3" fill="${accent}"/>
<rect x="60" y="${cardTop}" width="${CARD_W - 120}" height="${cardH}" rx="46" fill="#080e1e" fill-opacity="0.86" stroke="${accent}" stroke-width="3"/>${rows}${closing}</g>${foot}</svg>`;
}

export interface RenderCardOptions {
  footer?: string;
  /** a ready background (tests, or a picture already made); undefined = generate one with the AI providers */
  background?: Buffer | null;
}

/** The card as a 1080x1920 PNG. A failed AI picture only means a branded gradient behind the same layout. */
export async function renderListCardPng(c: ListCardContent, brandKey: string, outPng: string, opts: RenderCardOptions = {}): Promise<string> {
  const brand = brandFor(brandKey);
  const prompt = `${brand.style}, ${c.image}. No text, no letters, no words, no logos, no watermark. vertical composition`;
  const bg = opts.background !== undefined ? opts.background : await generateBackgroundImage(prompt, CARD_W, CARD_H, c.image);
  const base = bg
    ? sharp(bg).resize(CARD_W, CARD_H, { fit: "cover" })
    : sharp(await sharp({ create: { width: CARD_W, height: CARD_H, channels: 3, background: brand.bg } })
        .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}"><defs><radialGradient id="r" cx="0.7" cy="0.25" r="0.8"><stop offset="0" stop-color="${brand.accent}" stop-opacity="0.45"/><stop offset="1" stop-color="${brand.accent}" stop-opacity="0"/></radialGradient></defs><rect width="${CARD_W}" height="${CARD_H}" fill="url(#r)"/></svg>`) }])
        .png().toBuffer());
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  await base.composite([{ input: Buffer.from(cardSvg(c, brand.accent, opts.footer)) }]).png().toFile(outPng);
  pipelineLogger.info(`List card (${bg ? "AI picture" : "branded background"}): "${c.title}", ${c.rows.length} rows`, "ListCard");
  return outPng;
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

/** ffmpeg arguments: a slow push-in on the card, a short fade at both ends, the music fitted to the length at -16 LUFS. */
export function stillReelArgs(png: string, bed: string, out: string, seconds: number): string[] {
  const frames = Math.round(seconds * 30);
  const fo = Math.max(0, seconds - 0.4).toFixed(2);
  const af = Math.max(0, seconds - 0.9).toFixed(2);
  return [
    "-y", "-loop", "1", "-framerate", "30", "-i", png, "-i", bed,
    "-filter_complex",
    `[0:v]scale=1296:2304:flags=lanczos,zoompan=z='1+0.05*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30,fade=t=in:st=0:d=0.3,fade=t=out:st=${fo}:d=0.3,format=yuv420p[v];` +
      `[1:a]atrim=0:${seconds},asetpts=PTS-STARTPTS,afade=t=in:d=0.4,afade=t=out:st=${af}:d=0.8,loudnorm=I=-16:TP=-1.5:LRA=7,aformat=sample_rates=44100:channel_layouts=stereo[a]`,
    "-map", "[v]", "-map", "[a]", "-t", String(seconds), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out,
  ];
}

export function renderStillReel(png: string, bed: string, out: string, seconds = 6): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(config.binaries.ffmpeg || "ffmpeg", stillReelArgs(png, bed, out, seconds), { maxBuffer: 16 * 1024 * 1024 }, (err, _so, se) =>
      err ? reject(new Error(`still reel: ${String(se).slice(-300) || err.message}`)) : resolve(out),
    );
  });
}
