import { ChannelProfile } from "../config";
import { TelegramService } from "../telegram";
import { WatchStore, QueuedReel } from "../utils/watchStore";
import { ReelHistoryStore } from "../utils/reelHistoryStore";
import { JobDatabase } from "../utils/db";
import { listChannelReels } from "./channelFeed";
import { pipelineLogger } from "../utils/logger";

/**
 * Recurring Instagram-channel-watch automation for one channel profile.
 * Once a day (profile.watch.scheduleTime), pools the recent not-yet-picked
 * reels across all of profile.watch.channels, randomly samples
 * profile.watch.dailyCount of them, and publishes them one at a time,
 * profile.watch.gapHours apart, reusing the exact same preset-settings
 * skip-gate pipeline path validated by TelegramService.runPresetReel.
 */
export class ChannelWatcher {
  private store: WatchStore;
  private history: ReelHistoryStore;
  private db: JobDatabase;

  constructor(
    private profile: ChannelProfile,
    private telegram: TelegramService,
  ) {
    const dbKey = profile.isDefault ? undefined : profile.key;
    this.store = new WatchStore(dbKey);
    this.history = new ReelHistoryStore(dbKey);
    this.db = new JobDatabase(dbKey);

    // One-time migration: import legacy processedShortcodes from watch_state.json
    // into the new permanent ReelHistoryStore, then drop them from watch_state.
    const legacy = this.store.drainLegacyShortcodes();
    if (legacy.length > 0) this.history.migrate(legacy);
  }

  public start(): void {
    const { channels, adminChatId } = this.profile.watch;
    if (channels.length === 0 || !adminChatId) {
      return; // feature not configured for this profile
    }

    // Run missed batch selection immediately on startup if we are past the scheduled time
    // and no batch has run today yet (helps recover from restarts, redeployments, or crashes)
    this.checkAndRunMissedBatch();

    this.scheduleDailyBatch();
    setInterval(() => {
      this.processQueue().catch((err) => {
        pipelineLogger.error(
          `[${this.profile.brandName}] Watch queue tick failed`,
          err,
          "ChannelWatcher",
        );
      });
    }, 60 * 1000);

    pipelineLogger.info(
      `[${this.profile.brandName}] Channel watch started — ${channels.length} channel(s) ` +
        `(${channels.join(", ")}), ${this.profile.watch.dailyCount}/day at ` +
        `${this.profile.watch.scheduleTime}, ${this.profile.watch.gapHours}h apart`,
      "ChannelWatcher",
    );
  }

  // scheduleTime (HH:MM) is always treated as IST (UTC+5:30) so the Oracle
  // VM running in UTC fires at the correct wall-clock time in India.
  private static readonly IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

  /** Current UTC ms shifted into IST. */
  private nowIstMs(): number {
    return Date.now() + ChannelWatcher.IST_OFFSET_MS;
  }

  /**
   * UTC ms for today's schedule time, where "today" is the IST calendar date
   * and HH:MM is the configured IST time.
   */
  private todayScheduleUtcMs(): number {
    const [hh, mm] = this.profile.watch.scheduleTime.split(":").map(Number);
    const nowIst = new Date(this.nowIstMs());
    // Build HH:MM on today's IST date, then shift back to UTC
    return (
      Date.UTC(
        nowIst.getUTCFullYear(),
        nowIst.getUTCMonth(),
        nowIst.getUTCDate(),
        hh || 0,
        mm || 0,
        0,
        0,
      ) - ChannelWatcher.IST_OFFSET_MS
    );
  }

  private checkAndRunMissedBatch(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.store.getLastBatchDate() === today) {
      return; // already ran today
    }

