/**
 * The cloned English voice (chatterbox turbo) acts out a few bracketed tags such as [chuckle]; the Edge voice would read
 * them aloud and captions would show them. Strip them everywhere except the text sent to the cloned voice.
 */
export const VOICE_TAG = /\s*\[(?:chuckle|laugh|sigh|cough|gasp|clear throat)\]\s*/gi;

export const stripVoiceTags = (text: string): string => text.replace(VOICE_TAG, " ").replace(/\s{2,}/g, " ").trim();
