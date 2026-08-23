import { google } from "googleapis";
import { config } from "../config";
import { getAllStoredChannelConfigs, StoredInstagramAccount, StoredYoutubeChannel } from "./channelConfigStore";
import { pipelineLogger } from "./logger";

export interface AudienceStats {
  igFollowers: number | null;
  ytSubscribers: number | null;
  igMediaCount?: number | null;
  ytViewCount?: number | null;
  ytVideoCount?: number | null;
  lastUpdated: number;
}

const statsCache = new Map<string, AudienceStats>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes cache

/**
 * Fetch Instagram followers count using Graph API
 */
async function fetchInstagramFollowers(
  userId?: string,
  accessToken?: string,
): Promise<{ followers: number | null; mediaCount: number | null }> {
  if (!userId || !accessToken) return { followers: null, mediaCount: null };
  try {
    const url = `https://graph.facebook.com/v19.0/${userId}?fields=followers_count,media_count&access_token=${accessToken}`;
    const res = await fetch(url);
    const data = (await res.json()) as any;
    if (data && typeof data.followers_count === "number") {
      return {
        followers: data.followers_count,
        mediaCount: typeof data.media_count === "number" ? data.media_count : null,
      };
    }
  } catch (err: any) {
    pipelineLogger.warn(`[AudienceStats] Failed to fetch IG followers for ${userId}: ${err.message}`);
  }
  return { followers: null, mediaCount: null };
}

/**
 * Fetch YouTube subscribers and stats using OAuth Refresh Token
 */
async function fetchYouTubeSubscribers(
  refreshToken?: string,
  clientId?: string,
  clientSecret?: string,
  redirectUri?: string,
): Promise<{ subscribers: number | null; views: number | null; videos: number | null }> {
  if (!refreshToken || !clientId || !clientSecret) {
    return { subscribers: null, views: null, videos: null };
  }
  try {
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      redirectUri || "http://localhost:3000/oauth2callback",
    );
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const yt = google.youtube({ version: "v3", auth: oauth2Client });
    const res = await yt.channels.list({
      part: ["statistics"],
      mine: true,
    });
    const stats = res.data.items?.[0]?.statistics;
    if (stats) {
      return {
        subscribers: stats.subscriberCount ? parseInt(stats.subscriberCount, 10) : null,
        views: stats.viewCount ? parseInt(stats.viewCount, 10) : null,
        videos: stats.videoCount ? parseInt(stats.videoCount, 10) : null,
      };
    }
  } catch (err: any) {
    pipelineLogger.warn(`[AudienceStats] Failed to fetch YT subscribers: ${err.message}`);
  }
  return { subscribers: null, views: null, videos: null };
}

/**
 * Get audience statistics for a specific profile across all configured IG accounts and YT channels.
 */
export async function getProfileAudienceStats(profileKey: string): Promise<AudienceStats> {
  const pKey = profileKey.toLowerCase();
  const cached = statsCache.get(pKey);
  const now = Date.now();

  if (cached && now - cached.lastUpdated < CACHE_TTL_MS) {
    return cached;
  }

  // Find profile config (from memory or database)
  const profile = config.profiles.find((p) => p.key.toLowerCase() === pKey);
  const storedConfigs = await getAllStoredChannelConfigs();
  const stored = storedConfigs.find((c) => c.key.toLowerCase() === pKey);

  // Gather all Instagram accounts
  const igAccounts: StoredInstagramAccount[] = (stored?.instagramAccounts && stored.instagramAccounts.length > 0)
    ? stored.instagramAccounts
    : (profile?.instagram.accounts || []).map(a => ({ name: a.name, igUserId: a.igUserId, accessToken: a.accessToken }));

  if (igAccounts.length === 0 && (stored?.instagramUserId || stored?.instagramAccessToken)) {
    igAccounts.push({
      name: `${stored.brandName} Instagram`,
      igUserId: stored.instagramUserId || "",
      accessToken: stored.instagramAccessToken || "",
    });
  }

  // Gather all YouTube channels
  const ytChannels: StoredYoutubeChannel[] = (stored?.youtubeChannels && stored.youtubeChannels.length > 0)
    ? stored.youtubeChannels
    : (profile?.youtube.channels || []).map(c => ({ name: c.name, refreshToken: c.refreshToken }));

  if (ytChannels.length === 0 && stored?.youtubeRefreshToken) {
    ytChannels.push({
      name: stored.brandName,
      refreshToken: stored.youtubeRefreshToken,
    });
  }

  const ytClientId = stored?.youtubeClientId || profile?.youtube.clientId || process.env.YOUTUBE_CLIENT_ID;
  const ytClientSecret = stored?.youtubeClientSecret || profile?.youtube.clientSecret || process.env.YOUTUBE_CLIENT_SECRET;
  const ytRedirectUri = stored?.youtubeRedirectUri || profile?.youtube.redirectUri;

  // Fetch all IG accounts concurrently
  const igPromises = igAccounts.map(acc => fetchInstagramFollowers(acc.igUserId, acc.accessToken));
  // Fetch all YT channels concurrently
  const ytPromises = ytChannels.map(ch => fetchYouTubeSubscribers(ch.refreshToken, ytClientId, ytClientSecret, ytRedirectUri));

  const [igResults, ytResults] = await Promise.all([
    Promise.all(igPromises),
    Promise.all(ytPromises),
  ]);

  let totalIgFollowers: number | null = null;
  let totalIgMedia: number | null = null;
  for (const r of igResults) {
    if (r.followers !== null) {
      totalIgFollowers = (totalIgFollowers || 0) + r.followers;
    }
    if (r.mediaCount !== null) {
      totalIgMedia = (totalIgMedia || 0) + r.mediaCount;
    }
  }

  let totalYtSubs: number | null = null;
  let totalYtViews: number | null = null;
  let totalYtVideos: number | null = null;
  for (const r of ytResults) {
    if (r.subscribers !== null) {
      totalYtSubs = (totalYtSubs || 0) + r.subscribers;
    }
    if (r.views !== null) {
      totalYtViews = (totalYtViews || 0) + r.views;
    }
    if (r.videos !== null) {
      totalYtVideos = (totalYtVideos || 0) + r.videos;
    }
  }

  const stats: AudienceStats = {
    igFollowers: totalIgFollowers,
    ytSubscribers: totalYtSubs,
    igMediaCount: totalIgMedia,
    ytViewCount: totalYtViews,
    ytVideoCount: totalYtVideos,
    lastUpdated: now,
  };

  statsCache.set(pKey, stats);
  return stats;
}

/**
 * Fetch and return audience stats for all profiles concurrently.
 */
export async function getAllAudienceStats(): Promise<Record<string, AudienceStats>> {
  const profiles = config.profiles;
  const results: Record<string, AudienceStats> = {};

  await Promise.all(
    profiles.map(async (p) => {
      try {
        results[p.key.toLowerCase()] = await getProfileAudienceStats(p.key);
      } catch {
        results[p.key.toLowerCase()] = {
          igFollowers: null,
          ytSubscribers: null,
          lastUpdated: Date.now(),
        };
      }
    }),
  );

  return results;
}
