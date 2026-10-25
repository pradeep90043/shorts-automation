import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { brandFor, generateBackgroundImage, wrapHeadline } from "../cover/coverImage";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { CARD_H, CARD_W, FONT, GLYPH, PICTURE_MOOD, esc } from "./listCard";

/**
 * Format "image_voice": 4-6 scenes, each our own AI picture with a caption (and a big figure when the scene has one), spoken by the
 * channel voice over a quiet synthesised music bed. Nothing of the source reel's footage or audio is used, only its facts.
 */
export interface VoiceScene {
  narration: string;
  caption: string;
  image: string;
  /** a number or short fact shown big, e.g. "₹5-15 lakh" */
  stat?: string;
}
export interface ImageVoicePlan {
  title: string;
  scenes: VoiceScene[];
}

const clip = (s: unknown, max: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function imageVoicePrompt(material: string, hindi: boolean): string {
  return (
    `From the MATERIAL below (the text of a short video) write a 30-second vertical video as 4 to 6 scenes in ${hindi ? "Hindi written in Devanagari script (numbers as words in the narration, as digits in captions)" : "English"}. ` +
    `Use the facts and numbers of the material in your own wording; NEVER invent a number, price or claim that is not in the material. Ignore calls to action in the material (follow, subscribe, comment, DM, link in bio, join a list): they are not facts. ` +
    `Answer with JSON only: {"title": hook of at most 55 characters, "scenes": [{"narration": one spoken sentence of at most 18 words, ` +
    `"caption": the same idea in at most 60 characters, "image": a photo scene in English, no text, no people's faces, ` +
    `"stat": optional, the number or short fact of this scene in at most 14 characters}]}. The first scene is the hook, the last is the takeaway.\n\nMATERIAL:\n${material.slice(0, 1800)}\n/no_think`
  );
}

export function parseImageVoice(raw: string): ImageVoicePlan | null {
  const m = /\{[\s\S]*\}/.exec(raw || "");
  if (!m) return null;
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const scenes: VoiceScene[] = (Array.isArray(j?.scenes) ? j.scenes : [])
    .map((s: any) => ({ narration: clip(s?.narration, 220), caption: clip(s?.caption, 70), image: clip(s?.image, 200), stat: clip(s?.stat, 16) || undefined }))
    .filter((s: VoiceScene) => s.narration && s.caption)
    .slice(0, 6)
    .map((s: VoiceScene) => ({ ...s, image: s.image || s.caption }));
  const title = clip(j?.title, 60);
  if (!title || scenes.length < 3) return null;
  return { title, scenes };
}

export function sceneSvg(scene: VoiceScene, accent: string, footer?: string): string {
  const capLines = wrapHeadline(scene.caption, 24, 4);
  const capSize = Math.max(54, Math.min(74, Math.floor((CARD_W * 0.86) / (Math.max(...capLines.map((l) => l.length), 1) * GLYPH))));
  const capTop = 1400;
  const caption = capLines
    .map((l, i) => `<text x="${CARD_W / 2}" y="${capTop + i * Math.round(capSize * 1.3)}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${capSize}" fill="#fff" stroke="#000" stroke-opacity="0.5" stroke-width="3" paint-order="stroke">${esc(l)}</text>`)
    .join("");
  let stat = "";
  if (scene.stat) {
    const size = Math.max(70, Math.min(150, Math.floor((CARD_W * 0.78) / (scene.stat.length * GLYPH))));
    const w = Math.min(CARD_W - 120, Math.round(scene.stat.length * GLYPH * size) + 120);
    stat = `<rect x="${(CARD_W - w) / 2}" y="640" width="${w}" height="${size + 90}" rx="44" fill="#080e1e" fill-opacity="0.84" stroke="${accent}" stroke-width="3"/>` +
      `<text x="${CARD_W / 2}" y="${640 + 45 + size * 0.82}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${size}" fill="${accent}">${esc(scene.stat)}</text>`;
  }
  const foot = footer ? `<text x="${CARD_W / 2}" y="${CARD_H - 70}" text-anchor="middle" font-family="${FONT}" font-size="28" fill="#fff" fill-opacity="0.6">${esc(footer)}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#050b1c" stop-opacity="0.35"/><stop offset="0.5" stop-color="#050b1c" stop-opacity="0.1"/><stop offset="0.72" stop-color="#050b1c" stop-opacity="0.7"/><stop offset="1" stop-color="#050b1c" stop-opacity="0.95"/></linearGradient></defs>
<rect width="${CARD_W}" height="${CARD_H}" fill="url(#g)"/>${stat}${caption}${foot}</svg>`;
}

/** A 1080x1920 PNG for the scene: the AI picture (or the brand gradient when every provider failed) with caption and figure. */
export async function renderSceneFrame(scene: VoiceScene, brandKey: string, outPng: string, opts: { footer?: string; background?: Buffer | null } = {}): Promise<string> {
  const brand = brandFor(brandKey);
  const prompt = `${scene.image}. ${PICTURE_MOOD}. No text, no letters, no words, no logos, no watermark. vertical composition`;
  const bg = opts.background !== undefined ? opts.background : await generateBackgroundImage(prompt, CARD_W, CARD_H, scene.image);
  const base = bg
    ? sharp(bg).resize(CARD_W, CARD_H, { fit: "cover" })
    : sharp(await sharp({ create: { width: CARD_W, height: CARD_H, channels: 3, background: brand.bg } })
        .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}"><defs><radialGradient id="r" cx="0.7" cy="0.3" r="0.8"><stop offset="0" stop-color="${brand.accent}" stop-opacity="0.45"/><stop offset="1" stop-color="${brand.accent}" stop-opacity="0"/></radialGradient></defs><rect width="${CARD_W}" height="${CARD_H}" fill="url(#r)"/></svg>`) }])
        .png().toBuffer());
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  await base.composite([{ input: Buffer.from(sceneSvg(scene, brand.accent, opts.footer)) }]).png().toFile(outPng);
  return outPng;
}

/** ffmpeg arguments for one silent scene clip: a push-in (alternating in/out per scene) with no fade, so scenes cut cleanly. */
export function sceneClipArgs(png: string, seconds: number, index: number, out: string): string[] {
  const frames = Math.max(1, Math.round(seconds * 30));
  const z = index % 2 ? `1.06-0.06*on/${frames}` : `1+0.06*on/${frames}`;
  return [
    "-y", "-loop", "1", "-framerate", "30", "-i", png,
    "-vf", `scale=1296:2304:flags=lanczos,zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30,format=yuv420p`,
    "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-an", out,
  ];
}

const run = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(config.binaries.ffmpeg || "ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 }, (err, _so, se) =>
      err ? reject(new Error(`ffmpeg: ${String(se).slice(-300) || err.message}`)) : resolve(),
    );
  });

