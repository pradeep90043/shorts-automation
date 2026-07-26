import { ContentTheme } from "../config";
import { pipelineLogger } from "../utils/logger";
import { scoreAndSort, filterViral } from "../utils/viralScore";
import { searchAllHashtagReels, InstagramRateLimitError } from "./channelFeed";

export { InstagramRateLimitError };

export interface ScoredReel {
  shortcode: string;
  url: string;
  channel: string;
  creatorUsername?: string;
  playCount: number;
  likeCount: number;
  commentCount: number;
  viralScore: number;
}

// niche key → mood key → hashtag list
// "default" is used when the requested mood has no specific entry.
const HASHTAG_MAP: Record<string, Record<string, string[]>> = {
  tech: {
    default: [
      // Programming
      "programming", "coding", "developer", "techshorts", "javascript",
      "python", "learntocode", "devlife", "softwareengineering", "webdevelopment",
      // AI / ML
      "artificialintelligence", "ai", "machinelearning", "deeplearning",
      "chatgpt", "aitools", "aitechnology", "llm", "generativeai", "aishorts",
    ],
    funny: [
      "programminghumor", "developerhumor", "codingjokes", "techmemes", "techhumor",
      "aihumor", "chatgptmemes", "devhumor",
    ],
    serious: [
      "programming", "coding", "developer", "learntocode", "softwareengineering",
      "artificialintelligence", "machinelearning", "aitools",
    ],
    educational: [
      "learntocode", "programming", "coding", "techshorts", "webdevelopment",
      "learnai", "machinelearning", "artificialintelligence", "aieducation",
    ],
    ai: [
      "artificialintelligence", "ai", "machinelearning", "deeplearning",
      "chatgpt", "aitools", "aitechnology", "llm", "generativeai", "aishorts",
      "aiart", "openai", "aiautomation",
    ],
  },
  stories: {
    default: ["shortfilm", "viralshorts", "storytelling", "motivational", "inspiration"],
    funny: ["funnyshorts", "comedy", "trending", "funnyvideo", "comedyshorts"],
    emotional: ["emotionalstory", "motivational", "inspiration", "heartfelt", "feelgood"],
    sad: ["emotionalstory", "sadvideo", "heartfelt", "inspiration", "relatable"],
    motivational: ["motivational", "inspiration", "mindset", "success", "positivity"],
  },
};

/**
 * Map a ContentTheme + optional mood to a deduplicated list of hashtags.
 * Mood matching is case-insensitive; falls back to the "default" list.
 * nicheHashtagsOverride, if provided, is used instead of the auto-map.
 */
export function buildHashtagsForNiche(
  theme: ContentTheme,
  mood?: string,
  nicheHashtagsOverride?: string[],
): string[] {
  if (nicheHashtagsOverride && nicheHashtagsOverride.length > 0) {
    return [...new Set(nicheHashtagsOverride)];
  }

  const nicheKey = HASHTAG_MAP[theme.niche] ? theme.niche : "tech";
  const nicheMap = HASHTAG_MAP[nicheKey] || HASHTAG_MAP.tech;
  const moodKey = mood
    ? Object.keys(nicheMap).find((k) => k !== "default" && mood.toLowerCase().includes(k))
    : undefined;

  const tags = nicheMap[moodKey || "default"] || nicheMap.default || [];
  return [...new Set(tags)];
}

/**
 * Search Instagram hashtags for viral reels. Combines results across all
 * provided hashtags, deduplicates, scores, filters by viralThreshold (fail-
 * open), and returns sorted descending by viralScore.
 *
 * Throws InstagramRateLimitError if every hashtag search is rate-limited.
 */
export async function searchViralReels(
  hashtags: string[],
  viralThreshold: number,
  limitPerTag: number,
  reelHistory: { has: (shortcode: string) => boolean },
): Promise<ScoredReel[]> {
  // All hashtags fetched in ONE Python process — single login, rate-limit-safe delays.
  let rawReels: import("./channelFeed").ScoredReelSummary[] = [];
  try {
    rawReels = await searchAllHashtagReels(hashtags, limitPerTag);
  } catch (err) {
    if (err instanceof InstagramRateLimitError) {
      throw err; // propagate so ChannelWatcher can set cooldown
    }
    pipelineLogger.warn(
      `[NicheSearcher] Hashtag search failed: ${err instanceof Error ? err.message : String(err)}`,
      "NicheSearcher",
    );
  }

  const seen = new Set<string>();
  const allReels: Array<{
    shortcode: string;
    url: string;
    channel: string;
    creatorUsername?: string;
    playCount: number;
    likeCount: number;
    commentCount: number;
  }> = [];

  for (const r of rawReels) {
    if (seen.has(r.shortcode) || reelHistory.has(r.shortcode)) continue;
    seen.add(r.shortcode);
    allReels.push({
      shortcode: r.shortcode,
      url: r.url,
      channel: r.sourceHashtag,
      creatorUsername: r.creatorUsername,
      playCount: r.playCount,
      likeCount: r.likeCount,
      commentCount: r.commentCount,
    });
  }

  if (allReels.length === 0) {
    pipelineLogger.warn("[NicheSearcher] No reels found across all hashtags", "NicheSearcher");
    return [];
  }

  const scored = scoreAndSort(allReels);
  const filtered = filterViral(scored, viralThreshold);

  pipelineLogger.info(
    `[NicheSearcher] ${allReels.length} unique reel(s) found → ${filtered.length} pass viral threshold ${viralThreshold}`,
    "NicheSearcher",
  );

  return filtered;
}
