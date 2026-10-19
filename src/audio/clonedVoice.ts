import fs from "fs";
import path from "path";
import { pipelineLogger } from "../utils/logger";
import { generateVoiceboxNarration, type VoiceboxLine } from "../my-video/voiceboxNarration";
import { voiceInputsFor } from "../my-video/voiceProfiles";
import { makeAsk } from "../longvideo-auto/llm";

/**
 * One cloned English voice for a whole CodeOrCap Short: the claim narration, the "how it works" lines and (from fixed assets)
 * the verdict. The variable lines are spoken on GitHub Actions (voicebox-scenes.yml, one runner, ~6-9 minutes including its
 * start-up) in ONE batch per Short, started as soon as the metadata exists so it runs while the reel is rendered.
 * Anything that goes wrong (no token, run failed, too slow) resolves to null and the caller keeps the Edge voice and the
 * recorded verdict audio, so a Short is never blocked by the cloud.
 */
export interface ClonedLineSet {
  dir: string;
  /** the mp3 of a line, or undefined when it is missing */
  file(name: string): string | undefined;
  /** the text of a line exactly as it was spoken (Devanagari on the Hindi channels), for captions */
  spokenText(name: string): string | undefined;
}

const off = (v: string | undefined): boolean => /^(off|false|0|no)$/i.test((v ?? "").trim());

/**
 * A long line is spoken in pieces: one runner speaking ~1,000 characters takes ~14 minutes on a CPU runner, right at the 15-minute
 * limit of a single speak call (it failed by a hair on a slower runner). The speaking is the slow part (400-960 s per 250-char piece
 * measured against ~130-240 s of fixed set-up), so pieces are ~150 characters: more runners, each much shorter. Whole sentences, packed up to `max` characters; a
 * sentence longer than that is cut at a comma, then a space. The pieces run on separate runners and are joined again.
 */
export function splitForVoice(text: string, max = Number(process.env.VOICE_PIECE_CHARS) || 150): string[] {
  const sentences = text.split(/(?<=[.!?।॥])\s+/).map((x) => x.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= max) { pieces.push(sentence); continue; }
    let cur = "";
    for (const part of sentence.split(/(?<=[,;:])\s+|\s+/)) {
      if (cur && cur.length + 1 + part.length > max) { pieces.push(cur); cur = part; } else cur = cur ? cur + " " + part : part;
    }
    if (cur) pieces.push(cur);
  }
  const out: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur && cur.length + 1 + piece.length > max) { out.push(cur); cur = piece; } else cur = cur ? cur + " " + piece : piece;
  }
  if (cur) out.push(cur);
  // a tiny last piece is merged into the one before it
  if (out.length > 1 && out[out.length - 1].length < 40) { const last = out.pop()!; out[out.length - 1] += " " + last; }
  return out;
}

/** Text as the voice should read it: no emoji, links, hashtags, mentions or markdown marks, one line. */
export function spokenText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@]\w+/g, " ")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, " ")
    .replace(/[*_`~>|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function clonedVoiceEnabled(profileKey: string): boolean {
  if (off(process.env.CLONED_VOICE)) return false;
  if (Object.keys(voiceInputsFor(profileKey)).length === 0) return false; // the channel has no cloned voice (see voiceProfiles.ts)
  return Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
}

/**
 * The Hindi voice reads Devanagari: the Shorts scripts of the other channels are Hinglish in the English alphabet, which it would spell
 * out letter by letter. One LLM call writes every line as it is spoken (English terms stay recognisable, in Devanagari). null = could not.
 */
const hasDevanagari = (t: string): boolean => /[\u0900-\u097F]/.test(t);

/**
 * One line to Devanagari, as plain text. Free models truncate a long JSON answer (Devanagari costs many tokens) or answer in
 * chain-of-thought prose; a short one-line answer survives both: only the lines that contain Devanagari are kept.
 */
export function devanagariFromAnswer(raw: string): string {
  return raw
    .split(/\n+/)
    .map((l) => l.replace(/^[\s"'`*\-•\d.)]+|["'`\s]+$/g, "").trim())
    .filter((l) => hasDevanagari(l))
    .join(" ")
    .trim();
}

