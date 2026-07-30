import { getPool } from "./pgClient";
import { ChannelProfile } from "../config";
import { YouTubeService } from "../youtube";
import { pipelineLogger } from "./logger";

export interface PlatformMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  averageWatchTime?: number;
  retentionPercentage?: number;
  threeSecondViews?: number;
}

/**
 * Fetches latest insights from Instagram Graph API for a specific Reel.
 */
async function fetchInstagramInsights(mediaId: string, accessToken: string): Promise<PlatformMetrics | null> {
  const API_VERSION = "v21.0";
  try {
    // 1. Fetch likes & comments count from media node
    const mediaRes = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${mediaId}?fields=like_count,comments_count&access_token=${accessToken}`
    );
    const mediaData = (await mediaRes.json()) as any;
    if (mediaData.error) {
      throw new Error(`IG media fields error: ${mediaData.error.message}`);
    }

    const likes = mediaData.like_count || 0;
    const comments = mediaData.comments_count || 0;

    // 2. Fetch plays, reach, saved, shares from insights edge
    const insightsRes = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${mediaId}/insights?metric=plays,reach,saved,shares&access_token=${accessToken}`
    );
    const insightsData = (await insightsRes.json()) as any;
    
    let views = 0;
    let saves = 0;
    let shares = 0;

    if (insightsData.data && Array.isArray(insightsData.data)) {
      for (const item of insightsData.data) {
        const val = item.values?.[0]?.value || 0;
        if (item.name === "plays") views = val;
        else if (item.name === "saved") saves = val;
        else if (item.name === "shares") shares = val;
      }
    }

    return {
      views,
      likes,
      comments,
      shares,
      saves,
    };
  } catch (err) {
    pipelineLogger.warn(`Failed to fetch Instagram insights for media ${mediaId}: ${err instanceof Error ? err.message : String(err)}`, "InsightsSync");
    return null;
  }
}

/**
 * Fetches latest insights from Facebook Graph API for a Page Reel.
 */
async function fetchFacebookInsights(videoId: string, accessToken: string): Promise<PlatformMetrics | null> {
  const API_VERSION = "v21.0";
  try {
    // Query video_insights edge for plays, reactions, and clicks
    const insightsRes = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${videoId}/video_insights?metric=blue_reels_play_count,post_impressions&access_token=${accessToken}`
    );
    const insightsData = (await insightsRes.json()) as any;

    let views = 0;
    if (insightsData.data && Array.isArray(insightsData.data)) {
      for (const item of insightsData.data) {
        const val = item.values?.[0]?.value || 0;
        if (item.name === "blue_reels_play_count") views = val;
      }
    }

    // Fetch video comments, reactions and shares count directly from node
    const fieldsRes = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${videoId}?fields=likes.summary(true),comments.summary(true),shares&access_token=${accessToken}`
    );
    const fieldsData = (await fieldsRes.json()) as any;

    const likes = fieldsData.likes?.summary?.total_count || 0;
    const comments = fieldsData.comments?.summary?.total_count || 0;
    const shares = fieldsData.shares?.count || 0;

    return {
      views,
      likes,
      comments,
      shares,
      saves: 0,
    };
  } catch (err) {
    pipelineLogger.warn(`Failed to fetch Facebook insights for video ${videoId}: ${err instanceof Error ? err.message : String(err)}`, "InsightsSync");
    return null;
  }
}

/**
 * Save platform metrics into the Supabase database.
 */
async function saveInsightsToDb(
  shortcode: string,
  profileKey: string,
  platform: string,
  publishedAt: string | null,
  metrics: PlatformMetrics
): Promise<void> {
  const pool = await getPool();
  const query = `
    INSERT INTO reel_insights (
      shortcode, profile_key, platform, published_at,
      views, likes, comments, shares, saves,
      average_watch_time, retention_percentage, three_second_views,
      last_updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    ON CONFLICT (shortcode, profile_key, platform) DO UPDATE
    SET views = EXCLUDED.views,
        likes = EXCLUDED.likes,
        comments = EXCLUDED.comments,
        shares = EXCLUDED.shares,
        saves = EXCLUDED.saves,
        average_watch_time = EXCLUDED.average_watch_time,
        retention_percentage = EXCLUDED.retention_percentage,
        three_second_views = EXCLUDED.three_second_views,
        last_updated_at = NOW();
  `;

  await pool.query(query, [
    shortcode,
    profileKey,
    platform,
    publishedAt,
    metrics.views,
    metrics.likes,
    metrics.comments,
    metrics.shares,
    metrics.saves,
    metrics.averageWatchTime ?? null,
    metrics.retentionPercentage ?? null,
    metrics.threeSecondViews ?? null,
  ]);
}

/**
 * Main function to sync insights for all reels published in the last 10 days under a specific profile.
 */
export async function syncAllInsights(profile: ChannelProfile): Promise<void> {
  const pool = await getPool();
  pipelineLogger.info(`[${profile.brandName}] Syncing insights for recent reels...`, "InsightsSync");

  // Query reels published in the last 10 days
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - 10);

  const { rows } = await pool.query(
    `SELECT shortcode, published_at, youtube_video_id, instagram_media_id, facebook_video_id
     FROM reel_history
     WHERE profile_key = $1 AND published_at >= $2 AND failed = false`,
    [profile.key, thresholdDate.toISOString()]
  );

  pipelineLogger.info(`[${profile.brandName}] Found ${rows.length} active reels to sync`, "InsightsSync");

  const ytService = new YouTubeService(profile.youtube);

  for (const row of rows) {
    const { shortcode, published_at, youtube_video_id, instagram_media_id, facebook_video_id } = row;

    // 1. Sync YouTube
    if (youtube_video_id && profile.youtube.channels.length > 0) {
      const mainChannel = profile.youtube.channels[0];
      const ytMetrics = await ytService.getVideoMetrics(mainChannel.name, youtube_video_id);
      if (ytMetrics) {
        await saveInsightsToDb(shortcode, profile.key, "youtube", published_at, {
          views: ytMetrics.views,
          likes: ytMetrics.likes,
          comments: ytMetrics.comments,
          shares: 0,
          saves: 0,
        });
        pipelineLogger.info(`[${profile.brandName}] Sourced YT metrics for shortcode ${shortcode} (Views: ${ytMetrics.views})`, "InsightsSync");
      }
    }

    // 2. Sync Instagram
    if (instagram_media_id && profile.instagram.accounts.length > 0) {
      const igAccount = profile.instagram.accounts[0];
      if (igAccount.accessToken) {
        const igMetrics = await fetchInstagramInsights(instagram_media_id, igAccount.accessToken);
        if (igMetrics) {
          await saveInsightsToDb(shortcode, profile.key, "instagram", published_at, igMetrics);
          pipelineLogger.info(`[${profile.brandName}] Sourced IG metrics for shortcode ${shortcode} (Views: ${igMetrics.views})`, "InsightsSync");
        }
      }
    }

    // 3. Sync Facebook
    if (facebook_video_id && profile.facebook?.accessToken) {
      const fbMetrics = await fetchFacebookInsights(facebook_video_id, profile.facebook.accessToken);
      if (fbMetrics) {
        await saveInsightsToDb(shortcode, profile.key, "facebook", published_at, fbMetrics);
        pipelineLogger.info(`[${profile.brandName}] Sourced FB metrics for shortcode ${shortcode} (Views: ${fbMetrics.views})`, "InsightsSync");
      }
    }
  }

  pipelineLogger.info(`[${profile.brandName}] Insights sync completed!`, "InsightsSync");
}
