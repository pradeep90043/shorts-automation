/**
 * Which cloned voice speaks a channel's narration on GitHub Actions (voicebox-scenes.yml).
 *
 * A channel without an entry here gets the workflow's own defaults (the CodeOrCap verdict-clip voice). The inputs are
 * passed straight to the workflow, so the sample must be a file committed in this repo (assets/voice-samples/).
 *   voice            profile name Voicebox creates for the run (any name)
 *   sample_path      audio/video file in this repo that holds the clean speech to clone
 *   sample_start/end seconds of that file (under 30 s in total)
 *   sample_language  language spoken in the sample, for the automatic transcription
 *   sample_text      what is said in the window, as written once with Whisper large-v3 (2026-10-19). Never "auto": a shard that has to
 *                    transcribe the sample first hung for 28 minutes when Voicebox's own Whisper answered HTTP 500, and the Short went out silent.
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
  // CodeOrCap narrates in the owner's own cloned voice (paddy1): 12 s of the recording cut on pauses, cleaned with DeepFilterNet
  // (noise floor -46 -> -56 dB at the same speech level), so the clone stops copying the phone's hiss
  codeorcap: {
    voice: "paddy1",
    sample_path: "assets/voice-samples/paddy1_clean.mp3",
    sample_start: "0",
    sample_end: "12",
    sample_language: "hi",
    sample_text: "कि आपका स्वागत है कोड और कैप में और आज हम लोग पढ़ेंगे कि हम लोग कैसे जावा का यूज करके एक बेटर बैक एंड बनाया जा सकता है बैक एंड तो वैसे और पाइथन में बन सकता है अ",
  },
  // Prompt Gag (finance) speaks in the owner's voice, same sample as CodeOrCap
  prompt_gag: {
    voice: "paddy1",
    sample_path: "assets/voice-samples/paddy1_clean.mp3",
    sample_start: "0",
    sample_end: "12",
    sample_language: "hi",
    sample_text: "कि आपका स्वागत है कोड और कैप में और आज हम लोग पढ़ेंगे कि हम लोग कैसे जावा का यूज करके एक बेटर बैक एंड बनाया जा सकता है बैक एंड तो वैसे और पाइथन में बन सकता है अ",
  },
  // InfoOnSpot speaks in the Pakizah voice, same sample as Storiyum
  infoonspot: {
    voice: "paki1",
    sample_path: "assets/voice-samples/pakizah.mp3",
    sample_start: "0",
    sample_end: "14.7",
    sample_language: "hi",
    sample_text: "लिलकिफल के जूलरी और बेहद सलीके से किया गया मेकप दुलहन बनी आईनी के सामने बैठे ही वो खुद को देख रही थी उस पर आज तूट कर रूप आया था खुबसूरत नए नक्ष तो थे ही जिसे ब्यूटिशन ने मेकप करके और भी हुजागर और दिलकश बना दि",
  },
  // Storiyum narrates in the Pakizah voice (14.8 s of clean storytelling speech, about -24 LUFS with natural pauses)
  storiyum: {
    voice: "paki1",
    sample_path: "assets/voice-samples/pakizah.mp3",
    sample_start: "0",
    sample_end: "14.7",
    sample_language: "hi",
    sample_text: "लिलकिफल के जूलरी और बेहद सलीके से किया गया मेकप दुलहन बनी आईनी के सामने बैठे ही वो खुद को देख रही थी उस पर आज तूट कर रूप आया था खुबसूरत नए नक्ष तो थे ही जिसे ब्यूटिशन ने मेकप करके और भी हुजागर और दिलकश बना दि",
  },
};

/** Workflow inputs for a channel's cloned voice, or {} to keep the workflow defaults. Case-insensitive on the channel key. */
export function voiceInputsFor(channelKey?: string): Record<string, string> {
  const p = channelKey ? VOICE_PROFILES[channelKey.trim().toLowerCase()] : undefined;
  return p ? { ...p } : {};
}
