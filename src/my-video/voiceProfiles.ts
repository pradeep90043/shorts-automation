/**
 * Which cloned voice speaks a channel's narration on GitHub Actions (voicebox-scenes.yml).
 *
 * A channel without an entry here gets the workflow's own defaults (the CodeOrCap verdict-clip voice). The inputs are
 * passed straight to the workflow, so the sample must be a file committed in this repo (assets/voice-samples/).
 *   voice            profile name Voicebox creates for the run (any name)
 *   sample_path      audio/video file in this repo that holds the clean speech to clone
 *   sample_start/end seconds of that file (under 30 s in total)
 *   sample_language  language spoken in the sample, for the automatic transcription
 *   sample_text      "auto" = transcribe the sample; otherwise exactly what is said in it
 */
export interface VoiceProfile {
  voice: string;
  sample_path: string;
  sample_start: string;
  sample_end: string;
  sample_language: string;
  sample_text: string;
}

export const VOICE_PROFILES: Record<string, VoiceProfile> = {
  // CodeOrCap narrates in the owner's own cloned voice (paddy1): a 15 s window of his recording, level-normalised
  codeorcap: {
    voice: "paddy1",
    sample_path: "assets/voice-samples/paddy1.mp3",
    sample_start: "0",
    sample_end: "15",
    sample_language: "hi",
    sample_text: "auto",
  },
  // Prompt Gag (finance) speaks in the owner's voice, same sample as CodeOrCap
  prompt_gag: {
    voice: "paddy1",
    sample_path: "assets/voice-samples/paddy1.mp3",
    sample_start: "0",
    sample_end: "15",
    sample_language: "hi",
    sample_text: "auto",
  },
  // InfoOnSpot speaks in the Pakizah voice, same sample as Storiyum
  infoonspot: {
    voice: "paki1",
    sample_path: "assets/voice-samples/pakizah.mp3",
    sample_start: "0",
    sample_end: "14.7",
    sample_language: "hi",
    sample_text: "auto",
  },
  // Storiyum narrates in the Pakizah voice (14.8 s of clean storytelling speech, about -24 LUFS with natural pauses)
  storiyum: {
    voice: "paki1",
    sample_path: "assets/voice-samples/pakizah.mp3",
    sample_start: "0",
    sample_end: "14.7",
    sample_language: "hi",
    sample_text: "auto",
  },
};

/** Workflow inputs for a channel's cloned voice, or {} to keep the workflow defaults. Case-insensitive on the channel key. */
export function voiceInputsFor(channelKey?: string): Record<string, string> {
  const p = channelKey ? VOICE_PROFILES[channelKey.trim().toLowerCase()] : undefined;
  return p ? { ...p } : {};
}
