import type { MythTopic } from "./topics";

/**
 * The script of a mythology Short: 6-8 scenes, each one spoken sentence in Devanagari (the cloned Hindi voice reads Devanagari),
 * a short on-screen caption and an English picture prompt. About 100-130 words, so ~40-50 s at the slower dramatic pace.
 */
export interface MythScene {
  narration: string;
  caption: string;
  image: string;
}
export interface MythScript {
  /** YouTube title: English hook + Hindi, e.g. "Why Karna Gave Away His Armour 😱 | कर्ण का कवच" */
  title: string;
  /** big hook text on the first scene, Hindi, a few words */
  hook: string;
  description: string;
  tags: string[];
  scenes: MythScene[];
}

const clip = (s: unknown, max: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const DEVANAGARI = /[ऀ-ॿ]/g;

/** More than 70% of the letters are Devanagari. */
export function mostlyDevanagari(t: string): boolean {
  const letters = (t.match(/[\p{L}\p{M}]/gu) ?? []).length;
  return letters > 0 && (t.match(DEVANAGARI) ?? []).length / letters > 0.7;
}

export function mythPrompt(topic: MythTopic): string {
  return (
    `You write 45-second YouTube Shorts for a Hindi channel that tells lesser-known stories from Indian mythology and history with the gravity of a katha.\n` +
    `STORY: ${topic.topic}\nSOURCE: ${topic.source}\n\n` +
    `Rules:\n` +
    `- Tell it as the source tells it. Do not invent names, numbers, places or events. Where traditions differ, say "कुछ कथाओं के अनुसार".\n` +
    `- Respectful and devotional in tone. No mocking, no politics, no caste or religious comparison, no claims that one faith is better. ` +
    `Never use loaded words such as "धर्म परिवर्तन" or "conversion" in the narration, title or captions.\n` +
    `- Never put words in quotation marks as if someone said or wrote them unless they are the exact known words; otherwise tell it in your own words.\n` +
    `- Spell names the standard Hindi way (कलिंग, अशोक, युधिष्ठिर, द्रोणाचार्य).\n` +
    `- 7 scenes. Scene 1 is the HOOK: talk straight to the viewer with a question that opens with "क्या आपको पता है" or "क्या आप जानते हैं", ` +
    `about the most surprising thing in the story, WITHOUT the hero's name or the answer, so the viewer has to keep watching ` +
    `(e.g. "क्या आपको पता है, महाभारत में कोई ऐसा भी था जो पूरा युद्ध एक ही पल में खत्म कर सकता था?"). ` +
    `Scene 2 starts the story and reveals who it is. Scenes 3-6 tell it with rising tension. ` +
    `Scene 7 gives the twist or lesson in one strong line, then "ऐसी ही कथाओं के लिए फ़ॉलो करें।"\n` +
    `- narration: ONE spoken sentence per scene in pure Hindi, Devanagari script only, 10 to 20 words, numbers written as Hindi words. ` +
    `All 7 together 100 to 130 words (the Short must stay under 50 seconds). Short dramatic sentences.\n` +
    `- caption: the key words of that scene in Hindi (Devanagari), at most 32 characters.\n` +
    `- image: an English description of ONE painting for the scene: the setting, the figures, their action, the light. ` +
    `Gods and revered figures are shown from behind, in silhouette or from a distance, never a close-up of a god's face. No text in the picture.\n` +
    `- title: an English hook of at most 55 characters plus " | " plus 2-4 Hindi words, one emoji, total at most 90 characters.\n` +
    `- hook: 2-5 Hindi words for the big text on the first scene, a teaser that does not give the answer (e.g. "एक पल में युद्ध खत्म?").\n` +
    `- description: 2-3 Hindi sentences about the story without spoiling the twist, then "स्रोत: ${topic.source}".\n` +
    `- tags: 10 search tags in English or Hinglish (e.g. "mahabharat story", "karna", "hindi kahani").\n` +
    `Answer with JSON only: {"title":"","hook":"","description":"","tags":[],"scenes":[{"narration":"","caption":"","image":""}]}\n/no_think`
  );
}

/** The script, or null when the answer is unusable (the caller asks again). */
export function parseMythScript(raw: string): MythScript | null {
  const m = /\{[\s\S]*\}/.exec(raw || "");
  if (!m) return null;
  let j: any;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const scenes: MythScene[] = (Array.isArray(j?.scenes) ? j.scenes : [])
    .map((s: any) => ({ narration: clip(s?.narration, 200), caption: clip(s?.caption, 40), image: clip(s?.image, 300) }))
    .filter((s: MythScene) => s.narration && mostlyDevanagari(s.narration))
    .slice(0, 9)
    .map((s: MythScene) => ({ ...s, caption: s.caption || s.narration.split(/\s+/).slice(0, 4).join(" "), image: s.image || "ancient Indian temple at dusk" }));
  const title = clip(j?.title, 95);
  if (!title || scenes.length < 5) return null;
  const words = scenes.reduce((n, s) => n + s.narration.split(/\s+/).length, 0);
  if (words < 70 || words > 160) return null; // ~2.6 Hindi words/s, slowed 5%: 160 words is already ~65 s
  const tags = (Array.isArray(j?.tags) ? j.tags : []).map((t: unknown) => clip(t, 40)).filter(Boolean).slice(0, 15);
  return {
    title,
    hook: clip(j?.hook, 40) || scenes[0].caption,
    description: clip(j?.description, 900),
    tags,
    scenes,
  };
}

export const MYTH_HASHTAGS = "#shorts #mythology #hindikahani #mahabharat #ramayan #itihas";

/** Description with the source line (added when the model left it out) and the channel hashtags. */
export function mythDescription(script: MythScript, topic: MythTopic): string {
  const body = script.description.includes("स्रोत") ? script.description : `${script.description}\n\nस्रोत: ${topic.source}`;
  return `${body}\n\nहर दिन एक अनसुनी कथा। Subscribe 🔔\n\n${MYTH_HASHTAGS}`;
}
