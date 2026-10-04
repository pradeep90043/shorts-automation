import { ChannelProfile, config } from "../config";
import { TelegramService } from "../telegram";
import { WatchStore, QueuedReel } from "../utils/watchStore";
import { ReelHistoryStore } from "../utils/reelHistoryStore";
import { JobDatabase } from "../utils/db";
import {
  listChannelReels,
  listChannelReelsViaPuppeteer,
  searchHashtagReelsViaPuppeteer,
  searchReelsViaSearchEngine,
  InstagramSessionDeadError,
  ScraperCallbacks,
} from "./channelFeed";
import { buildHashtagsForNiche, searchViralReels, ScoredReel } from "./nicheSearcher";
import { pipelineLogger } from "../utils/logger";
import { refreshSessionForProfile, patchChannelCredentials } from "../utils/credentialStore";

/**
 * Recurring Instagram-channel-watch automation for one channel profile.
 * Once a day (profile.watch.scheduleTime), pools the recent not-yet-picked
 * reels across all of profile.watch.channels, randomly samples
 * profile.watch.dailyCount of them, and publishes them one at a time,
 * profile.watch.gapHours apart, reusing the exact same preset-settings
 * skip-gate pipeline path validated by TelegramService.runPresetReel.
 */
export const activeWatchers = new Map<string, ChannelWatcher>();

function isSessionError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("loginrequired") ||
    msg.includes("login required") ||
    msg.includes("login failed") ||
    msg.includes("login by session") ||
    msg.includes("session") ||
    msg.includes("challengerequired") ||
    msg.includes("please wait a few minutes")
  );
}

export class ChannelWatcher {
  public store: WatchStore;
  private history: ReelHistoryStore;
  private db: JobDatabase;
  private rateLimitedUntil: number | null = null;
  private isForcedRun = false;
  private static get RATE_LIMIT_COOLDOWN_MS(): number {
    return config.instagramScraper.rateLimitCooldownMs; // default 45 min
  }

  constructor(
    private profile: ChannelProfile,
    private telegram: TelegramService,
    private profileIndex: number,
  ) {
    const dbKey = profile.isDefault ? undefined : profile.key;
    this.store = new WatchStore(dbKey);
    this.history = new ReelHistoryStore(dbKey);
    this.db = new JobDatabase(dbKey);
    activeWatchers.set((profile.key || profile.brandName).toLowerCase(), this);
  }

  private getScraperEnvCandidates(): Record<string, string>[] {
    const candidates: Record<string, string>[] = [];

    // Candidate 1: Profile's own credentials
    const ownEnv = this.buildEnvForPrefix(this.profile.key.toUpperCase());
    if (ownEnv) candidates.push(ownEnv);

    // Candidate 2: Storiyum fallback (if not already candidate 1)
    if (this.profile.key.toLowerCase() !== "storiyum") {
      const storiyumEnv = this.buildEnvForPrefix("STORIYUM");
      if (storiyumEnv) candidates.push(storiyumEnv);
    }

    // Candidate 3: CodeOrCap fallback (if not already candidate 1)
    if (this.profile.key.toLowerCase() !== "codeorcap") {
      const codeorcapEnv = this.buildEnvForPrefix("CODEORCAP");
      if (codeorcapEnv) candidates.push(codeorcapEnv);
    }

    // Candidate 4: Global fallback (unprefixed)
    const globalEnv = {
      INSTAGRAM_USERNAME: process.env.INSTAGRAM_USERNAME || "",
      INSTAGRAM_PASSWORD: process.env.INSTAGRAM_PASSWORD || "",
      INSTAGRAM_TOTP_SECRET: process.env.INSTAGRAM_TOTP_SECRET || "",
      INSTAGRAM_SESSION_ID: process.env.INSTAGRAM_SESSION_ID || "",
      INSTAGRAM_SETTINGS_JSON: process.env.INSTAGRAM_SETTINGS_JSON || "",
      INSTAGRAM_PROXY: process.env.INSTAGRAM_PROXY || "",
    };
    if (globalEnv.INSTAGRAM_USERNAME || globalEnv.INSTAGRAM_SESSION_ID) {
      candidates.push(globalEnv);
    }

    // Deduplicate candidates by INSTAGRAM_USERNAME or INSTAGRAM_SESSION_ID
    const seen = new Set<string>();
    const uniqueCandidates: Record<string, string>[] = [];
    for (const cand of candidates) {
      const key = cand.INSTAGRAM_USERNAME || cand.INSTAGRAM_SESSION_ID || "";
      if (key && !seen.has(key)) {
        seen.add(key);
        uniqueCandidates.push(cand);
      }
    }

    return uniqueCandidates;
  }