export interface RenderImageVoiceOptions {
  brandKey: string;
  tempDir: string;
  /** writes the spoken text to `file` and returns its length in seconds (the channel's TTS) */
  tts: (text: string, file: string) => Promise<number>;
  bed: string;
  out: string;
  footer?: string;
  /** tests: skip the AI pictures */
  noAi?: boolean;
}

const PAD = 0.4; // seconds of air after each sentence

/** Voice + pictures + music into one 1080x1920 mp4. Throws when no scene can be built (the caller falls back to another format). */
export async function renderImageVoice(plan: ImageVoicePlan, o: RenderImageVoiceOptions): Promise<string> {
  fs.mkdirSync(o.tempDir, { recursive: true });
  const voices: Array<{ file: string; sec: number }> = [];
  for (let i = 0; i < plan.scenes.length; i++) {
    const file = path.join(o.tempDir, `v${i}.mp3`);
    const sec = await o.tts(plan.scenes[i].narration, file);
    if (!(sec > 0.5) || !fs.existsSync(file)) throw new Error(`no voice for scene ${i + 1}`);
    voices.push({ file, sec });
  }
  // pictures two at a time: the providers are slow and rate limited, not CPU bound
  const pngs: string[] = new Array(plan.scenes.length);
  for (let i = 0; i < plan.scenes.length; i += 2) {
    await Promise.all([i, i + 1].filter((k) => k < plan.scenes.length).map(async (k) => {
      pngs[k] = await renderSceneFrame(plan.scenes[k], o.brandKey, path.join(o.tempDir, `s${k}.png`), { footer: o.footer, background: o.noAi ? null : undefined });
    }));
  }
  const clips: string[] = [];
  for (let i = 0; i < plan.scenes.length; i++) {
    const clip = path.join(o.tempDir, `c${i}.mp4`);
    await run(sceneClipArgs(pngs[i], voices[i].sec + PAD, i, clip));
    clips.push(clip);
  }
  const list = path.join(o.tempDir, "clips.txt");
  fs.writeFileSync(list, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n"));
  const silent = path.join(o.tempDir, "silent.mp4");
  await run(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent]);

  const total = voices.reduce((t, v) => t + v.sec + PAD, 0);
  const inputs = voices.flatMap((v) => ["-i", v.file]);
  const n = voices.length;
  const pads = voices.map((_v, i) => `[${i + 1}:a]aresample=44100,aformat=channel_layouts=mono,apad=pad_dur=${PAD}[p${i}]`).join(";");
  const cat = `${voices.map((_, i) => `[p${i}]`).join("")}concat=n=${n}:v=0:a=1[voice]`;
  const fade = Math.max(0, total - 0.9).toFixed(2);
  await run([
    "-y", "-i", silent, ...inputs, "-stream_loop", "-1", "-i", o.bed,
    "-filter_complex",
    `${pads};${cat};[${n + 1}:a]atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,volume=0.22,afade=t=in:d=0.4,afade=t=out:st=${fade}:d=0.8,aformat=channel_layouts=mono[bed];` +
      `[voice][bed]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=7,aformat=sample_rates=44100:channel_layouts=stereo[a]`,
    "-map", "0:v", "-map", "[a]", "-t", total.toFixed(2), "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", o.out,
  ]);
  pipelineLogger.info(`Image+voice Short: ${plan.scenes.length} scenes, ${total.toFixed(1)}s`, "ImageVoice");
  return o.out;
}
