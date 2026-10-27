import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { generateBackgroundImage, wrapHeadline } from "../cover/coverImage";
import { config } from "../config";
import { CARD_H, CARD_W, FONT, GLYPH, esc } from "../formats/listCard";
import { pipelineLogger } from "../utils/logger";
import type { MythScene, MythScript } from "./script";

/**
 * Renders a mythology Short: one painted picture per scene with a slow push-in, crossfades between scenes, film grain and a
 * vignette; the cloned voice made deeper and slower with a little hall reverb, over a low drone with a boom on the first frame.
 */
export const PAINTING_STYLE =
  "epic Indian mythological digital painting, cinematic composition, volumetric god rays, rich saffron, gold and deep indigo, " +
  "dramatic chiaroscuro, ancient India, highly detailed, painterly brush strokes";
const SAFFRON = "#ffb347";
/** seconds the next picture fades in over the end of the previous one */
export const XFADE = 0.5;
/** seconds of air after each spoken line */
const PAD = 0.35;

const run = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(config.binaries.ffmpeg || "ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 }, (err, _so, se) =>
      err ? reject(new Error(`ffmpeg: ${String(se).slice(-300) || err.message}`)) : resolve(),
    );
  });

/** The text layer of a scene: the caption low on the frame, and on the first scene the hook big in the upper third. */
export function mythSceneSvg(scene: MythScene, opts: { hook?: string; handle?: string } = {}): string {
  const lines = wrapHeadline(scene.caption, 18, 2);
  const size = Math.max(64, Math.min(92, Math.floor((CARD_W * 0.84) / (Math.max(...lines.map((l) => l.length), 1) * GLYPH))));
  const top = 1480;
  const caption = lines
    .map((l, i) => `<text x="${CARD_W / 2}" y="${top + i * Math.round(size * 1.3)}" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="${size}" fill="#fff6e0" stroke="#1a0b00" stroke-opacity="0.85" stroke-width="6" paint-order="stroke">${esc(l)}</text>`)
    .join("");
  let hook = "";
  if (opts.hook) {
    const hl = wrapHeadline(opts.hook, 12, 3);
    const hs = Math.max(96, Math.min(150, Math.floor((CARD_W * 0.88) / (Math.max(...hl.map((l) => l.length), 1) * GLYPH))));
    hook = hl
      .map((l, i) => `<text x="${CARD_W / 2}" y="${430 + i * Math.round(hs * 1.2)}" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="${hs}" fill="${SAFFRON}" stroke="#1a0b00" stroke-width="9" paint-order="stroke">${esc(l)}</text>`)
      .join("");
  }
  const foot = opts.handle
    ? `<text x="${CARD_W / 2}" y="${CARD_H - 70}" text-anchor="middle" font-family="${FONT}" font-size="30" fill="#fff" fill-opacity="0.55">${esc(opts.handle)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b0500" stop-opacity="${opts.hook ? 0.55 : 0.25}"/><stop offset="0.4" stop-color="#0b0500" stop-opacity="0"/><stop offset="0.68" stop-color="#0b0500" stop-opacity="0.35"/><stop offset="1" stop-color="#0b0500" stop-opacity="0.92"/></linearGradient></defs>
<rect width="${CARD_W}" height="${CARD_H}" fill="url(#g)"/>${hook}${caption}${foot}</svg>`;
}

/** The painting for a scene (no Pexels stock photo: a random photo breaks the spell more than a plain dark frame). */
export async function sceneFrame(scene: MythScene, outPng: string, opts: { hook?: string; handle?: string; background?: Buffer | null } = {}): Promise<string> {
  const prompt = `${scene.image}. ${PAINTING_STYLE}. No text, no letters, no words, no watermark. vertical composition`;
  const bg = opts.background !== undefined ? opts.background : await generateBackgroundImage(prompt, CARD_W, CARD_H);
  const base = bg
    ? sharp(bg).resize(CARD_W, CARD_H, { fit: "cover" })
    : sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}"><defs><radialGradient id="r" cx="0.5" cy="0.35" r="0.75"><stop offset="0" stop-color="#7a3b00"/><stop offset="1" stop-color="#0b0500"/></radialGradient></defs><rect width="${CARD_W}" height="${CARD_H}" fill="url(#r)"/></svg>`));
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  await base.composite([{ input: Buffer.from(mythSceneSvg(scene, opts)) }]).png().toFile(outPng);
  return outPng;
}

/** One silent scene clip: a slow push-in (or pull-out on odd scenes) with a gentle drift, so stills feel like a camera move. */
export function mythClipArgs(png: string, seconds: number, index: number, out: string): string[] {
  const frames = Math.max(1, Math.round(seconds * 30));
  const z = index % 2 ? `1.12-0.10*on/${frames}` : `1.02+0.10*on/${frames}`;
  const x = index % 3 === 1 ? `(iw-iw/zoom)*on/${frames}` : index % 3 === 2 ? `(iw-iw/zoom)*(1-on/${frames})` : `iw/2-(iw/zoom/2)`;
  return [
    "-y", "-loop", "1", "-framerate", "30", "-i", png,
    "-vf", `scale=1296:2304:flags=lanczos,zoompan=z='${z}':x='${x}':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30,format=yuv420p`,
    "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-an", out,
  ];
}

/**
 * Where each scene starts and how long its clip is. Clip i lasts d_i + XFADE and fades in XFADE before its line starts, so the
 * pictures change exactly as the voice moves on and the video is as long as the voice track.
 */
