import fs from "fs";
import os from "os";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "./logger";

export interface ReelRecord {
  channel: string;
  pickedAt: string;
  publishedAt?: string;
  youtubeUrl?: string;
  instagramUrl?: string;
  failed?: boolean;
  failedReason?: string;
}

/**
 * Permanent, append-only store for every reel the channel-watcher has ever
 * picked.  Lives in a separate file from the daily queue state so it survives
 * server restarts, fresh deployments, and watch_state resets without losing
 * the record of what has already been published.
 *
 * Unlike the old processedShortcodes ring buffer (capped at 1000), this store
 * grows without bound and tracks full publish / fail metadata per reel.
 */
export class ReelHistoryStore {
  private filePath: string;
  private records = new Map<string, ReelRecord>();

  constructor(dbKey?: string) {
    const dataDir = config.paths.dataDir || path.join(os.homedir(), ".shorts-automation");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(
      dataDir,
      dbKey ? `reel_history_${dbKey}.json` : "reel_history.json",
    );
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, ReelRecord>;
        for (const [shortcode, record] of Object.entries(parsed)) {
          this.records.set(shortcode, record);
        }
        pipelineLogger.info(
          `Loaded ${this.records.size} reel history record(s)`,
          "ReelHistoryStore",
        );
      } else {
        this.save();
      }
    } catch (err) {
      pipelineLogger.warn(
        `Failed to parse reel history file: ${err instanceof Error ? err.message : err}. Reinitializing.`,
        "ReelHistoryStore",
      );
    }
  }

  private save(): void {
    try {
      const obj: Record<string, ReelRecord> = {};
      for (const [k, v] of this.records.entries()) obj[k] = v;
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(obj, null, 2), "utf8");
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      pipelineLogger.error("Failed to write reel history file", err, "ReelHistoryStore");
    }
  }

  /** True if this shortcode has ever been picked (regardless of publish outcome). */
  public has(shortcode: string): boolean {
    return this.records.has(shortcode);
  }

  /** Record a newly-picked reel before it enters the publish queue. */
  public add(shortcode: string, channel: string): void {
    if (this.records.has(shortcode)) return;
    this.records.set(shortcode, {
      channel,
      pickedAt: new Date().toISOString(),
    });
    this.save();
  }

  public markPublished(
    shortcode: string,
    youtubeUrl?: string,
    instagramUrl?: string,
  ): void {
    const rec = this.records.get(shortcode);
    if (!rec) return;
    rec.publishedAt = new Date().toISOString();
    rec.failed = false;
    rec.failedReason = undefined;
    if (youtubeUrl) rec.youtubeUrl = youtubeUrl;
    if (instagramUrl) rec.instagramUrl = instagramUrl;
    this.save();
  }

  public markFailed(shortcode: string, reason?: string): void {
    const rec = this.records.get(shortcode);
    if (!rec) return;
    rec.failed = true;
    rec.failedReason = reason;
    this.save();
  }

  public size(): number {
    return this.records.size;
  }

  /**
   * One-time migration: import legacy processedShortcodes from the old
   * watch_state.json (array of strings, no metadata).  Safe to call on every
   * startup — entries that already exist are skipped.
   */
  public migrate(shortcodes: string[]): void {
    let added = 0;
    for (const s of shortcodes) {
      if (!this.records.has(s)) {
        this.records.set(s, {
          channel: "unknown",
          pickedAt: new Date(0).toISOString(),
        });
        added++;
      }
    }
    if (added > 0) {
      this.save();
      pipelineLogger.info(
        `Migrated ${added} legacy shortcode(s) into reel history`,
        "ReelHistoryStore",
      );
    }
  }
}