  private buildEnvForPrefix(prefix: string): Record<string, string> | null {
    const username = process.env[`${prefix}_INSTAGRAM_USERNAME`] || "";
    const password = process.env[`${prefix}_INSTAGRAM_PASSWORD`] || "";
    const totp = process.env[`${prefix}_INSTAGRAM_TOTP_SECRET`] || "";
    const session = process.env[`${prefix}_INSTAGRAM_SESSION_ID`] || "";
    const settings = process.env[`${prefix}_INSTAGRAM_SETTINGS_JSON`] || process.env.INSTAGRAM_SETTINGS_JSON || "";
    const proxy = process.env[`${prefix}_INSTAGRAM_PROXY`] || process.env.INSTAGRAM_PROXY || "";

    if (!username && !session && !settings) return null;

    return {
      INSTAGRAM_USERNAME: username,
      INSTAGRAM_PASSWORD: password,
      INSTAGRAM_TOTP_SECRET: totp,
      INSTAGRAM_SESSION_ID: session,
      INSTAGRAM_SETTINGS_JSON: settings,
      INSTAGRAM_PROXY: proxy,
    };
  }

  /** Saves a freshly-obtained session ID from an in-flight Python login back to the DB and process.env. */
  private handleSessionRefresh(newSessionId: string): void {
    const prefix = this.profile.key.toUpperCase().replace(/-/g, "_");
    process.env[`${prefix}_INSTAGRAM_SESSION_ID`] = newSessionId;
    process.env.INSTAGRAM_SESSION_ID = newSessionId;
    patchChannelCredentials(this.profile.key, { instagramSessionId: newSessionId }).catch(() => {});
    pipelineLogger.info(
      `[${this.profile.brandName}] Session ID auto-refreshed and saved to DB`,
      "ChannelWatcher",
    );
  }

  /** Tracks whether we've already recorded this profile's session as healthy this process, to avoid redundant writes. */
  private lastKnownSessionOk = false;

  /** Persists the rotated instagrapi settings blob (device UUIDs + cookies) to the DB.
   *  A settings emit only happens after a valid login, so this is also our signal
   *  that the session is healthy again — clear any "expired" flag. */
  private handleSettingsRefresh(settingsB64: string): void {
    const prefix = this.profile.key.toUpperCase().replace(/-/g, "_");
    process.env[`${prefix}_INSTAGRAM_SETTINGS_JSON`] = settingsB64;
    process.env.INSTAGRAM_SETTINGS_JSON = settingsB64;
    const patch: Parameters<typeof patchChannelCredentials>[1] = { instagramSettingsJson: settingsB64 };
    if (!this.lastKnownSessionOk) patch.sessionDeadAt = null; // clear "expired" once
    this.lastKnownSessionOk = true;
    this.sessionDeadAlertedAt = 0;
    patchChannelCredentials(this.profile.key, patch).catch(() => {});
  }

  private scraperCallbacks(): ScraperCallbacks {
    return {
      onSessionRefresh: (sid) => this.handleSessionRefresh(sid),
      onSettingsRefresh: (blob) => this.handleSettingsRefresh(blob),
    };
  }

  /** Alert an admin (at most once per 6h) that the stored IG session is dead and needs a manual refresh. */
  private sessionDeadAlertedAt = 0;
  private async alertSessionDead(context: string, err: Error): Promise<void> {
    const now = Date.now();
    if (now - this.sessionDeadAlertedAt < 6 * 60 * 60 * 1000) return;
    this.sessionDeadAlertedAt = now;
    this.lastKnownSessionOk = false;
    patchChannelCredentials(this.profile.key, { sessionDeadAt: new Date() }).catch(() => {});
    pipelineLogger.error(
      `[${this.profile.brandName}] Instagram session is DEAD (${context}) — auto-refresh is disabled in session_only mode. A fresh sessionid must be pasted via the dashboard.`,
      err,
      "ChannelWatcher",
    );
    const chatId = this.profile.watch.adminChatId;
    if (chatId) {
      await this.telegram.sendMessage(
        chatId,
        `⚠️ *${this.profile.brandName}* — Instagram session expired\n\n` +
          `Reel ingestion is paused. Open the dashboard → *Channel Credentials* → paste a fresh \`sessionid\` ` +
          `cookie for this profile (copy it from a browser where the account is logged in).\n\n` +
          `_Context: ${context}_`,
      ).catch(() => {});
    }
  }

