import { makeAsk, type Ask } from "../longvideo-auto/llm";
import { pipelineLogger } from "../utils/logger";

/**
 * What a narration line should SOUND like. Decided per line from its meaning (one LLM call for the whole script, a keyword/punctuation
 * rule when the LLM is unavailable) and applied on the runner by scripts/voicebox_emotion.py: Chatterbox expressiveness plus
 * pitch / pace / loudness of the clip. "neutral" changes nothing.
 */
export const EMOTIONS = ["neutral", "surprise", "sad", "energetic", "serious", "warm"] as const;
export type Emotion = (typeof EMOTIONS)[number];

const off = (v: string | undefined): boolean => /^(off|false|0|no)$/i.test((v ?? "").trim());

const SURPRISE = /(\bwow\b|unbelievabl|shocking|shocked|suddenly|turns out|plot twist|can't believe|surpris|never expected|\bwait\b|really\?|\bbut then\b|हैरान|चौंक|अचानक|यकीन नहीं|हैरत|चौंका|सच में\?|लेकिन तभी|आश्चर्य|कमाल|अविश्वसनीय)/i;
const SAD = /(\bsad\b|tragic|\bdied\b|death|lost (his|her|their|everything)|heartbreak|cried|crying|\bgrief\b|alone|failed|devastat|sorrow|unfortunately|दुखद|दर्दनाक|रो पड़|रोया|मौत|खो दिया|अकेला|टूट गया|दुख|अफसोस|नुकसान|बर्बाद|आंसू|गम)/i;
const ENERGETIC = /(\blet'?s go\b|amazing|incredible|massive|huge|record|boom|launch|breaking|big news|game.?changer|तेज|धमाका|ज़बरदस्त|जबरदस्त|बड़ी खबर|रिकॉर्ड|शानदार|जोश|चलो|ब्रेकिंग|धमाल|कमाल का)/i;
const SERIOUS = /(warning|danger|careful|scam|fraud|illegal|risk|beware|सावधान|खतरा|ठगी|धोखाधड़ी|चेतावनी|जोखिम|गंभीर)/i;
const WARM = /(thank you|thanks for|love you|welcome|family|friend|धन्यवाद|शुक्रिया|परिवार|दोस्त|स्वागत|प्यार)/i;

/** Rule fallback: cue words first, then punctuation. */
export function ruleEmotion(text: string): Emotion {
  const t = text.trim();
  if (SAD.test(t)) return "sad";
  if (SURPRISE.test(t) || /\?!|!\?/.test(t)) return "surprise";
  if (SERIOUS.test(t)) return "serious";
  if (ENERGETIC.test(t) || (t.match(/!/g) ?? []).length >= 2) return "energetic";
  if (WARM.test(t)) return "warm";
  return "neutral";
}

const asEmotion = (v: unknown): Emotion | null => {
  const s = String(v ?? "").toLowerCase().trim();
  return (EMOTIONS as readonly string[]).includes(s) ? (s as Emotion) : null;
};

/** The first complete top-level [...] in `text` (strings respected), parsed; null when there is none. Models add prose after the array. */
export function firstJsonArray(text: string): unknown[] | null {
  const open = text.indexOf("[");
  if (open < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) {
      try { const v = JSON.parse(text.slice(open, i + 1)); return Array.isArray(v) ? v : null; } catch { return null; }
    }
  }
  return null;
}

/** One call for the whole script (context matters: a calm line after a shock is still "serious", not "surprise"). */
export async function classifyEmotions(texts: string[], ask: Ask = makeAsk({ timeoutMs: 60_000, hedgeMs: 15_000 })): Promise<Emotion[]> {
  const fallback = texts.map(ruleEmotion);
  if (!texts.length) return fallback;
  const prompt = `You direct the voice actor of a short video. For each numbered narration line choose HOW IT SHOULD BE SPOKEN, judging by its meaning and the lines around it.
Allowed values: neutral (plain information), surprise (a shock, twist, "you won't believe"), sad (loss, failure, pity), energetic (exciting news, hype, big numbers, a call to action), serious (warning, danger, scam, important caution), warm (thanks, friendly, personal).
Most lines are neutral; use the others only when the content truly calls for them. The lines may be English or Hindi.
Lines:
${texts.map((t, i) => `${i + 1}. ${t.slice(0, 300)}`).join("\n")}
Return ONLY a raw JSON array of exactly ${texts.length} strings, in order, e.g. ["neutral","surprise"].`;
  try {
    const raw = await ask(prompt, { maxTokens: 64 + texts.length * 12 }); // an array of short words: a looping model stops early
    const arr = firstJsonArray(raw ?? "");
    if (!Array.isArray(arr)) return fallback;
    // a missing or unknown entry keeps the rule's answer
    return texts.map((_, i) => asEmotion(arr[i]) ?? fallback[i]);
  } catch (err) {
    pipelineLogger.warn(`Emotion tagging by the LLM failed (${err instanceof Error ? err.message.slice(0, 120) : err}); using the rules`, "Emotion");
    return fallback;
  }
}

/** Adds `emotion` to each line (unless VOICE_EMOTION=off). Never throws. */
export async function tagEmotions<T extends { text: string }>(lines: T[]): Promise<(T & { emotion?: Emotion })[]> {
  if (off(process.env.VOICE_EMOTION)) return lines;
  try {
    const emotions = await classifyEmotions(lines.map((l) => l.text));
    const counts: Record<string, number> = {};
    emotions.forEach((e) => (counts[e] = (counts[e] ?? 0) + 1));
    pipelineLogger.info(`Voice emotion per line: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`, "Emotion");
    return lines.map((l, i) => (emotions[i] === "neutral" ? l : { ...l, emotion: emotions[i] }));
  } catch {
    return lines;
  }
}
