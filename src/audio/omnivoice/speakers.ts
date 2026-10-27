import { parseAiJson } from "../../utils/json";
import { pipelineLogger as logger } from "../../utils/logger";
import { CHARACTER_VOICES, characterKey } from "./job";

/** A sentence of a story spoken by a character (OmniVoice gives it that character's designed voice). */
export interface SpeakerLine {
  speaker?: string;
  text: string;
}

const norm = (t: string): string => t.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();

/**
 * Gives the planned scenes their speaker: the planner splits the script into beats on its own, so a scene speaks a character's line when
 * its text IS (nearly all of) that line. A scene that mixes narration and dialogue stays with the narrator.
 */
export function assignSpeakers<T extends { text: string; ttsText?: string; speaker?: string }>(scenes: T[], speakerLines: SpeakerLine[] = []): T[] {
  const lines = speakerLines.filter((l) => l.speaker).map((l) => ({ speaker: l.speaker!, text: norm(l.text) })).filter((l) => l.text);
  if (!lines.length) return scenes;
  return scenes.map((s) => {
    const t = norm(s.ttsText || s.text);
    if (!t) return s;
    const hit = lines.find((l) => (l.text.includes(t) && t.length >= l.text.length * 0.6) || (t.includes(l.text) && l.text.length >= t.length * 0.75));
    return hit ? { ...s, speaker: hit.speaker } : s;
  });
}

export const splitStorySentences = (script: string): string[] =>
  script.split(/(?<=[।.!?])\s+/).map((s) => s.trim()).filter(Boolean);

/**
 * Which sentences of a story are dialogue, and who says them: one LLM call over the numbered sentences. Only sentences that are a
 * character's own words count (narration about a character stays with the narrator). Never throws: [] = everything is narrated.
 */
export async function tagSpeakers(script: string, ask: (prompt: string) => Promise<string>): Promise<SpeakerLine[]> {
  const sentences = splitStorySentences(script);
  if (sentences.length < 2) return [];
  const prompt = [
    "Below is a story narration, one numbered sentence per line. Find the sentences that are a CHARACTER SPEAKING (their own words, usually in quotes or after 'कहा'),",
    "not narration about them. For each one, pick the closest voice from this list:",
    Object.keys(CHARACTER_VOICES).join(", "),
    "Most sentences are narration; only list real dialogue. A sentence like 'माँ ने कहा, बेटा खा ले' is dialogue only if it is mostly the spoken words.",
    "",
    sentences.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    "",
    'Return ONLY JSON: [{"n": <sentence number>, "speaker": "<voice>"}] ([] when there is no dialogue).',
  ].join("\n");
  try {
    const arr = parseAiJson<any[]>(await ask(prompt));
    if (!Array.isArray(arr)) return [];
    const out: SpeakerLine[] = [];
    for (const x of arr) {
      const n = Number(x?.n);
      const speaker = characterKey(String(x?.speaker ?? ""));
      if (speaker && Number.isInteger(n) && n >= 1 && n <= sentences.length) out.push({ speaker, text: sentences[n - 1] });
    }
    // a model that marks most of the story as dialogue misread the task: narrate it all instead
    return out.length > sentences.length * 0.6 ? [] : out;
  } catch (err) {
    logger.warn(`Speaker tagging failed (${err instanceof Error ? err.message.slice(0, 120) : err}): the narrator reads every line`, "OmniVoice");
    return [];
  }
}
