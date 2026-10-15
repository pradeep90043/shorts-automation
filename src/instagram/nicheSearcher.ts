import { ContentTheme } from "../config";
import { pipelineLogger } from "../utils/logger";
import { scoreAndSort, filterViral } from "../utils/viralScore";
import { searchAllHashtagReels, InstagramRateLimitError, InstagramSessionDeadError, ScraperCallbacks } from "./channelFeed";

export { InstagramRateLimitError, InstagramSessionDeadError };

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
  // CodeOrCap — anything tech: coding, dev careers, AI, security, cloud, gadgets, tech facts and explainers.
  // Broad, high-volume tags come first: the Puppeteer fallback only visits the first 5 hashtags.
  tech: {
    default: [
      "programming", "coding", "technology", "artificialintelligence", "softwareengineer",
      "developer", "aitools", "chatgpt", "techtips", "webdevelopment",
      "python", "javascript", "cybersecurity", "machinelearning", "cloudcomputing",
      "devops", "learntocode", "techshorts", "techfacts", "techexplained",
      "techcareers", "codinglife", "gadgets", "didyouknow", "mythbusted",
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
    // Storiyum — any story: movies, series, cartoons, anime, short films, moral/emotional stories
    default: [
      "storytime", "storytelling", "shortfilm", "animatedstory", "animation",
      "cartoon", "anime", "animereels", "animeedit", "movieclips",
      "moviescenes", "movierecap", "webseries", "seriesrecap", "tvshows",
      "netflix", "bingewatch", "moralstories", "cinema", "filmreels",
    ],
    funny: ["funnyshorts", "comedy", "trending", "funnyvideo", "comedyshorts"],
    emotional: ["emotionalstory", "motivational", "inspiration", "heartfelt", "feelgood"],
    sad: ["emotionalstory", "sadvideo", "heartfelt", "inspiration", "relatable"],
    motivational: ["motivational", "inspiration", "mindset", "success", "positivity"],
    horror: ["horrorstories", "scarystories", "horror", "scary", "creepy", "ghoststories", "spooky"],
    romantic: ["romanticstory", "loveletters", "romance", "lovestory", "love", "feelgood", "romantic"],
  },
  // PromptGag — funny / satire / sarcasm. (This niche key was missing, so "humor" fell back to "tech".)
  humor: {
    default: [
      "sarcasm", "sarcastic", "satire", "sarcasmhumor", "dryhumor",
      "deadpan", "funnyreels", "comedyreels", "comedyshorts", "funnyvideos",
      "memes", "viralmemes", "relatablememes", "trendingmemes", "officehumor",
      "adulting", "savage", "roast", "programmerhumor", "techhumor",
    ],
  },
  // InfoOnSpot — news / what's happening right now / updates
  // Prompt Gag — Indian market news and money explainers. Broad, high-volume tags first (only the first 5 are used by the fallback).
  finance: {
    default: [
      "stockmarket", "sharemarket", "investing", "finance", "personalfinance",
      "nifty", "sensex", "mutualfunds", "stockmarketindia", "financialfreedom",
      "moneytips", "wealth", "economy", "businessnews", "financetips",
      "tradingindia", "stocks", "sip", "financialliteracy", "marketupdate",
    ],
    serious: ["stockmarket", "economy", "nifty", "sensex", "businessnews", "marketupdate"],
    educational: ["financialliteracy", "personalfinance", "investing", "mutualfunds", "sip", "moneytips"],
  },
  infoonspot: {
    default: [
      "breakingnews", "newsupdate", "latestnews", "dailynews", "newsflash",
      "trendingnow", "currentaffairs", "worldnews", "indianews", "todaynews",
      "technews", "techupdate", "ainews", "aiupdate", "businessnews",
      "viralnews", "newsreels", "headlines", "whatshappening", "newsalert",
    ],
    ai: [
      "artificialintelligence", "ai", "aitools", "aitechnology", "chatgpt",
      "openai", "generativeai", "machinelearning", "deeplearning", "aishorts",
    ],
    tech: [
      "technology", "tech", "technews", "techupdates", "gadgets", "software",
      "innovation", "futuretech", "techtrends",
    ],
    money: [
      "money", "sidehustle", "finance", "businesstips", "productivity",
      "financialfreedom", "onlinebusiness",
    ],
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
  scraperEnv?: Record<string, string>,
  callbacks?: ScraperCallbacks,
): Promise<ScoredReel[]> {
  // All hashtags fetched in ONE Python process — single login, rate-limit-safe delays.
  let rawReels: import("./channelFeed").ScoredReelSummary[] = [];
  try {
    rawReels = await searchAllHashtagReels(hashtags, limitPerTag, scraperEnv, callbacks);
  } catch (err) {
    if (err instanceof InstagramRateLimitError || err instanceof InstagramSessionDeadError) {
      throw err; // propagate so ChannelWatcher can set cooldown / alert an admin
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
