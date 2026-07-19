import fs from "fs";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "./logger";

const MAX_PROCESSED_SHORTCODES = 1000;

export interface QueuedReel {
  shortcode: string;
  url: string;
  channel: string;
  scheduledAt: string; // ISO — when this reel should be auto-published
  fired: boolean;
}

interface WatchState {
  processedShortcodes: string[]; // ring buffer, newest appended at the end
  queue: QueuedReel[]; // current/most-recent daily batch
  lastBatchDate: string; // "YYYY-MM-DD" (local) — guards against picking twice in one day
}

const EMPTY_STATE: WatchState = {
  processedShortcodes: [],
  queue: [],
  lastBatchDate: "",
};

/**
 * Persists which Instagram reels the channel-watch automation has already
 * picked (so it never republishes the same reel) and the current day's
 * staggered publish queue (so a server restart mid-day resumes correctly).
 * Follows the same atomic-write pattern as JobDatabase (src/utils/db.ts):
 * unique per-write temp filename + rename, to avoid the JSON corruption this
 * project previously hit from concurrent writers sharing one temp path.
 */
export class WatchStore {
  private filePath: string;
  private state: WatchState = { ...EMPTY_STATE, processedShortcodes: [], queue: [] };

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
      this.state = { processedShortcodes: [], queue: [], lastBatchDate: "" };
    }
  }

  private save(): void {
    try {
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), "utf8");
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      pipelineLogger.error("Failed to write watch state file", err, "WatchStore");
    }
  }

  public hasProcessed(shortcode: string): boolean {
    return this.state.processedShortcodes.includes(shortcode);
  }

  public markProcessed(shortcode: string): void {
    if (this.state.processedShortcodes.includes(shortcode)) return;
    this.state.processedShortcodes.push(shortcode);
    if (this.state.processedShortcodes.length > MAX_PROCESSED_SHORTCODES) {
      this.state.processedShortcodes = this.state.processedShortcodes.slice(
        -MAX_PROCESSED_SHORTCODES,
      );
    }
    this.save();
  }

  public getQueue(): QueuedReel[] {
    return this.state.queue;
  }

  public setQueue(queue: QueuedReel[]): void {
    this.state.queue = queue;
    this.save();
  }

  public markFired(shortcode: string): void {
    const entry = this.state.queue.find((q) => q.shortcode === shortcode);
    if (entry) entry.fired = true;
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
