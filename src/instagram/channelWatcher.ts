import { ChannelProfile } from "../config";
import { TelegramService } from "../telegram";
import { WatchStore, QueuedReel } from "../utils/watchStore";
import { ReelHistoryStore } from "../utils/reelHistoryStore";
import { JobDatabase } from "../utils/db";
import { listChannelReels } from "./channelFeed";
import { buildHashtagsForNiche, searchViralReels, ScoredReel, InstagramRateLimitError } from "./nicheSearcher";
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
  }

  // Pool of pre-scored reels from hashtag search, populated each daily batch.
  private hashtagReelPool: ScoredReel[] = [];

  public async start(): Promise<void> {
    const { channels, adminChatId, searchMode } = this.profile.watch;
    const isHashtagMode = searchMode === "hashtags" || searchMode === "both";
    if ((channels.length === 0 && !isHashtagMode) || !adminChatId) {
      return; // feature not configured for this profile
    }

    // Load persisted state from MongoDB before doing anything else
    await this.store.load();
    await this.history.load();

    // One-time migration: import legacy processedShortcodes into ReelHistoryStore
    const legacy = this.store.drainLegacyShortcodes();
    if (legacy.length > 0) await this.history.migrate(legacy);

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

    const modeDesc = searchMode === "hashtags"
      ? `hashtag search (threshold=${this.profile.watch.viralThreshold})`
      : searchMode === "both"
      ? `channels + hashtag search (threshold=${this.profile.watch.viralThreshold})`
      : `${channels.length} channel(s) (${channels.join(", ")})`;
    pipelineLogger.info(
      `[${this.profile.brandName}] Channel watch started — ${modeDesc}, ` +
        `${this.profile.watch.dailyCount}/day at ${this.profile.watch.scheduleTime}, ` +
        `${this.profile.watch.gapHours}h apart`,
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
    const batchRanToday = this.store.getLastBatchDate() === today;
    const queueIsEmpty = this.store.getQueue().length === 0;

    // Skip only if batch ran today AND queue has reels — an empty queue means
    // the previous run fetched nothing (e.g. Instagram 429) and we should retry.
    if (batchRanToday && !queueIsEmpty) {
      return;
    }

    if (Date.now() >= this.todayScheduleUtcMs()) {
      // Stagger profiles so they never hammer the Instagram API simultaneously.
      // isDefault = first profile (index 0) → no delay; secondary profiles → 5 min offset.
      const staggerMs = this.profile.isDefault ? 0 : 5 * 60 * 1000;
      pipelineLogger.info(
        `[${this.profile.brandName}] Startup is after scheduled IST time (${this.profile.watch.scheduleTime} IST) — ${batchRanToday ? "queue is empty, retrying batch" : "no batch ran today"}. Triggering batch selection in ${staggerMs / 1000}s...`,
        "ChannelWatcher",
      );
      setTimeout(() => {
        this.runDailyBatch(batchRanToday).catch((err) => {
          pipelineLogger.error(
            `[${this.profile.brandName}] Missed daily batch execution failed`,
            err,
            "ChannelWatcher",
          );
        });
      }, staggerMs);
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

    const { searchMode, channels, dailyCount, nicheHashtags, viralThreshold } = this.profile.watch;

    // ── Hashtag search (hashtags | both mode) ───────────────────────────────
    this.hashtagReelPool = [];
    if (searchMode === "hashtags" || searchMode === "both") {
      const hashtags = buildHashtagsForNiche(this.profile.theme, undefined, nicheHashtags);
      pipelineLogger.info(
        `[${this.profile.brandName}] Searching hashtags: #${hashtags.join(", #")} (threshold=${viralThreshold})`,
        "ChannelWatcher",
      );
      try {
        this.hashtagReelPool = await searchViralReels(
          hashtags,
          viralThreshold,
          20,
          this.history,
        );
        pipelineLogger.info(
          `[${this.profile.brandName}] Hashtag search returned ${this.hashtagReelPool.length} viral reel(s)`,
          "ChannelWatcher",
        );
      } catch (err) {
        if (err instanceof InstagramRateLimitError) {
          pipelineLogger.warn(
            `[${this.profile.brandName}] Hashtag search rate-limited — falling back to channel mode`,
            "ChannelWatcher",
          );
        } else {
          pipelineLogger.error(
            `[${this.profile.brandName}] Hashtag search failed`,
            err,
            "ChannelWatcher",
          );
        }
        // Pool stays empty; channel-mode fallback below fills the queue
      }
    }

    // ── Channel-list pool (channels | both mode, or hashtag fallback) ───────
    const pool: Array<{ shortcode: string; url: string; channel: string }> = [];
    if (searchMode === "channels" || searchMode === "both" || this.hashtagReelPool.length === 0) {
      for (const channel of channels) {
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
        await new Promise((r) => setTimeout(r, 15000));
      }

      // Fisher-Yates shuffle
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    }

    // ── Merge pools into final picks ─────────────────────────────────────────
    // In 'both' mode: fill first with hashtag pool (scored/viral), then supplement
    // with channel pool up to dailyCount.
    const allPicks: Array<{ shortcode: string; url: string; channel: string }> = [];
    const seenShortcodes = new Set<string>();

    for (const r of this.hashtagReelPool) {
      if (allPicks.length >= dailyCount) break;
      if (!seenShortcodes.has(r.shortcode)) {
        seenShortcodes.add(r.shortcode);
        allPicks.push({ shortcode: r.shortcode, url: r.url, channel: r.creatorUsername || r.channel });
      }
    }
    for (const r of pool) {
      if (allPicks.length >= dailyCount) break;
      if (!seenShortcodes.has(r.shortcode)) {
        seenShortcodes.add(r.shortcode);
        allPicks.push(r);
      }
    }

    const picked = allPicks.slice(0, dailyCount);

    if (picked.length < dailyCount) {
      pipelineLogger.warn(
        `[${this.profile.brandName}] Only found ${picked.length}/${dailyCount} unprocessed reel(s) today.`,
        "ChannelWatcher",
      );
    }

    const gapMs = this.profile.watch.gapHours * 60 * 60 * 1000;
    const startTime = this.todayScheduleUtcMs();
    const queue: QueuedReel[] = picked.map((p, i) => ({
      shortcode: p.shortcode,
      url: p.url,
      channel: p.channel,
      scheduledAt: new Date(startTime + i * gapMs).toISOString(),
      fired: false,
    }));

    // Reserve immediately so a crash/retry can never re-pick the same reel.
    await Promise.all(picked.map((p) => this.history.add(p.shortcode, p.channel)));
    await this.store.setQueue(queue);
    await this.store.setLastBatchDate(today);

    const sourceDesc = searchMode === "hashtags"
      ? "hashtag search"
      : searchMode === "both"
      ? `hashtag search + channels`
      : `${new Set(picked.map((p) => p.channel)).size} channel(s)`;
    pipelineLogger.info(
      `[${this.profile.brandName}] Daily batch selected: ${queue.length} reel(s) from ${sourceDesc}, ` +
        `spaced ${this.profile.watch.gapHours}h apart.`,
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
        await this.store.markFired(item.shortcode, jobId); // persist before anything else — never double-fire
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
          await this.store.markPublished(item.shortcode, job.youtubeUrl, job.instagramUrl);
          await this.history.markPublished(item.shortcode, job.youtubeUrl, job.instagramUrl);
          pipelineLogger.info(
            `[${this.profile.brandName}] Reel @${item.channel}/${item.shortcode} marked published — YT: ${job.youtubeUrl || "N/A"} IG: ${job.instagramUrl || "N/A"}`,
            "ChannelWatcher",
          );
        } else if (job.status === "failed") {
          await this.store.markFailed(item.shortcode, job.error || "Pipeline failed");
          await this.history.markFailed(item.shortcode, job.error || "Pipeline failed");
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
