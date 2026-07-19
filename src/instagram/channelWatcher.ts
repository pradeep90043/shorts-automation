import { ChannelProfile } from "../config";
import { TelegramService } from "../telegram";
import { WatchStore, QueuedReel } from "../utils/watchStore";
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

  constructor(
    private profile: ChannelProfile,
    private telegram: TelegramService,
  ) {
    this.store = new WatchStore(profile.isDefault ? undefined : profile.key);
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

  private checkAndRunMissedBatch(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.store.getLastBatchDate() === today) {
      return; // already ran today
    }

    const [hh, mm] = this.profile.watch.scheduleTime.split(":").map(Number);
    const now = new Date();
    const scheduledToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hh || 0,
      mm || 0,
      0,
      0,
    );

    if (now.getTime() >= scheduledToday.getTime()) {
      pipelineLogger.info(
        `[${this.profile.brandName}] Startup is after scheduled time (${this.profile.watch.scheduleTime}) and no batch ran today. Triggering missed daily batch selection...`,
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
    const [hh, mm] = this.profile.watch.scheduleTime.split(":").map(Number);
    const now = new Date();
    const next = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hh || 0,
      mm || 0,
      0,
      0,
    );
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
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
          if (!this.store.hasProcessed(r.shortcode)) {
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
    picked.forEach((p) => this.store.markProcessed(p.shortcode));
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
    for (const item of this.store.getQueue()) {
      if (item.fired) continue;
      if (new Date(item.scheduledAt).getTime() > now) continue;
      this.store.markFired(item.shortcode); // mark before triggering — never double-fire
      pipelineLogger.info(
        `[${this.profile.brandName}] Auto-publishing queued reel @${item.channel}/${item.shortcode}`,
        "ChannelWatcher",
      );
      this.telegram.runPresetReel(
        item.url,
        this.profile.watch.adminChatId,
        0,
        undefined,
        item.channel,
      );
    }
  }
}
