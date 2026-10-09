import { getPool } from "./pgClient";
import { pipelineLogger } from "./logger";

export interface ReelRecord {
  channel: string;
  pickedAt: string;
  publishedAt?: string;
  youtubeUrl?: string;
  instagramUrl?: string;
  facebookUrl?: string;
  youtubeVideoId?: string;
  instagramMediaId?: string;
  facebookVideoId?: string;
  failed?: boolean;
  failedReason?: string;
}

/**
 * Permanent, append-only store for every reel the channel-watcher has ever
 * picked. Backed by Supabase (PostgreSQL) so history survives across any
 * number of server restarts, fresh clones, or re-deployments.
 *
 * Reads are served from an in-memory Map (fast, sync) populated once at
 * startup via load(). All writes persist immediately to Supabase.
 */
export class ReelHistoryStore {
  private profileKey: string;
  private records = new Map<string, ReelRecord>();

  constructor(dbKey?: string) {
    this.profileKey = dbKey ?? "default";
  }

  public async load(): Promise<void> {
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT shortcode, channel, picked_at, published_at, youtube_url,
              instagram_url, facebook_url, youtube_video_id, instagram_media_id, facebook_video_id, failed, failed_reason
       FROM reel_history WHERE profile_key = $1`,
      [this.profileKey],
    );
    for (const row of rows) {
      this.records.set(row.shortcode, {
        channel: row.channel,
        pickedAt: row.picked_at,
        publishedAt: row.published_at ?? undefined,
        youtubeUrl: row.youtube_url ?? undefined,
        instagramUrl: row.instagram_url ?? undefined,
        facebookUrl: row.facebook_url ?? undefined,
        youtubeVideoId: row.youtube_video_id ?? undefined,
        instagramMediaId: row.instagram_media_id ?? undefined,
        facebookVideoId: row.facebook_video_id ?? undefined,
        failed: row.failed ?? undefined,
        failedReason: row.failed_reason ?? undefined,
      });
    }
    pipelineLogger.info(
      `Loaded ${this.records.size} reel history record(s) [${this.profileKey}]`,
      "ReelHistoryStore",
    );
  }

  /** True if this shortcode has ever been picked (regardless of publish outcome) for this profile. */
  public has(shortcode: string): boolean {
    return this.records.has(shortcode);
  }

  /** Checks if a shortcode was ever published or picked across ANY profile in the database. */
  public static async isPublishedAnywhere(shortcode: string): Promise<boolean> {
    if (!shortcode) return false;
    try {
      const pool = await getPool();
      const { rows } = await pool.query(
        `SELECT 1 FROM reel_history WHERE shortcode = $1 AND (published_at IS NOT NULL OR failed = false) LIMIT 1`,
        [shortcode],
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  /** Like isPublishedAnywhere, but only for one profile (used by explicit dashboard injections). */
  public static async isPublishedForProfile(shortcode: string, profileKey: string): Promise<boolean> {
    if (!shortcode) return false;
    try {
      const pool = await getPool();
      const { rows } = await pool.query(
        `SELECT 1 FROM reel_history WHERE shortcode = $1 AND profile_key = $2 AND (published_at IS NOT NULL OR failed = false) LIMIT 1`,
        [shortcode, profileKey],
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  /** Record a newly-picked reel before it enters the publish queue. */
  public async add(shortcode: string, channel: string): Promise<void> {
    if (this.records.has(shortcode)) return;
    const pickedAt = new Date().toISOString();
    this.records.set(shortcode, { channel, pickedAt });
    const pool = await getPool();
    await pool.query(
      `INSERT INTO reel_history (shortcode, profile_key, channel, picked_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [shortcode, this.profileKey, channel, pickedAt],
    );
  }

  public async markPublished(
    shortcode: string,
    youtubeUrl?: string,
    instagramUrl?: string,
    facebookUrl?: string,
    youtubeVideoId?: string,
    instagramMediaId?: string,
    facebookVideoId?: string,
  ): Promise<void> {
    const rec = this.records.get(shortcode);
    if (!rec) return;
    const publishedAt = new Date().toISOString();
    rec.publishedAt = publishedAt;
    rec.failed = false;
    rec.failedReason = undefined;
    if (youtubeUrl) rec.youtubeUrl = youtubeUrl;
    if (instagramUrl) rec.instagramUrl = instagramUrl;
    if (facebookUrl) rec.facebookUrl = facebookUrl;
    if (youtubeVideoId) rec.youtubeVideoId = youtubeVideoId;
    if (instagramMediaId) rec.instagramMediaId = instagramMediaId;
    if (facebookVideoId) rec.facebookVideoId = facebookVideoId;
    const pool = await getPool();
    await pool.query(
      `UPDATE reel_history
       SET published_at = $1, youtube_url = $2, instagram_url = $3, facebook_url = $4,
           youtube_video_id = $5, instagram_media_id = $6, facebook_video_id = $7,
           failed = false, failed_reason = NULL
       WHERE shortcode = $8 AND profile_key = $9`,
      [
        publishedAt,
        youtubeUrl ?? null,
        instagramUrl ?? null,
        facebookUrl ?? null,
        youtubeVideoId ?? null,
        instagramMediaId ?? null,
        facebookVideoId ?? null,
        shortcode,
        this.profileKey,
      ],
    );
  }

  public async markFailed(shortcode: string, reason?: string): Promise<void> {
    const rec = this.records.get(shortcode);
    if (!rec) return;
    rec.failed = true;
    rec.failedReason = reason;
    const pool = await getPool();
    await pool.query(
      `UPDATE reel_history SET failed = true, failed_reason = $1
       WHERE shortcode = $2 AND profile_key = $3`,
      [reason ?? "Unknown error", shortcode, this.profileKey],
    );
  }

  public size(): number {
    return this.records.size;
  }

  /** One-time migration from legacy processedShortcodes array. */
  public async migrate(shortcodes: string[]): Promise<void> {
    let added = 0;
    for (const s of shortcodes) {
      if (this.records.has(s)) continue;
      const pickedAt = new Date(0).toISOString();
      this.records.set(s, { channel: "unknown", pickedAt });
      const pool = await getPool();
      await pool.query(
        `INSERT INTO reel_history (shortcode, profile_key, channel, picked_at)
         VALUES ($1, $2, 'unknown', $3) ON CONFLICT DO NOTHING`,
        [s, this.profileKey, pickedAt],
      );
      added++;
    }
    if (added > 0) {
      pipelineLogger.info(
        `Migrated ${added} legacy shortcode(s) into reel history [${this.profileKey}]`,
        "ReelHistoryStore",
      );
    }
  }
}
