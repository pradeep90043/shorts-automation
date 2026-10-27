import path from "path";
import type { VoiceboxLine } from "../../my-video/voiceboxNarration";
import { VOICE_PROFILES } from "../../my-video/voiceProfiles";

/** What scripts/omnivoice_runner.py speaks: see the docstring there. */
export interface OmniVoiceJob {
  tag: string;
  language: string;
  speed: number;
  format: "mp3" | "wav";
  /** a cloned narrator: the channel's voice sample (VOICE_CLONE=on only) */
  sample?: { file: string; start: number; end: number; text: string };
  /** a designed narrator (the default): OmniVoice voice-design attributes, made the same way in every run (fixed seed) */
  narrator?: string;
  characters: Record<string, string>;
  lines: VoiceboxLine[];
}

/**
 * Each channel's narrator: a generic designed voice (no cloned recording, so none of a recording's hiss). NARRATOR_VOICE_<CHANNEL>
 * (e.g. NARRATOR_VOICE_STORIYUM="female, middle-aged, indian accent") replaces one.
 */
export const NARRATOR_VOICES: Record<string, string> = {
  storiyum: "male, middle-aged, low pitch, indian accent",
  codeorcap: "male, young adult, indian accent",
  prompt_gag: "male, middle-aged, indian accent",
  infoonspot: "female, young adult, indian accent",
};

export function narratorVoiceFor(channelKey?: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = (channelKey ?? "").trim().toLowerCase();
  return (env[`NARRATOR_VOICE_${key.toUpperCase()}`] ?? "").trim() || NARRATOR_VOICES[key] || NARRATOR_VOICES.codeorcap;
}

/** The cloned voices (voiceProfiles.ts) are off by default: the clones carried the samples' background hiss. VOICE_CLONE=on brings them back. */
export const cloneVoices = (env: NodeJS.ProcessEnv = process.env): boolean => /^(on|true|1|yes)$/i.test((env.VOICE_CLONE ?? "").trim());

/**
 * Designed voices for the people in a story (Storiyum dialogue). The narrator stays the channel's narrator voice;
 * a line with one of these speakers is spoken in that character's voice. Values are OmniVoice voice-design attributes.
 */
export const CHARACTER_VOICES: Record<string, string> = {
  boy: "male, child, high pitch, indian accent",
  girl: "female, child, high pitch, indian accent",
  child: "male, child, high pitch, indian accent",
  young_man: "male, young adult, indian accent",
  young_woman: "female, young adult, indian accent",
  man: "male, middle-aged, low pitch, indian accent",
  woman: "female, middle-aged, indian accent",
  mother: "female, middle-aged, indian accent",
  father: "male, middle-aged, low pitch, indian accent",
  old_man: "male, elderly, low pitch, indian accent",
  old_woman: "female, elderly, indian accent",
  old_mother: "female, elderly, indian accent",
};

/** A speaker name as the scripts write it ("Old Mother", "old-mother") -> its key, or undefined for the narrator / unknown names. */
export function characterKey(speaker?: string): string | undefined {
  const k = (speaker ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return k && k !== "narrator" && CHARACTER_VOICES[k] ? k : undefined;
}

/** The job for a channel: its designed narrator (or, with VOICE_CLONE=on, its cloned voice from voiceProfiles.ts) and the characters it uses. */
export function buildOmniVoiceJob(
  tag: string,
  lines: VoiceboxLine[],
  opts: { channelKey?: string; language?: string; speed?: string | number } = {},
  env: NodeJS.ProcessEnv = process.env,
): OmniVoiceJob {
  const spoken: VoiceboxLine[] = lines.map((l) => {
    const speaker = characterKey(l.speaker);
    const { speaker: _drop, ...rest } = l;
    return speaker ? { ...rest, speaker } : rest;
  });
  const used = new Set(spoken.map((l) => l.speaker).filter(Boolean) as string[]);
  const base = {
    tag,
    language: opts.language || "hi",
    speed: Number(opts.speed) || 1.0,
    format: "mp3" as const,
    characters: Object.fromEntries([...used].map((k) => [k, CHARACTER_VOICES[k]])),
    lines: spoken,
  };
  if (!cloneVoices(env)) return { ...base, narrator: narratorVoiceFor(opts.channelKey, env) };
  const profile = VOICE_PROFILES[(opts.channelKey ?? "").trim().toLowerCase()] ?? VOICE_PROFILES.codeorcap;
  return {
    ...base,
    sample: {
      file: path.basename(profile.sample_path),
      start: Number(profile.sample_start) || 0,
      end: Number(profile.sample_end) || 15,
      text: profile.sample_text,
    },
  };
}