export function timeline(durations: number[]): { starts: number[]; clipLens: number[]; offsets: number[]; total: number } {
  const starts: number[] = [];
  let t = 0;
  for (const d of durations) {
    starts.push(t);
    t += d;
  }
  return { starts, clipLens: durations.map((d) => d + XFADE), offsets: starts.slice(1).map((s) => s - XFADE), total: t };
}

/** Deeper and a little slower (sample-rate drop of 5%: about one semitone), warmer low end, even level, a short hall. */
export const VOICE_FX =
  "aresample=44100,asetrate=41895,aresample=44100,equalizer=f=120:t=q:w=1.2:g=3,acompressor=threshold=-20dB:ratio=3:attack=8:release=220,aecho=0.8:0.55:60|130:0.2|0.1";

export interface RenderMythOptions {
  tempDir: string;
  out: string;
  /** the spoken line of each scene (mp3/wav), in scene order */
  voices: string[];
  handle?: string;
  /** tests: no AI pictures */
  noAi?: boolean;
}

const probeSec = (file: string): Promise<number> =>
  new Promise((resolve) => {
    execFile(config.binaries.ffprobe || "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], (e, so) =>
      resolve(e ? 0 : Number(String(so).trim()) || 0),
    );
  });

/** Pictures + processed voice + drone into one 1080x1920 mp4. Throws when a scene has no voice. */
export async function renderMythShort(script: MythScript, o: RenderMythOptions): Promise<string> {
  if (o.voices.length !== script.scenes.length) throw new Error(`voice lines ${o.voices.length} != scenes ${script.scenes.length}`);
  fs.mkdirSync(o.tempDir, { recursive: true });

  // 1. each line through the voice chain, then measured: the processed length decides the timing
  const lines: string[] = [];
  for (let i = 0; i < o.voices.length; i++) {
    const f = path.join(o.tempDir, `vx${i}.wav`);
    await run(["-y", "-i", o.voices[i], "-af", `${VOICE_FX},apad=pad_dur=${PAD}`, "-ac", "1", "-ar", "44100", f]);
    lines.push(f);
  }
  const durations: number[] = [];
  for (const f of lines) {
    const d = await probeSec(f);
    if (!(d > 0.6)) throw new Error(`a voice line is empty (${f})`);
    durations.push(d);
  }
  const tl = timeline(durations);

  // 2. pictures, two at a time (the providers are slow and rate limited)
  const pngs: string[] = new Array(script.scenes.length);
  for (let i = 0; i < script.scenes.length; i += 2) {
    await Promise.all([i, i + 1].filter((k) => k < script.scenes.length).map(async (k) => {
      pngs[k] = await sceneFrame(script.scenes[k], path.join(o.tempDir, `s${k}.png`), {
        hook: k === 0 ? script.hook : undefined, handle: o.handle, background: o.noAi ? null : undefined,
      });
    }));
  }

  // 3. moving clips, joined with crossfades, then grain + vignette over the whole film
  const clips: string[] = [];
  for (let i = 0; i < pngs.length; i++) {
    const c = path.join(o.tempDir, `c${i}.mp4`);
    await run(mythClipArgs(pngs[i], tl.clipLens[i], i, c));
    clips.push(c);
  }
  const n = clips.length;
  let chain = "";
  let last = "[0:v]";
  for (let i = 1; i < n; i++) {
    const outLabel = i === n - 1 ? "[xf]" : `[x${i}]`;
    chain += `${last}[${i}:v]xfade=transition=fade:duration=${XFADE}:offset=${tl.offsets[i - 1].toFixed(3)}${outLabel};`;
    last = outLabel;
  }
  if (n === 1) chain = "[0:v]null[xf];";
  const film = path.join(o.tempDir, "film.mp4");
  await run([
    "-y", ...clips.flatMap((c) => ["-i", c]),
    "-filter_complex", `${chain}[xf]noise=alls=7:allf=t,vignette=PI/4.6,fade=t=in:d=0.3,format=yuv420p[v]`,
    "-map", "[v]", "-t", tl.total.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-an", film,
  ]);

  // 4. sound: voice lines in a row over a low drone (two sines + brown noise, slowly breathing) and a boom on the first frame
  const T = tl.total.toFixed(3);
  const voiceIn = lines.flatMap((f) => ["-i", f]);
  const cat = `${lines.map((_, i) => `[${i + 1}:a]`).join("")}concat=n=${n}:v=0:a=1[voice]`;
  const drone =
    `sine=f=55:d=${T}[d1];sine=f=82.5:d=${T}[d2];anoisesrc=color=brown:amplitude=0.25:d=${T}[d3];` +
    `[d1][d2][d3]amix=inputs=3:normalize=0,lowpass=f=380,tremolo=f=0.12:d=0.35,volume=0.16,afade=t=in:d=1.2,afade=t=out:st=${Math.max(0, tl.total - 1.2).toFixed(2)}:d=1.2[bed];` +
    `sine=f=42:d=1.6,volume=0.9,afade=t=in:d=0.02,afade=t=out:st=0.15:d=1.4[boom]`;
  await run([
    "-y", "-i", film, ...voiceIn,
    "-filter_complex",
    `${cat};${drone};[bed][boom]amix=inputs=2:duration=first:normalize=0[music];` +
      `[voice]apad[vp];[vp][music]amix=inputs=2:duration=shortest:normalize=0,atrim=0:${T},loudnorm=I=-15:TP=-1.5:LRA=8,aformat=sample_rates=44100:channel_layouts=stereo[a]`,
    "-map", "0:v", "-map", "[a]", "-t", T, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", o.out,
  ]);
  pipelineLogger.info(`Mythology Short: ${n} scenes, ${tl.total.toFixed(1)}s`, "Mythology");
  return o.out;
}
