import fs from "fs";
import path from "path";
import { config } from "../config";
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
 * guard to Supabase (PostgreSQL) with local JSON backup fallback so a server restart
 * mid-day resumes exactly where it left off.
 *
 * Reads are served from in-memory state (fast, sync) populated once at startup
 * via load(). All writes persist immediately to Supabase + local backup.
 */
export class WatchStore {
  private profileKey: string;
  private queue: QueuedReel[] = [];
  private lastBatchDate = "";
  private channelSequence: string[] = [];
  private currentSlot = 0;
  private localBackupFile: string;

  constructor(dbKey?: string) {
    this.profileKey = dbKey ?? "default";
    const logDir = config.paths.logDir || path.resolve(__dirname, "../../logs");
    if (!fs.existsSync(logDir)) {
      try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
    }
    this.localBackupFile = path.join(logDir, `watch_state_${this.profileKey}.json`);
  }

  public async load(): Promise<void> {
    try {
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
        this.saveLocalBackup();
        return;
      }
    } catch (err) {
      pipelineLogger.warn(
        `Failed to load watch state from Supabase for [${this.profileKey}]: ${err instanceof Error ? err.message : err}. Checking local backup...`,
        "WatchStore",
      );
    }

    // Fall back to local backup file
    if (fs.existsSync(this.localBackupFile)) {
      try {
        const raw = fs.readFileSync(this.localBackupFile, "utf8");
        const data = JSON.parse(raw);
        this.queue = data.queue ?? [];
        this.lastBatchDate = data.lastBatchDate ?? "";
        this.channelSequence = data.channelSequence ?? [];
        this.currentSlot = data.currentSlot ?? 0;
        pipelineLogger.info(`Restored watch state for [${this.profileKey}] from local backup`, "WatchStore");
        return;
      } catch (_) {}
    }

    await this.save();
  }

  private saveLocalBackup(): void {
    try {
      const data = {
        profileKey: this.profileKey,
        queue: this.queue,
        lastBatchDate: this.lastBatchDate,
        channelSequence: this.channelSequence,
        currentSlot: this.currentSlot,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.localBackupFile, JSON.stringify(data, null, 2), "utf8");
    } catch (_) {}
  }

  private async save(): Promise<void> {
    this.saveLocalBackup();
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
      pipelineLogger.warn(
        `Failed to write watch state to Supabase for [${this.profileKey}] (saved to local backup): ${err instanceof Error ? err.message : err}`,
        "WatchStore",
      );
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
