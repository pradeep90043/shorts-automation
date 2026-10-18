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
}

const off = (v: string | undefined): boolean => /^(off|false|0|no)$/i.test((v ?? "").trim());

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
  const run = async () => {
    const spoken = english ? lines : await toDevanagari(lines);
    if (!spoken) throw new Error("the Hindi text could not be prepared");
    return generateVoiceboxNarration({
      slug,
      lines: spoken,
      language: english ? "en" : "hi",
      speed: "1.0",
      inputs: { ...voiceInputsFor(profileKey), ...(english ? { denoise: "false" } : {}) },
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
      } as ClonedLineSet;
    })
    .catch((err) => {
      pipelineLogger.warn(`Cloned voice unavailable (${err instanceof Error ? err.message : err}) -> the normal voice is used`, "ClonedVoice");
      return null;
    });
}