async function lineToDevanagari(text: string, ask: (p: string) => Promise<string>): Promise<string | null> {
  if (hasDevanagari(text) || !/[A-Za-z]/.test(text)) return text; // already Devanagari, or a bare figure
  const prompt =
    `Rewrite this Hinglish text (Hindi written in the English alphabet) in Devanagari exactly as it is spoken, for a text-to-speech voice. ` +
    `Keep the meaning and every word; write English words in Devanagari too (e.g. "video" -> "वीडियो"); keep numbers and punctuation. ` +
    `Return ONLY the Devanagari text, nothing else.\n\n${text}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const out = devanagariFromAnswer(await ask(prompt));
      if (out.length >= Math.min(8, text.length / 3)) return out;
      pipelineLogger.warn(`Hindi text for one line, attempt ${attempt}/3: answer had no usable Devanagari`, "ClonedVoice");
    } catch (err) {
      pipelineLogger.warn(`Hindi text for one line, attempt ${attempt}/3: ${err instanceof Error ? err.message : err}`, "ClonedVoice");
    }
  }
  return null;
}

/**
 * The Hindi voice reads Devanagari: the Shorts scripts of the other channels are Hinglish in the English alphabet, which it would spell
 * out letter by letter. Each line is converted in its own small call (in parallel). null = a line could not be converted.
 */
export async function toDevanagari(lines: VoiceboxLine[], ask = makeAsk({ timeoutMs: 75_000, hedgeMs: 15_000 })): Promise<VoiceboxLine[] | null> {
  const out = await Promise.all(lines.map((l) => lineToDevanagari(l.text, ask)));
  if (out.some((t) => t === null)) return null;
  return lines.map((l, i) => ({ name: l.name, text: out[i] as string }));
}

/**
 * Never rejects: null = use the normal voice. CodeOrCap speaks English; every other channel with a cloned voice speaks Hindi.
 */
export function startClonedLines(slug: string, lines: VoiceboxLine[], profileKey = "codeorcap"): Promise<ClonedLineSet | null> {
  const timeoutMin = Number(process.env.CLONED_VOICE_TIMEOUT_MIN) || 20;
  const started = Date.now();
  const english = profileKey.toLowerCase() === "codeorcap";
  pipelineLogger.info(`Cloned voice (${profileKey}): ${lines.length} line(s) -> GitHub Actions (give up after ${timeoutMin} min)`, "ClonedVoice");
  // English: no denoise (the user compared 4 variants against their own voice and the undenoised one (turbo, 1.0x) sounded closest)
  let spokenLines: VoiceboxLine[] = lines;
  const run = async () => {
    const spoken = english ? lines : await toDevanagari(lines);
    if (!spoken) throw new Error("the Hindi text could not be prepared");
    spokenLines = spoken;
    return generateVoiceboxNarration({
      slug,
      lines: spoken,
      language: english ? "en" : "hi",
      speed: "1.0",
      inputs: { ...voiceInputsFor(profileKey), shard_chars: process.env.VOICE_SHARD_CHARS || "150", ...(english ? { denoise: "false" } : {}) },
      giveUpMs: timeoutMin * 60_000,
    });
  };
  return run()
    .then((r) => {
      pipelineLogger.info(`Cloned voice ready in ${Math.round((Date.now() - started) / 1000)}s`, "ClonedVoice");
      return {
        dir: r.dir,
        file: (name: string) => {
          const f = path.join(r.dir, `${name}.mp3`);
          return fs.existsSync(f) ? f : undefined;
        },
        spokenText: (name: string) => {
          const exact = spokenLines.find((l) => l.name === name);
          if (exact) return exact.text;
          const parts = spokenLines.filter((l) => l.name.startsWith(name + "_")).sort((x, y) => Number(x.name.split("_").pop()) - Number(y.name.split("_").pop()));
          return parts.length ? parts.map((l) => l.text).join(" ") : undefined;
        },
      } as ClonedLineSet;
    })
    .catch((err) => {
      pipelineLogger.warn(`Cloned voice unavailable (${err instanceof Error ? err.message : err}) -> the normal voice is used`, "ClonedVoice");
      return null;
    });
}