    if (Date.now() >= this.todayScheduleUtcMs()) {
      pipelineLogger.info(
        `[${this.profile.brandName}] Startup is after scheduled IST time (${this.profile.watch.scheduleTime} IST) and no batch ran today. Triggering missed daily batch selection...`,
        "ChannelWatcher",
      );
      this.runDailyBatch().catch((err) => {
        pipelineLogger.error(
          `[${this.profile.brandName}] Missed daily batch execution failed`,
          err,
          "ChannelWatcher",
        );
      });
    }
  }

  private scheduleDailyBatch(): void {
    const fire = () => {
      this.runDailyBatch().catch((err) => {
        pipelineLogger.error(
          `[${this.profile.brandName}] Daily batch failed`,
          err,
          "ChannelWatcher",
        );
      });
    };
    setTimeout(() => {
      fire();
      setInterval(fire, 24 * 60 * 60 * 1000);
    }, this.msUntilNextScheduleTime());
  }

  private msUntilNextScheduleTime(): number {
    const nowMs = Date.now();
    const scheduledMs = this.todayScheduleUtcMs();
    if (scheduledMs <= nowMs) {
      // Already past today's IST schedule — fire tomorrow
      return scheduledMs + 24 * 60 * 60 * 1000 - nowMs;
    }
    return scheduledMs - nowMs;
  }

  /**
   * Selects and enqueues one day's batch. `force` bypasses the
   * once-per-calendar-day guard — used by the manual /runwatchnow debug
   * command to verify the flow without waiting for the scheduled time.
   */
  public async runDailyBatch(force = false): Promise<QueuedReel[]> {
    const today = new Date().toISOString().slice(0, 10);
    if (!force && this.store.getLastBatchDate() === today) {
      pipelineLogger.info(
        `[${this.profile.brandName}] Daily batch already ran today — skipping`,
        "ChannelWatcher",
      );
      return [];
    }

    const pool: Array<{ shortcode: string; url: string; channel: string }> = [];
    for (const channel of this.profile.watch.channels) {
      try {
        const reels = await listChannelReels(channel);
        for (const r of reels) {
          if (!this.history.has(r.shortcode)) {
            pool.push({ ...r, channel });
          }
        }
      } catch (err) {
        pipelineLogger.error(
          `[${this.profile.brandName}] Failed to list reels for @${channel}`,
          err,
          "ChannelWatcher",
        );
      }
      // Pause between channels to avoid Instagram 429 rate-limiting
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Fisher-Yates shuffle so picks are spread across all channels, not
    // biased toward whichever channel happened to be listed first.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = pool.slice(0, this.profile.watch.dailyCount);

    if (picked.length < this.profile.watch.dailyCount) {
      pipelineLogger.warn(
        `[${this.profile.brandName}] Only found ${picked.length}/${this.profile.watch.dailyCount} ` +
          `unprocessed reel(s) across ${this.profile.watch.channels.length} channel(s) today.`,
        "ChannelWatcher",
      );
    }

    const gapMs = this.profile.watch.gapHours * 60 * 60 * 1000;
    const startTime = Date.now();
    const queue: QueuedReel[] = picked.map((p, i) => ({
      shortcode: p.shortcode,
      url: p.url,
      channel: p.channel,
      scheduledAt: new Date(startTime + i * gapMs).toISOString(),
      fired: false,
    }));

    // Reserve immediately so a crash/retry can never re-pick the same reel.
    // Written to the permanent ReelHistoryStore (survives deployments) so that
    // even a fresh watch_state.json cannot cause the same reel to be re-picked.
    picked.forEach((p) => this.history.add(p.shortcode, p.channel));
    this.store.setQueue(queue);
    this.store.setLastBatchDate(today);

    const channelCount = new Set(picked.map((p) => p.channel)).size;
    pipelineLogger.info(
      `[${this.profile.brandName}] Daily batch selected: ${queue.length} reel(s) across ` +
        `${channelCount} channel(s), spaced ${this.profile.watch.gapHours}h apart.`,
      "ChannelWatcher",
    );
    return queue;
  }

  private async processQueue(): Promise<void> {
    const now = Date.now();
    // Fire at most one due reel per tick so that overdue reels (e.g. after a
    // recovery from downtime) publish one-by-one rather than all at once.
    let firedThisTick = false;

    for (const item of this.store.getQueue()) {
      // Fire the next due reel that hasn't been fired yet (one per tick)
      if (!item.fired) {
        if (firedThisTick || new Date(item.scheduledAt).getTime() > now) continue;
        const jobId = this.telegram.runPresetReel(
          item.url,
          this.profile.watch.adminChatId,
          0,
          undefined,
          item.channel,
        );
        this.store.markFired(item.shortcode, jobId); // mark before any await — never double-fire
        firedThisTick = true;
        pipelineLogger.info(
          `[${this.profile.brandName}] Auto-publishing queued reel @${item.channel}/${item.shortcode} (jobId: ${jobId})`,
          "ChannelWatcher",
        );
        continue;
      }

      // For fired reels that haven't been resolved yet, poll the JobDatabase
      if (item.fired && !item.published && !item.failed && item.jobId) {
        const job = this.db.getJob(item.jobId);
        if (!job) continue; // job record not yet created

        if (job.status === "completed") {
          this.store.markPublished(item.shortcode, job.youtubeUrl, job.instagramUrl);
          this.history.markPublished(item.shortcode, job.youtubeUrl, job.instagramUrl);
          pipelineLogger.info(
            `[${this.profile.brandName}] Reel @${item.channel}/${item.shortcode} marked published — YT: ${job.youtubeUrl || "N/A"} IG: ${job.instagramUrl || "N/A"}`,
            "ChannelWatcher",
          );
        } else if (job.status === "failed") {
          this.store.markFailed(item.shortcode, job.error || "Pipeline failed");
          this.history.markFailed(item.shortcode, job.error || "Pipeline failed");
          pipelineLogger.warn(
            `[${this.profile.brandName}] Reel @${item.channel}/${item.shortcode} marked failed — ${job.error}`,
            "ChannelWatcher",
          );
        }
      }
    }
  }

  public getStatusDetails() {
    return {
      channels: this.profile.watch.channels,
      dailyCount: this.profile.watch.dailyCount,
      scheduleTime: this.profile.watch.scheduleTime,
      gapHours: this.profile.watch.gapHours,
      adminChatId: this.profile.watch.adminChatId,
      lastBatchDate: this.store.getLastBatchDate(),
      queue: this.store.getQueue(),
    };
  }
}
