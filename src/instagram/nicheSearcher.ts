import { ContentTheme } from "../config";
import { pipelineLogger } from "../utils/logger";
import { searchAllHashtagReels, InstagramRateLimitError, InstagramSessionDeadError, ScraperCallbacks } from "./channelFeed";

export { InstagramRateLimitError, InstagramSessionDeadError };

/**
 * A reel picked because it matches the channel's niche (found under one of the niche's hashtags).
 * Engagement numbers are informational only; they never decide whether a reel is picked.
 */
export interface NicheReel {
  shortcode: string;
  url: string;
  channel: string;
  creatorUsername?: string;
  playCount: number;
  likeCount: number;
  commentCount: number;
}

// niche key → mood key → hashtag list
// "default" is used when the requested mood has no specific entry.
const HASHTAG_MAP: Record<string, Record<string, string[]>> = {
  // CodeOrCap — tech/AI info + claim verification (fact-check, myth-busting, explainers)
  tech: {
    default: [
      "techfacts", "factcheck", "mythbusted", "didyouknow", "techexplained",
      "techtips", "aifacts", "artificialintelligence", "aitools", "chatgpt",
      "machinelearning", "programming", "coding", "softwareengineering", "cybersecurity",
      "techshorts", "learnai", "developer", "techtrivia", "aiexplained",
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

/** Round-robin across per-hashtag lists: first reel of each tag, then the second of each, and so on. */
export function interleaveByTag<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
}

/**
 * Search the niche's hashtags and return fresh reels to pick from. Relevance is the hashtag itself:
 * there is no engagement score and no threshold, so a small account's on-topic reel is as eligible as a big one.
 * Reels are de-duplicated, anything already in history is dropped, and the rest are interleaved
 * round-robin across hashtags (in the order given, so the niche's best-matching tags lead). That keeps a daily
 * batch varied instead of filled by whichever tag happened to return the most.
 *
 * Throws InstagramRateLimitError / InstagramSessionDeadError if the search could not run.
 */
export async function searchNicheReels(
  hashtags: string[],
  limitPerTag: number,
  reelHistory: { has: (shortcode: string) => boolean },
  scraperEnv?: Record<string, string>,
  callbacks?: ScraperCallbacks,
): Promise<NicheReel[]> {
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
  const byTag = new Map<string, NicheReel[]>();
  for (const tag of hashtags) byTag.set(tag.replace(/^#/, ""), []);

  for (const r of rawReels) {
    if (seen.has(r.shortcode) || reelHistory.has(r.shortcode)) continue;
    seen.add(r.shortcode);
    const reel: NicheReel = {
      shortcode: r.shortcode,
      url: r.url,
      channel: r.sourceHashtag,
      creatorUsername: r.creatorUsername,
      playCount: r.playCount,
      likeCount: r.likeCount,
      commentCount: r.commentCount,
    };
    const list = byTag.get(r.sourceHashtag) ?? [];
    list.push(reel);
    byTag.set(r.sourceHashtag, list);
  }

  const picked = interleaveByTag([...byTag.values()]);
  const lists = [...byTag.values()].filter((l) => l.length > 0);

  if (picked.length === 0) {
    pipelineLogger.warn("[NicheSearcher] No fresh reels found across all hashtags", "NicheSearcher");
    return [];
  }

  pipelineLogger.info(
    `[NicheSearcher] ${picked.length} fresh niche reel(s) from ${lists.length} hashtag(s) (no engagement filter)`,
    "NicheSearcher",
  );

  return picked;
}