  private async searchViralReelsWithFallback(
    hashtags: string[],
    viralThreshold: number,
    limitPerTag: number,
    allowSessionRefresh = true,
  ): Promise<ScoredReel[]> {
    const candidates = this.getScraperEnvCandidates();
    let lastError: Error | null = null;

    for (const env of candidates) {
      try {
        pipelineLogger.info(
          `[${this.profile.brandName}] Attempting searchViralReels with account "${env.INSTAGRAM_USERNAME || 'session-only'}"...`,
          "ChannelWatcher",
        );
        return await searchViralReels(hashtags, viralThreshold, limitPerTag, this.history, env, this.scraperCallbacks());
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        pipelineLogger.warn(
          `[${this.profile.brandName}] searchViralReels failed with account "${env.INSTAGRAM_USERNAME || 'session-only'}": ${lastError.message}. Trying next fallback...`,
          "ChannelWatcher",
        );
      }
    }

    if (allowSessionRefresh && lastError && isSessionError(lastError)) {
      pipelineLogger.info(
        `[${this.profile.brandName}] All candidates failed with session error. Auto-refreshing session ID...`,
        "ChannelWatcher",
      );
      const newSession = await refreshSessionForProfile(this.profile.key).catch(() => null);
      if (newSession) {
        this.handleSessionRefresh(newSession);
        return this.searchViralReelsWithFallback(hashtags, viralThreshold, limitPerTag, false);
      }
    }

    // Browser-based fallback via Puppeteer (bypasses datacenter 429 rate limits & dead session cookies)
    try {
      pipelineLogger.info(
        `[${this.profile.brandName}] Private API rate-limited / failed — trying Puppeteer browser fallback for hashtags...`,
        "ChannelWatcher",
      );
      const puppeteerReels = await searchHashtagReelsViaPuppeteer(hashtags, limitPerTag);
      if (puppeteerReels.length > 0) {
        return puppeteerReels.map((r) => ({
          shortcode: r.shortcode,
          url: r.url,
          channel: r.creatorUsername || r.sourceHashtag || "hashtag",
          creatorUsername: r.creatorUsername,
          playCount: r.playCount,
          likeCount: r.likeCount,
          commentCount: r.commentCount,
          viralScore: 100,
        }));
      }
    } catch (pupErr) {
      pipelineLogger.warn(
        `[${this.profile.brandName}] Puppeteer hashtag fallback failed: ${pupErr instanceof Error ? pupErr.message : pupErr}`,
        "ChannelWatcher",
      );
    }

    if (lastError instanceof InstagramSessionDeadError) {
      await this.alertSessionDead("hashtag search", lastError);
    }

    // Last resort: search-engine discovery (no Instagram login). Engagement is unknown,
    // so these are unscored candidates rather than verified viral reels.
    const seReels = await this.discoverViaSearchEngine(Math.max(limitPerTag * 2, 10));
    if (seReels.length > 0) {
      return seReels.map((r) => ({
        shortcode: r.shortcode,
        url: r.url,
        channel: r.creatorUsername || r.sourceHashtag || this.profile.key,
        creatorUsername: r.creatorUsername,
        playCount: r.playCount,
        likeCount: r.likeCount,
        commentCount: r.commentCount,
        viralScore: 0,
      }));
    }

    throw lastError || new Error("All Instagram login candidates failed");
  }

  /** Search-engine reel discovery, filtered against history. Never throws. */
  private async discoverViaSearchEngine(limit: number) {
    try {
      const found = await searchReelsViaSearchEngine(this.profile.key, limit);
      const fresh = found.filter((r) => !this.history.has(r.shortcode));
      pipelineLogger.info(
        `[${this.profile.brandName}] Search-engine discovery: ${fresh.length} fresh of ${found.length} found`,
        "ChannelWatcher",
      );
      return fresh;
    } catch (err) {
      pipelineLogger.warn(
        `[${this.profile.brandName}] Search-engine discovery failed: ${err instanceof Error ? err.message : err}`,
        "ChannelWatcher",
      );
      return [];
    }
  }

