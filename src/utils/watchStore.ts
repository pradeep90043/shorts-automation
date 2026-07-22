import fs from "fs";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "./logger";

export interface QueuedReel {
  shortcode: string;
  url: string;
  channel: string;
  scheduledAt: string; // ISO — when this reel should be auto-published
  fired: boolean;
  /** Job ID created by runPresetReel so we can poll JobDatabase for result */
  jobId?: string;
  /** Set to true once the pipeline job completed successfully */
  published?: boolean;
  /** YouTube URL of the published short (populated after job completes) */
  publishedYoutubeUrl?: string;
  /** Instagram URL of the published short (populated after job completes) */
  publishedInstagramUrl?: string;
  /** Set to true if the pipeline job failed */
  failed?: boolean;
  /** Human-readable failure reason */
  failedReason?: string;
}

interface WatchState {
  // Legacy field — still read on first load so migrate() can import it into
  // ReelHistoryStore, then dropped from subsequent saves.
  processedShortcodes?: string[];
  queue: QueuedReel[];
  lastBatchDate: string;
}

const EMPTY_STATE: WatchState = {
  queue: [],
  lastBatchDate: "",
};

/**
 * Persists the current day's staggered publish queue and the last-batch-date
 * guard so a server restart mid-day resumes from exactly where it left off.
 *
 * Permanent published-reel history (which reels have ever been picked) is now
 * stored in ReelHistoryStore (reel_history.json) — a separate, unbounded file
 * that survives deployments and watch_state resets without losing history.
 */
export class WatchStore {
  private filePath: string;
  private state: WatchState = { ...EMPTY_STATE, queue: [] };

  constructor(dbKey?: string) {
    const logDir = config.paths.logDir || path.resolve(__dirname, "../../logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    this.filePath = path.join(
      logDir,
      dbKey ? `watch_state_${dbKey}.json` : "watch_state.json",
    );
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        this.state = { ...EMPTY_STATE, ...JSON.parse(raw) };
      } else {
        this.save();
      }
    } catch (err) {
      pipelineLogger.warn(
        `Failed to parse watch state file: ${err instanceof Error ? err.message : err}. Reinitializing.`,
        "WatchStore",
      );
      this.state = { queue: [], lastBatchDate: "" };
    }
  }

  private save(): void {
    try {
      // Omit the legacy processedShortcodes from the saved file — they now
      // live in ReelHistoryStore.  Once written, watch_state.json contains
      // only queue + lastBatchDate.
      const { processedShortcodes: _, ...rest } = this.state;
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(rest, null, 2), "utf8");
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      pipelineLogger.error("Failed to write watch state file", err, "WatchStore");
    }
  }

  /**
   * Returns the legacy processedShortcodes array loaded from an old-format
   * watch_state.json so ChannelWatcher can migrate them into ReelHistoryStore.
   * Returns [] if the file was already in the new format (no processedShortcodes).
   */
  public drainLegacyShortcodes(): string[] {
    const codes = this.state.processedShortcodes ?? [];
    if (codes.length > 0) {
      // Remove from state so subsequent saves omit it cleanly.
      delete this.state.processedShortcodes;
    }
    return codes;
  }

  public getQueue(): QueuedReel[] {
    return this.state.queue;
  }

  public setQueue(queue: QueuedReel[]): void {
    this.state.queue = queue;
    this.save();
  }

  public markFired(shortcode: string, jobId?: string): void {
    const entry = this.state.queue.find((q) => q.shortcode === shortcode);
    if (entry) {
      entry.fired = true;
      if (jobId) entry.jobId = jobId;
    }
    this.save();
  }

  public markPublished(
    shortcode: string,
    youtubeUrl?: string,
    instagramUrl?: string,
  ): void {
    const entry = this.state.queue.find((q) => q.shortcode === shortcode);
    if (entry) {
      entry.published = true;
      entry.failed = false;
      entry.failedReason = undefined;
      if (youtubeUrl) entry.publishedYoutubeUrl = youtubeUrl;
      if (instagramUrl) entry.publishedInstagramUrl = instagramUrl;
    }
    this.save();
  }

  public markFailed(shortcode: string, reason?: string): void {
    const entry = this.state.queue.find((q) => q.shortcode === shortcode);
    if (entry) {
      entry.failed = true;
      entry.published = false;
      entry.failedReason = reason || "Unknown error";
    }
    this.save();
  }

  public getLastBatchDate(): string {
    return this.state.lastBatchDate;
  }

  public setLastBatchDate(date: string): void {
    this.state.lastBatchDate = date;
    this.save();
  }
}
