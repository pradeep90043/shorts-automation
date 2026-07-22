import { getDb } from "./mongoClient";
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
  failed?: boolean;
  failedReason?: string;
}

interface WatchStateDoc {
  profileKey: string;
  // Legacy field — still read on first load so migrate() can import it into
  // ReelHistoryStore, then dropped from subsequent saves.
  processedShortcodes?: string[];
  queue: QueuedReel[];
  lastBatchDate: string;
}

const COLLECTION = "watch_state";

/**
 * Persists the current day's staggered publish queue and the last-batch-date
 * guard to MongoDB so a server restart mid-day resumes exactly where it left off.
 *
 * Reads are served from in-memory state (fast, sync) populated once at startup
 * via load(). All writes persist immediately to MongoDB Atlas.
 */
export class WatchStore {
  private profileKey: string;
  private state: WatchStateDoc;

  constructor(dbKey?: string) {
    this.profileKey = dbKey ?? "default";
    this.state = { profileKey: this.profileKey, queue: [], lastBatchDate: "" };
  }

  public async load(): Promise<void> {
    const db = await getDb();
    const doc = await db
      .collection<WatchStateDoc>(COLLECTION)
      .findOne({ profileKey: this.profileKey });
    if (doc) {
      this.state = doc as WatchStateDoc;
    } else {
      await this.save();
    }
  }

  private async save(): Promise<void> {
    try {
      const db = await getDb();
      const { processedShortcodes: _, ...rest } = this.state;
      await db.collection<WatchStateDoc>(COLLECTION).updateOne(
        { profileKey: this.profileKey },
        { $set: rest },
        { upsert: true },
      );
    } catch (err) {
      pipelineLogger.error("Failed to write watch state to MongoDB", err, "WatchStore");
    }
  }

  /**
   * Returns the legacy processedShortcodes array loaded from an old-format
   * document so ChannelWatcher can migrate them into ReelHistoryStore.
   * Returns [] if already in the new format.
   */
  public drainLegacyShortcodes(): string[] {
    const codes = this.state.processedShortcodes ?? [];
    if (codes.length > 0) {
      delete this.state.processedShortcodes;
    }
    return codes;
  }

  public getQueue(): QueuedReel[] {
    return this.state.queue;
  }

  public async setQueue(queue: QueuedReel[]): Promise<void> {
    this.state.queue = queue;
    await this.save();
  }

  public async markFired(shortcode: string, jobId?: string): Promise<void> {
    const entry = this.state.queue.find((q) => q.shortcode === shortcode);
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
  ): Promise<void> {
    const entry = this.state.queue.find((q) => q.shortcode === shortcode);
    if (entry) {
      entry.published = true;
      entry.failed = false;
      entry.failedReason = undefined;
      if (youtubeUrl) entry.publishedYoutubeUrl = youtubeUrl;
      if (instagramUrl) entry.publishedInstagramUrl = instagramUrl;
    }
    await this.save();
  }

  public async markFailed(shortcode: string, reason?: string): Promise<void> {
    const entry = this.state.queue.find((q) => q.shortcode === shortcode);
    if (entry) {
      entry.failed = true;
      entry.published = false;
      entry.failedReason = reason || "Unknown error";
    }
    await this.save();
  }

  public getLastBatchDate(): string {
    return this.state.lastBatchDate;
  }

  public async setLastBatchDate(date: string): Promise<void> {
    this.state.lastBatchDate = date;
    await this.save();
  }
}
