import path from "path";
import type { VoiceboxLine } from "../../my-video/voiceboxNarration";
import { VOICE_PROFILES } from "../../my-video/voiceProfiles";

/** What scripts/omnivoice_runner.py speaks: see the docstring there. */
export interface OmniVoiceJob {
  tag: string;
  language: string;
  speed: number;
  format: "mp3" | "wav";
  sample: { file: string; start: number; end: number; text: string };
  characters: Record<string, string>;
  lines: VoiceboxLine[];
}

/**
 * Designed voices for the people in a story (Storiyum dialogue). The narrator always stays the channel's cloned voice;
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

/** The job for a channel: its cloned narrator voice (voiceProfiles.ts, CodeOrCap's when the channel has none) and the characters it uses. */
export function buildOmniVoiceJob(tag: string, lines: VoiceboxLine[], opts: { channelKey?: string; language?: string; speed?: string | number } = {}): OmniVoiceJob {
  const profile = VOICE_PROFILES[(opts.channelKey ?? "").trim().toLowerCase()] ?? VOICE_PROFILES.codeorcap;
  const spoken: VoiceboxLine[] = lines.map((l) => {
    const speaker = characterKey(l.speaker);
    const { speaker: _drop, ...rest } = l;
    return speaker ? { ...rest, speaker } : rest;
  });
  const used = new Set(spoken.map((l) => l.speaker).filter(Boolean) as string[]);
  return {
    tag,
    language: opts.language || "hi",
    speed: Number(opts.speed) || 1.0,
    format: "mp3",
    sample: {
      file: path.basename(profile.sample_path),
      start: Number(profile.sample_start) || 0,
      end: Number(profile.sample_end) || 15,
      text: profile.sample_text,
    },
    characters: Object.fromEntries([...used].map((k) => [k, CHARACTER_VOICES[k]])),
    lines: spoken,
  };
}
