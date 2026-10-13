import fs from "fs";
import path from "path";
import { pipelineLogger } from "../utils/logger";
import { generateVoiceboxNarration, type VoiceboxLine } from "../my-video/voiceboxNarration";

/**
 * One cloned voice for a whole Short (English for CodeOrCap, Hindi for Storiyum): the claim narration, the "how it works" lines and (from fixed assets)
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

/**
 * Which cloned voice a channel speaks with: the language of its scripts and the voicebox-scenes.yml inputs that pick the sample.
 * CodeOrCap uses the workflow's default sample (the owner's verdict clip); Storiyum uses its own 15 s sample, which is
 * transcribed automatically and spoken in Hindi.
 */
export interface ClonedVoiceProfile {
  language: string;
  inputs: Record<string, string>;
}

const PROFILES: Record<string, ClonedVoiceProfile> = {
  // no denoise: the user compared 4 variants against their own voice and the undenoised one (turbo, 1.0x) sounded closest
  codeorcap: { language: "en", inputs: { denoise: "false" } },
  storiyum: {
    language: "hi",
    inputs: {
      voice: "storiyum",
      sample_path: "assets/voice-samples/storiyum_female.mp3",
      sample_start: "0",
      sample_end: "15",
      sample_text: "auto",
      sample_language: "",
      denoise: "true",
    },
  },
};

export function clonedVoiceProfile(profileKey: string): ClonedVoiceProfile | undefined {
  return PROFILES[profileKey.toLowerCase()];
}

export function clonedVoiceEnabled(profileKey: string): boolean {
  if (off(process.env.CLONED_VOICE)) return false;
  if (!clonedVoiceProfile(profileKey)) return false;
  return Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
}

/** Never rejects: null = use the normal voice. */
export function startClonedLines(slug: string, lines: VoiceboxLine[], profileKey = "codeorcap"): Promise<ClonedLineSet | null> {
  const voice = clonedVoiceProfile(profileKey) ?? PROFILES.codeorcap;
  const timeoutMin = Number(process.env.CLONED_VOICE_TIMEOUT_MIN) || 20;
  const started = Date.now();
  pipelineLogger.info(`Cloned voice: ${lines.length} line(s) -> GitHub Actions (give up after ${timeoutMin} min)`, "ClonedVoice");
  return generateVoiceboxNarration({ slug, lines, language: voice.language, speed: "1.0", inputs: voice.inputs, giveUpMs: timeoutMin * 60_000 })
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
