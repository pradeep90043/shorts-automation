import { getPool } from "./pgClient";
import { pipelineLogger } from "./logger";

export interface QueuedReel {
  shortcode: string;
  url: string;
  channel: string;
  scheduledAt: string;
  fired: boolean;
  jobId?: string;
  published?: boolean;
  publishedYoutubeUrl?: string;
  publishedInstagramUrl?: string;
  publishedFacebookUrl?: string;
  failed?: boolean;
  failedReason?: string;
  addedAt?: string;
}

interface WatchStateRow {
  profile_key: string;
  queue: QueuedReel[];
  last_batch_date: string;
  channel_sequence: string[];
  current_slot: number;
}

/**
 * Persists the current day's staggered publish queue and the last-batch-date
 * guard to Supabase (PostgreSQL) so a server restart mid-day resumes exactly
 * where it left off.
 *
 * Reads are served from in-memory state (fast, sync) populated once at startup
 * via load(). All writes persist immediately to Supabase.
 */
export class WatchStore {
  private profileKey: string;
  private queue: QueuedReel[] = [];
  private lastBatchDate = "";
  private channelSequence: string[] = [];
  private currentSlot = 0;

  constructor(dbKey?: string) {
    this.profileKey = dbKey ?? "default";
  }

  public async load(): Promise<void> {
    const pool = await getPool();
    const { rows } = await pool.query<WatchStateRow>(
      `SELECT queue, last_batch_date, channel_sequence, current_slot FROM watch_state WHERE profile_key = $1`,
      [this.profileKey],
    );
    if (rows.length > 0) {
      this.queue = rows[0].queue ?? [];
      this.lastBatchDate = rows[0].last_batch_date ?? "";
      this.channelSequence = rows[0].channel_sequence ?? [];
      this.currentSlot = rows[0].current_slot ?? 0;
    } else {
      await this.save();
    }
  }

  private async save(): Promise<void> {
    try {
      const pool = await getPool();
      await pool.query(
        `INSERT INTO watch_state (profile_key, queue, last_batch_date, channel_sequence, current_slot)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (profile_key) DO UPDATE
           SET queue            = EXCLUDED.queue,
               last_batch_date  = EXCLUDED.last_batch_date,
               channel_sequence = EXCLUDED.channel_sequence,
               current_slot     = EXCLUDED.current_slot`,
        [this.profileKey, JSON.stringify(this.queue), this.lastBatchDate, JSON.stringify(this.channelSequence), this.currentSlot],
      );
    } catch (err) {
      pipelineLogger.error("Failed to write watch state to Supabase", err, "WatchStore");
    }
  }

  /** Legacy migration support — no-op since old JSON files are no longer used. */
  public drainLegacyShortcodes(): string[] {
    return [];
  }

  public getQueue(): QueuedReel[] {
    return this.queue;
  }

  public async setQueue(queue: QueuedReel[]): Promise<void> {
    this.queue = queue;
    await this.save();
  }

  public async markFired(shortcode: string, jobId?: string): Promise<void> {
    const entry = this.queue.find((q) => q.shortcode === shortcode);
    if (entry) {
      entry.fired = true;
      if (jobId) entry.jobId = jobId;
    }
    await this.save();
  }

  public async markPublished(
    shortcode: string,
    youtubeUrl?: string,
    instagramUrl?: string,
    facebookUrl?: string,
  ): Promise<void> {
    const entry = this.queue.find((q) => q.shortcode === shortcode);
    if (entry) {
      entry.published = true;
      entry.failed = false;
      entry.failedReason = undefined;
      if (youtubeUrl) entry.publishedYoutubeUrl = youtubeUrl;
      if (instagramUrl) entry.publishedInstagramUrl = instagramUrl;
      if (facebookUrl) entry.publishedFacebookUrl = facebookUrl;
    }
    await this.save();
  }

  public async markFailed(shortcode: string, reason?: string): Promise<void> {
    const entry = this.queue.find((q) => q.shortcode === shortcode);
    if (entry) {
      entry.failed = true;
      entry.published = false;
      entry.failedReason = reason || "Unknown error";
    }
    await this.save();
  }

  public getChannelSequence(): string[] {
    return this.channelSequence;
  }

  public async setChannelSequence(channels: string[]): Promise<void> {
    this.channelSequence = channels;
    this.currentSlot = 0;
    await this.save();
  }

  public getCurrentSlot(): number {
    return this.currentSlot;
  }

  public async advanceSlot(): Promise<void> {
    this.currentSlot++;
    await this.save();
  }

  public getLastBatchDate(): string {
    return this.lastBatchDate;
  }

  public async setLastBatchDate(date: string): Promise<void> {
    this.lastBatchDate = date;
    await this.save();
  }
}