  private async listChannelReelsWithFallback(channel: string, allowSessionRefresh = true): Promise<any[]> {
    const candidates = this.getScraperEnvCandidates();
    let lastError: Error | null = null;

    for (const env of candidates) {
      try {
        pipelineLogger.info(
          `[${this.profile.brandName}] Attempting listChannelReels with account "${env.INSTAGRAM_USERNAME || 'session-only'}"...`,
          "ChannelWatcher",
        );
        return await listChannelReels(channel, env, this.scraperCallbacks());
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        pipelineLogger.warn(
          `[${this.profile.brandName}] listChannelReels failed with account "${env.INSTAGRAM_USERNAME || 'session-only'}": ${lastError.message}. Trying next fallback...`,
          "ChannelWatcher",
        );
      }
    }

    if (lastError instanceof InstagramSessionDeadError) {
      await this.alertSessionDead(`channel @${channel}`, lastError);
    } else if (allowSessionRefresh && lastError && isSessionError(lastError)) {
      pipelineLogger.info(
        `[${this.profile.brandName}] All candidates failed with session error. Auto-refreshing session ID...`,
        "ChannelWatcher",
      );
      const newSession = await refreshSessionForProfile(this.profile.key).catch(() => null);
      if (newSession) {
        this.handleSessionRefresh(newSession);
        return this.listChannelReelsWithFallback(channel, false);
      }
    }

    // Browser-based fallback via Puppeteer (bypasses datacenter 429 rate limits)
    try {
      pipelineLogger.info(
        `[${this.profile.brandName}] Private API rate-limited / failed — trying Puppeteer browser fallback for @${channel}...`,
        "ChannelWatcher",
      );
      const puppeteerReels = await listChannelReelsViaPuppeteer(channel);
      if (puppeteerReels.length > 0) {
        return puppeteerReels;
      }
    } catch (pupErr) {
      pipelineLogger.warn(
        `[${this.profile.brandName}] Puppeteer channel fallback failed for @${channel}: ${pupErr instanceof Error ? pupErr.message : pupErr}`,
        "ChannelWatcher",
      );
    }

    // Last resort: search-engine discovery when scrapers/proxies are blocked.
    const freshSe = await this.discoverViaSearchEngine(10);
    if (freshSe.length > 0) {
      return freshSe.map((r) => ({
        shortcode: r.shortcode,
        url: r.url,
        creatorUsername: r.creatorUsername,
      }));
    }

    throw lastError || new Error("All Instagram login candidates failed");
  }

  // Pool of pre-scored reels from hashtag search, populated each daily batch.
  private hashtagReelPool: ScoredReel[] = [];

