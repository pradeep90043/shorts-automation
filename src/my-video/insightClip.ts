import { isOffValue } from "../utils/switches";

/**
 * The stickman clip in the middle of a V2 Short. CodeOrCap's is "how it works"; the other channels get the insight that
 * suits them: Storiyum a moral or punchline, Prompt Gag the current market and an opinion, InfoOnSpot an opinion or reaction.
 *
 * Which channels have the clip is a switch (INSIGHT_CLIP_CHANNELS): all four by default, INSIGHT_CLIP_CHANNELS=off to stop.
 */
export type InsightKey = "how" | "moral" | "market" | "reaction";

export interface InsightKind {
  key: InsightKey;
  /** the spoken first line of the clip, by clip language */
  intro: { en: string; hi: string };
  /** the on-screen title of the first scene */
  title: string;
  /** instruction for the metadata field `howItWorks`, which is the text the clip narrates */
  promptRule: string;
}

/** Exactly what the prompt said before this module existed: CodeOrCap's metadata must not change. */
const HOW_RULE =
  "A detailed, clear, and educational explanation (approx 2-3 sentences, 30-50 words) explaining how the code snippet or trick works. " +
  "This step-by-step commentary adds original educational value to reuse of other creators' videos, so explain the logic or mechanics thoroughly and clearly.";

const KINDS: Record<InsightKey, InsightKind> = {
  how: {
    key: "how",
    intro: { en: "Let us check how is it working.", hi: "चलिए देखते हैं ये कैसे काम करता है।" },
    title: "HOW IT WORKS",
    promptRule: HOW_RULE,
  },
  moral: {
    key: "moral",
    intro: { en: "Here is the lesson of this story.", hi: "इस कहानी की सीख।" },
    title: "THE LESSON",
    promptRule:
      "The lesson of this clip, in 2-3 short sentences (30-50 words): the moral of the story, then one memorable closing punchline. " +
      "State it plainly as the creator's own reflection; do not retell the whole clip and do not invent facts about people in it.",
  },
  market: {
    key: "market",
    intro: { en: "Here is what is happening in the market.", hi: "अभी मार्केट में क्या चल रहा है।" },
    title: "MARKET VIEW",
    promptRule:
      "The market context of this clip in 2-3 short sentences (30-50 words): what is happening right now and why it matters, then ONE balanced opinion that also names the risk. " +
      "Educational only: no buy/sell advice, no promises of returns, and no price or percentage that the clip itself does not show.",
  },
  reaction: {
    key: "reaction",
    intro: { en: "Here is my take.", hi: "मेरी राय।" },
    title: "MY TAKE",
    promptRule:
      "A short opinion or reaction to this clip in 2-3 sentences (30-50 words): what stands out, whether it holds up, and what a viewer should keep in mind. " +
      "Keep it credible and non-clickbait; no guarantees and no claims the clip does not support.",
  },
};

const BY_CHANNEL: Record<string, InsightKey> = {
  codeorcap: "how",
  storiyum: "moral",
  prompt_gag: "market",
  infoonspot: "reaction",
};

export const insightFor = (channelKey: string): InsightKind => KINDS[BY_CHANNEL[channelKey.toLowerCase()] ?? "how"];

/**
 * Channels that get the clip. Default (unset) and "all" = the four known channels; "off"/"none"/"0" = nobody;
 * otherwise a comma list, e.g. "codeorcap,storiyum".
 */
export function insightChannels(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = (env.INSIGHT_CLIP_CHANNELS ?? "all").trim().toLowerCase();
  if (raw === "" || raw === "all") return new Set(Object.keys(BY_CHANNEL));
  if (isOffValue(raw)) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** Whether a channel's Short gets the clip: it is on the list AND its outro version is v2 (the existing per-channel switch). */
export function insightEnabledFor(channelKey: string, outroVersion: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return insightChannels(env).has(channelKey.toLowerCase()) && (outroVersion || "v2") === "v2";
}

/**
 * The language the clip speaks. INSIGHT_CLIP_LANG (hi | en) overrides everything; otherwise every channel with a Hindi voice
 * (all but CodeOrCap, whose Shorts are English) speaks Hindi, so the middle clip never switches language halfway through a Short.
 */
export const insightLang = (env: NodeJS.ProcessEnv = process.env, channelKey = ""): "en" | "hi" => {
  const forced = (env.INSIGHT_CLIP_LANG ?? "").trim();
  if (forced) return /^hi/i.test(forced) ? "hi" : "en";
  return channelKey && channelKey.toLowerCase() !== "codeorcap" ? "hi" : "en";
};

export const insightIntro = (channelKey: string, env: NodeJS.ProcessEnv = process.env): string => insightFor(channelKey).intro[insightLang(env, channelKey)];

/** The metadata instruction for `howItWorks`: the channel's rule, plus the language the clip is spoken in. */
export const insightRuleFor = (channelKey: string, env: NodeJS.ProcessEnv = process.env): string =>
  insightFor(channelKey).promptRule +
  (insightLang(env, channelKey) === "hi"
    ? " Write it in Hinglish (Hindi words in the English alphabet), the same language as the voiceover: it is turned into Devanagari for the Hindi voice."
    : "");