  public async start(): Promise<void> {
    const { channels, adminChatId, searchMode } = this.profile.watch;
    let activeSearchMode = searchMode || "hashtags";
    if (activeSearchMode === "channels" && (!channels || channels.length === 0)) {
      activeSearchMode = "hashtags";
    }
    const isHashtagMode = activeSearchMode === "hashtags" || activeSearchMode === "both";
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

    const modeDesc = activeSearchMode === "hashtags"
      ? `hashtag search (threshold=${this.profile.watch.viralThreshold})`
      : activeSearchMode === "both"
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
    const sequenceReady = this.store.getChannelSequence().length > 0;

    // If batch ran today and a channel sequence is set, processQueue handles the rest.
    if (batchRanToday && sequenceReady) {
      return;
    }

    const staggeredScheduledMs = this.todayScheduleUtcMs() + (this.profileIndex * 5 * 60 * 1000);
    if (Date.now() >= staggeredScheduledMs) {
      const staggerMs = this.profileIndex * 5 * 60 * 1000;
      pipelineLogger.info(
        `[${this.profile.brandName}] Startup is after scheduled IST time (${this.profile.watch.scheduleTime} IST, staggered) — ${batchRanToday ? "queue is empty, retrying batch" : "no batch ran today"}. Triggering batch selection in ${staggerMs / 1000}s...`,
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
    const scheduledMs = this.todayScheduleUtcMs() + (this.profileIndex * 5 * 60 * 1000);
    if (scheduledMs <= nowMs) {
      // Already past today's IST schedule — fire tomorrow
      return scheduledMs + 24 * 60 * 60 * 1000 - nowMs;
    }
    return scheduledMs - nowMs;
  }

  /**
   * Builds the day's channel sequence without calling Instagram at all.
   * Reels are fetched lazily in processQueue, one channel at a time, so that
   * Instagram API calls are spread across the day and never trigger 429s.
   *
   * `force` bypasses the once-per-calendar-day guard — used by /runwatchnow.
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

    const { searchMode, channels, dailyCount, nicheHashtags, viralThreshold, excludeChannels = [] } = this.profile.watch;
    const excludes = new Set(excludeChannels.map(c => c.toLowerCase().trim()));

    let activeSearchMode = searchMode || "hashtags";
    if (activeSearchMode === "channels" && (!channels || channels.length === 0)) {
      activeSearchMode = "hashtags";
    }

    // ── Hashtag search (hashtags | both mode) ───────────────────────────────
    this.hashtagReelPool = [];
    if (activeSearchMode === "hashtags" || activeSearchMode === "both") {
      const hashtags = buildHashtagsForNiche(this.profile.theme, undefined, nicheHashtags);
      pipelineLogger.info(
        `[${this.profile.brandName}] Searching hashtags: #${hashtags.join(", #")} (threshold=${viralThreshold})`,
        "ChannelWatcher",
      );
      try {
        this.hashtagReelPool = await this.searchViralReelsWithFallback(
          hashtags,
          viralThreshold,
          20,
        );
        pipelineLogger.info(
          `[${this.profile.brandName}] Hashtag search returned ${this.hashtagReelPool.length} viral reel(s)`,
          "ChannelWatcher",
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isRateLimit = err instanceof Error && (err.name === "InstagramRateLimitError" || errorMsg.includes("rate limited"));
        if (isRateLimit) {
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
    if (activeSearchMode === "channels" || activeSearchMode === "both" || this.hashtagReelPool.length === 0) {
      for (const channel of channels) {
        if (excludes.has(channel.toLowerCase().trim())) {
          continue;
        }
        try {
          const reels = await this.listChannelReelsWithFallback(channel);
          for (const r of reels) {
            if (!this.history.has(r.shortcode)) {
              pool.push({ ...r, channel });
            }
          }
        } catch (err) {
          if (err instanceof InstagramSessionDeadError) {
            await this.alertSessionDead(`batch selection @${channel}`, err);
            break; // every channel shares the same dead session — stop hammering
          }
          pipelineLogger.error(
            `[${this.profile.brandName}] Failed to list reels for @${channel}`,
            err,
            "ChannelWatcher",
          );
        }
        // Space out consecutive channel polls to stay well under Instagram's
        // per-minute limits (configurable; default 25s + up to 10s jitter).
        const base = config.instagramScraper.interChannelDelayMs;
        await new Promise((r) => setTimeout(r, base + Math.random() * 10000));
      }

      // Fisher-Yates shuffle
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    }

    if (pool.length === 0 && activeSearchMode === "channels") {
      pipelineLogger.info(
        `[${this.profile.brandName}] Watchlist pool is empty — falling back to hashtags search`,
        "ChannelWatcher",
      );
      const hashtags = buildHashtagsForNiche(this.profile.theme, undefined, nicheHashtags);
      try {
        this.hashtagReelPool = await this.searchViralReelsWithFallback(
          hashtags,
          viralThreshold,
          20,
        );
      } catch (err) {
        pipelineLogger.error(
          `[${this.profile.brandName}] Fallback hashtag search failed`,
          err,
          "ChannelWatcher",
        );
      }
    }

    // ── Merge pools into final picks ─────────────────────────────────────────
    // In 'both' mode: fill first with hashtag pool (scored/viral), then supplement
    // with channel pool up to dailyCount.
    const allPicks: Array<{ shortcode: string; url: string; channel: string }> = [];
    const seenShortcodes = new Set<string>();

    for (const r of this.hashtagReelPool) {
      if (allPicks.length >= dailyCount) break;
      const creator = (r.creatorUsername || r.channel || "").toLowerCase().trim();
      if (excludes.has(creator)) {
        pipelineLogger.info(`[${this.profile.brandName}] Excluding reel #${r.shortcode} from hashtag pool because it belongs to excluded channel: ${creator}`, "ChannelWatcher");
        continue;
      }
      if (!seenShortcodes.has(r.shortcode)) {
        seenShortcodes.add(r.shortcode);
        allPicks.push({ shortcode: r.shortcode, url: r.url, channel: r.creatorUsername || r.channel });
      }
    }
    for (const r of pool) {
      if (allPicks.length >= dailyCount) break;
      const creator = (r.channel || "").toLowerCase().trim();
      if (excludes.has(creator)) {
        pipelineLogger.info(`[${this.profile.brandName}] Excluding reel #${r.shortcode} from channel pool because it belongs to excluded channel: ${creator}`, "ChannelWatcher");
        continue;
      }
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
    const startTime = this.todayScheduleUtcMs() + (this.profileIndex * 5 * 60 * 1000);
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
    return [];
  }

  private async processQueue(): Promise<void> {
    const now = Date.now();
    const queue = this.store.getQueue();
    const sequence = this.store.getChannelSequence();

    // Step 1: poll any in-flight reel (fired but not yet resolved).
    const inFlight = queue.find((item) => item.fired && !item.published && !item.failed && item.jobId);
    if (inFlight) {
      const job = this.db.getJob(inFlight.jobId!);
      if (!job) {
        // If the job has not been created yet, it might still be downloading.
        // But if it has been downloading for too long, it must have failed to download/initialize.
        const parts = inFlight.jobId!.split("-");
        const firedAt = parts.length > 1 ? parseInt(parts[1], 10) : 0;
        const elapsedMs = now - firedAt;
        if (firedAt > 0 && elapsedMs > 5 * 60 * 1000) {
          pipelineLogger.warn(
            `[${this.profile.brandName}] Job ${inFlight.jobId} was never initialized in the database (failed to download/init) and has timed out after ${Math.round(elapsedMs / 1000)}s. Marking as failed.`,
            "ChannelWatcher",
          );
          await this.store.markFailed(inFlight.shortcode, "Job initialization/download timed out");
          await this.history.markFailed(inFlight.shortcode, "Job initialization/download timed out");
        }
        return;
      }

      if (job.status === "completed") {
        await this.store.markPublished(inFlight.shortcode, job.youtubeUrl, job.instagramUrl, job.facebookUrl);
        await this.history.markPublished(
          inFlight.shortcode,
          job.youtubeUrl,
          job.instagramUrl,
          job.facebookUrl,
          job.youtubeVideoId,
          job.instagramMediaId,
          job.facebookVideoId
        );
        pipelineLogger.info(
          `[${this.profile.brandName}] Reel @${inFlight.channel}/${inFlight.shortcode} marked published — YT: ${job.youtubeUrl || "N/A"} IG: ${job.instagramUrl || "N/A"} FB: ${job.facebookUrl || "N/A"}`,
          "ChannelWatcher",
        );
      } else if (job.status === "failed") {
        await this.store.markFailed(inFlight.shortcode, job.error || "Pipeline failed");
        await this.history.markFailed(inFlight.shortcode, job.error || "Pipeline failed");
        pipelineLogger.warn(
          `[${this.profile.brandName}] Reel @${inFlight.channel}/${inFlight.shortcode} marked failed — ${job.error}`,
          "ChannelWatcher",
        );
      }
      return; // never start the next fetch or run the next reel while one is in-flight
    }

    // Step 2: check if there is a pending, unfired reel in the queue whose scheduled time has arrived.
    const readyToFire = queue.find((item) => !item.fired && now >= new Date(item.scheduledAt).getTime());
    if (readyToFire) {
      if (readyToFire.url) {
        const isManual = readyToFire.channel === "manual_inject";
        const jobId = isManual
          ? this.telegram.runInteractiveReel(
              readyToFire.url,
              this.profile.watch.adminChatId,
              0,
              undefined,
              readyToFire.channel,
            )
          : this.telegram.runPresetReel(
              readyToFire.url,
              this.profile.watch.adminChatId,
              0,
              undefined,
              readyToFire.channel,
            );
        await this.store.markFired(readyToFire.shortcode, jobId);
        pipelineLogger.info(
          isManual
            ? `[${this.profile.brandName}] Interactive manual ingest triggered for reel @${readyToFire.channel}/${readyToFire.shortcode} (jobId: ${jobId})`
            : `[${this.profile.brandName}] Auto-publishing reel @${readyToFire.channel}/${readyToFire.shortcode} (jobId: ${jobId})`,
          "ChannelWatcher",
        );
      } else {
        // Placeholder/skipped item (e.g. from failed fetch)
        await this.store.markFired(readyToFire.shortcode, "skipped-job");
        await this.store.markFailed(readyToFire.shortcode, readyToFire.failedReason || "Skipped slot");
        pipelineLogger.info(
          `[${this.profile.brandName}] Bypassing skipped slot @${readyToFire.channel}/${readyToFire.shortcode}`,
          "ChannelWatcher",
        );
      }
      return;
    }

    // Step 3: Fetch the next channel's reels (Queue Ingestion Phase).
    if (sequence.length > 0 && queue.length < sequence.length) {
      // Instagram rate limit cooldown: don't hammer the API after a 429.
      if (this.rateLimitedUntil !== null && now < this.rateLimitedUntil) {
        const waitMin = Math.ceil((this.rateLimitedUntil - now) / 60000);
        pipelineLogger.info(
          `[${this.profile.brandName}] Instagram rate limited — retrying queue ingestion in ${waitMin}m`,
          "ChannelWatcher",
        );
        return;
      }
      this.rateLimitedUntil = null;

      // Check if we should fetch now (3-minute gap with profile-based stagger)
      let canFetch = false;
      if (queue.length === 0) {
        // Start populating as soon as we reach the staggered scheduled time
        const staggeredScheduledMs = this.todayScheduleUtcMs() + (this.profileIndex * 5 * 60 * 1000);
        if (this.isForcedRun || now >= staggeredScheduledMs) {
          canFetch = true;
        }
      } else {
        const lastItem = queue[queue.length - 1];
        const lastAddedAt = lastItem.addedAt ? new Date(lastItem.addedAt).getTime() : new Date(lastItem.scheduledAt).getTime();
        const staggerOffsetMs = 3 * 60 * 1000 + this.profileIndex * 20 * 1000;
        if (now - lastAddedAt >= staggerOffsetMs) {
          canFetch = true;
        }
      }

      if (canFetch) {
        const channel = sequence[queue.length];
        pipelineLogger.info(
          `[${this.profile.brandName}] Ingestion slot ${queue.length + 1}/${sequence.length}: fetching reels from @${channel}...`,
          "ChannelWatcher",
        );

        let reels: Awaited<ReturnType<typeof listChannelReels>>;
        try {
          reels = await this.listChannelReelsWithFallback(channel);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const isRateLimit = err instanceof Error && (err.name === "InstagramRateLimitError" || errorMsg.includes("rate limited"));
          if (isRateLimit) {
            this.rateLimitedUntil = now + ChannelWatcher.RATE_LIMIT_COOLDOWN_MS;
            pipelineLogger.warn(
              `[${this.profile.brandName}] Instagram rate limited (429) — holding ingestion slot ${queue.length + 1} (@${channel}), retrying in 30 minutes`,
              "ChannelWatcher",
            );
            return;
          }
          pipelineLogger.error(
            `[${this.profile.brandName}] Failed to fetch reels from @${channel} during ingestion — skipping slot ${queue.length + 1}`,
            err,
            "ChannelWatcher",
          );
          // Advance past the failed slot so the queue is not permanently blocked on this channel
          const staggeredScheduledMs = this.todayScheduleUtcMs() + (this.profileIndex * 5 * 60 * 1000);
          const scheduledTime = queue.length === 0
            ? (this.isForcedRun ? now : staggeredScheduledMs)
            : new Date(queue[queue.length - 1].scheduledAt).getTime() + this.profile.watch.gapHours * 60 * 60 * 1000;
          const scheduledAtStr = new Date(scheduledTime).toISOString();
          const skipCode = `skip_${channel}_${Date.now()}`;
          await this.store.setQueue([...queue, {
            shortcode: skipCode,
            url: "",
            channel,
            scheduledAt: scheduledAtStr,
            fired: true,
            failed: true,
            failedReason: `Failed to fetch from @${channel}: ${errorMsg}`,
            addedAt: new Date().toISOString()
          }]);
          await this.store.advanceSlot();
          return;
        }

        const unseen = reels.filter((r) => !this.history.has(r.shortcode));
        if (unseen.length === 0) {
          pipelineLogger.warn(
            `[${this.profile.brandName}] No unseen reels from @${channel} during ingestion — skipping slot ${queue.length + 1}/${sequence.length}`,
            "ChannelWatcher",
          );
          // Advance past the skipped slot so the queue moves on to remaining channels
          const staggeredScheduledMs = this.todayScheduleUtcMs() + (this.profileIndex * 5 * 60 * 1000);
          const scheduledTime = queue.length === 0
            ? (this.isForcedRun ? now : staggeredScheduledMs)
            : new Date(queue[queue.length - 1].scheduledAt).getTime() + this.profile.watch.gapHours * 60 * 60 * 1000;
          const scheduledAtStr = new Date(scheduledTime).toISOString();
          const skipCode = `skip_${channel}_${Date.now()}`;
          await this.store.setQueue([...queue, {
            shortcode: skipCode,
            url: "",
            channel,
            scheduledAt: scheduledAtStr,
            fired: true,
            failed: true,
            failedReason: `No unseen reels from @${channel}`,
            addedAt: new Date().toISOString()
          }]);
          await this.store.advanceSlot();
          return;
        }

        const pick = unseen[Math.floor(Math.random() * unseen.length)];
        const staggeredScheduledMs = this.todayScheduleUtcMs() + (this.profileIndex * 5 * 60 * 1000);
        const scheduledTime = queue.length === 0
          ? (this.isForcedRun ? now : staggeredScheduledMs)
          : new Date(queue[queue.length - 1].scheduledAt).getTime() + this.profile.watch.gapHours * 60 * 60 * 1000;
        const scheduledAtStr = new Date(scheduledTime).toISOString();

        // Reserve in history and commit to queue before firing — crash-safe.
        await this.history.add(pick.shortcode, channel);
        await this.store.setQueue([...queue, {
          shortcode: pick.shortcode,
          url: pick.url,
          channel,
          scheduledAt: scheduledAtStr,
          fired: false,
          addedAt: new Date().toISOString()
        }]);
        await this.store.advanceSlot();

        pipelineLogger.info(
          `[${this.profile.brandName}] Ingested reel @${channel}/${pick.shortcode} into queue (scheduled for ${new Date(scheduledTime).toLocaleTimeString()})`,
          "ChannelWatcher",
        );
        
        // Reset forced flag after starting ingestion
        if (queue.length === 0) {
          this.isForcedRun = false;
        }
      }
    }
  }

  /**
   * Force-start the scheduler: clear any rate-limit cooldown, rebuild the
   * day's batch sequence (bypassing the once-per-day guard), and immediately
   * trigger the first processQueue tick rather than waiting up to 60 seconds.
   * Used by the /runwatchnow Telegram command.
   */
  public async forceStart(): Promise<void> {
    this.rateLimitedUntil = null; // clear any 429 cooldown
    this.isForcedRun = true;
    await this.runDailyBatch(true);
    await this.processQueue().catch((err) => {
      pipelineLogger.error(
        `[${this.profile.brandName}] forceStart processQueue failed`,
        err,
        "ChannelWatcher",
      );
    });
  }

  public async triggerQueueProcess(): Promise<void> {
    await this.store.load();
    await this.processQueue().catch((err) => {
      pipelineLogger.error(
        `[${this.profile.brandName}] triggerQueueProcess failed`,
        err,
        "ChannelWatcher",
      );
    });
  }

  /**
   * Injects a reel from the dashboard / API and immediately fires it,
   * bypassing the scheduler and updating the store + logging live.
   */
  public async injectAndRunReel(reelUrl: string): Promise<string> {
    const shortcode =
      reelUrl.split("/reel/")[1]?.split("/")[0] ||
      reelUrl.split("/p/")[1]?.split("/")[0] ||
      `injected_${Date.now()}`;

    const jobId = this.telegram.runInteractiveReel(
      reelUrl,
      this.profile.watch.adminChatId || 0,
      0,
      undefined,
      "manual_inject",
    );

    const newItem: QueuedReel = {
      shortcode,
      url: reelUrl,
      channel: "manual_inject",
      scheduledAt: new Date().toISOString(),
      fired: true,
      jobId,
      addedAt: new Date().toISOString(),
    };

    await this.store.load();
    const currentQueue = this.store.getQueue().filter((q) => q.shortcode !== shortcode || q.fired);
    await this.store.setQueue([newItem, ...currentQueue]);

    pipelineLogger.info(
      `[${this.profile.brandName}] Interactive manual ingest triggered for reel @manual_inject/${shortcode} (jobId: ${jobId})`,
      "ChannelWatcher",
    );

    return jobId;
  }

  /**
   * Injects reels from Local Discovery Worker (Solution 2) into the queue.
   */
  public async injectReels(
    reels: Array<{ shortcode: string; url?: string; channel?: string; scheduledAt?: string }>,
  ): Promise<number> {
    await this.store.load();
    const existingQueue = this.store.getQueue();
    const existingCodes = new Set(existingQueue.map((q) => q.shortcode));
    let addedCount = 0;
    const gapMs = (this.profile.watch.gapHours || 3) * 60 * 60 * 1000;
    const now = Date.now();

    for (const r of reels) {
      if (
        typeof r.shortcode !== "string" ||
        !/^[A-Za-z0-9_-]{5,20}$/.test(r.shortcode) ||
        existingCodes.has(r.shortcode) ||
        this.history.has(r.shortcode)
      ) {
        continue;
      }
      existingCodes.add(r.shortcode);
      const scheduledTime = r.scheduledAt || new Date(now + addedCount * gapMs).toISOString();
      existingQueue.push({
        shortcode: r.shortcode,
        url: `https://www.instagram.com/reel/${r.shortcode}/`,
        channel: r.channel || "local-worker",
        scheduledAt: scheduledTime,
        fired: false,
        addedAt: new Date().toISOString(),
      });
      await this.history.add(r.shortcode, r.channel || "local-worker");
      addedCount++;
    }

    if (addedCount > 0) {
      await this.store.setQueue(existingQueue);
      pipelineLogger.info(
        `[${this.profile.brandName}] Injected ${addedCount} reel(s) into watch queue via Local Discovery Worker`,
        "ChannelWatcher",
      );
    }
    return addedCount;
  }

  public getStatusDetails() {
    return {
      channels: this.profile.watch.channels,
      dailyCount: this.profile.watch.dailyCount,
      scheduleTime: this.profile.watch.scheduleTime,
      gapHours: this.profile.watch.gapHours,
      adminChatId: this.profile.watch.adminChatId,
      lastBatchDate: this.store.getLastBatchDate(),
      channelSequence: this.store.getChannelSequence(),
      currentSlot: this.store.getCurrentSlot(),
      queue: this.store.getQueue(),
      outroVersion: this.profile.watch.outroVersion,
      searchMode: this.profile.watch.searchMode,
    };
  }
}
