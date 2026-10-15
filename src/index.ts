import sharp from "sharp";
// Disable libvips cache to prevent file locking on Windows
sharp.cache(false);

import { config, validateConfig } from "./config";
import { TelegramService } from "./telegram";
import { DirectUploader } from "./direct-uploader";
import { ChannelWatcher } from "./instagram/channelWatcher";
import { ensureAssetsExist } from "./utils/assets";
import { cleanupOldMedia } from "./utils/cleanup";
import { pipelineLogger } from "./utils/logger";
import { acquireSingleInstanceLock } from "./utils/singleInstanceLock";
import { initSchema, closePg } from "./utils/pgClient";
import { loadCredentialsToEnv } from "./utils/credentialStore";
import { startLogServer } from "./logServer";
import { youtubeServiceFor } from "./logServer";
import { getStickmanJob, isStickmanBusy, startStickmanJob } from "./my-video/stickmanJobs";
import { candidateStore } from "./longvideo-auto/config";
import { LongQueue } from "./longvideo-auto/queue";
import { startAutoLong } from "./longvideo-auto";
import { makeAsk } from "./longvideo-auto/llm";
import { autoLongStatus } from "./longvideo-auto/status";
import { JobQueue } from "./utils/queue";

async function bootstrap() {
  pipelineLogger.info(
    "Starting Shorts Automation System...",
    "Bootstrap",
  );

  // 0. Start live log HTTP server
  startLogServer();

  // 1. Refuse to start if another instance is already polling Telegram —
  // duplicate pollers cause the same message to be handled twice.
  acquireSingleInstanceLock();

  // 1. Validate environment configuration
  validateConfig();

  // 1b. Connect to Supabase and ensure tables exist
  await initSchema();

  // 1c. Load any Instagram credentials saved via the dashboard into process.env
  // as fallbacks so env-var-based code (fetch_reels.py, channelWatcher) picks them up
  // without needing them in the GitHub secret / .env file.
  for (const profile of config.profiles) {
    await loadCredentialsToEnv(profile.key).catch(() => {});
  }

  // 1d. Load watch configurations from the database to override file-based defaults
  try {
    const { getPool } = require("./utils/pgClient");
    const pool = await getPool();
    const { rows } = await pool.query(
      "SELECT profile_key, watch_config FROM watch_state WHERE watch_config IS NOT NULL"
    );
    for (const row of rows) {
      const pKey = row.profile_key.toLowerCase();
      const profile = config.profiles.find((p) => (p.key || p.brandName).toLowerCase() === pKey);
      let dbConfig = row.watch_config;
      if (dbConfig) {
        if (typeof dbConfig === "string") {
          try {
            dbConfig = JSON.parse(dbConfig);
          } catch (e) {
            pipelineLogger.warn(
              `Failed to parse watch_config string for profile [${pKey}]: ${dbConfig}`,
              "Bootstrap",
            );
          }
        }
        if (profile && typeof dbConfig === "object") {
          pipelineLogger.info(
            `Overriding watch configuration for profile [${profile.brandName}] from database: ${JSON.stringify(dbConfig)}`,
            "Bootstrap",
          );
          profile.watch = {
            ...profile.watch,
            ...dbConfig,
          };
        }
      }
    }
  } catch (err) {
    pipelineLogger.warn(
      `Failed to load watch configurations from database: ${err instanceof Error ? err.message : err}`,
      "Bootstrap",
    );
  }

  // 2. Ensure branding and default audio assets are present
  try {
    await ensureAssetsExist();
  } catch (err) {
    pipelineLogger.error(
      "Failed to initialize asset files. Process exiting.",
      err,
      "Bootstrap",
    );
    process.exit(1);
  }

  // 2b. Clear out stale temp/output files from past jobs (shared across all
  // profiles, so this runs once here rather than per-profile), then keep
  // sweeping every 6 hours so disk usage never creeps back up.
  cleanupOldMedia();
  setInterval(cleanupOldMedia, 6 * 60 * 60 * 1000);

  // 2c. Supabase free-tier keep-alive: run a lightweight query every 3 days
  // so the project never goes idle for 7 days and never auto-pauses.
  const KEEP_ALIVE_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
  const supabaseKeepAlive = async () => {
    try {
      const { getPool } = require("./utils/pgClient");
      const pool = await getPool();
      await pool.query("SELECT 1");
      pipelineLogger.info("Supabase keep-alive ping sent successfully.", "SupabaseKeepAlive");
    } catch (err) {
      pipelineLogger.warn(
        `Supabase keep-alive ping failed: ${err instanceof Error ? err.message : err}`,
        "SupabaseKeepAlive"
      );
    }
  };
  setInterval(supabaseKeepAlive, KEEP_ALIVE_INTERVAL_MS);

  if (config.profiles.length === 0) {
    pipelineLogger.error(
      "No channel profiles configured. Set TELEGRAM_BOT_TOKEN (or <PREFIX>_TELEGRAM_BOT_TOKEN_LOCAL/_PROD) in .env.",
      undefined,
      "Bootstrap",
    );
    process.exit(1);
  }

  const activeServices: TelegramService[] = [];

  // 3. Initialize one Telegram bot + uploader pipeline per channel profile
  for (const profile of config.profiles) {
    pipelineLogger.info(
      `Initializing channel profile [${profile.brandName}] — ${profile.youtube.channels.length} YouTube channel(s), ${profile.instagram.accounts.length} Instagram account(s)`,
      "Bootstrap",
    );

    let telegramService: TelegramService;
    try {
      telegramService = new TelegramService(profile);
      activeServices.push(telegramService);
    } catch (err) {
      pipelineLogger.error(
        `[${profile.brandName}] Failed to start Telegram Bot service. Check its bot token in .env.`,
        err,
        "Bootstrap",
      );
      process.exit(1);
    }

    const uploader = new DirectUploader(telegramService, profile);

    // Cancel any active pending jobs interrupted by a crash/restart
    uploader.cancelAllPendingJobs().catch((err) => {
      pipelineLogger.error(
        `[${profile.brandName}] Failed to cancel active jobs during bootstrap`,
        err,
        "Bootstrap",
      );
    });

    // Register pipeline trigger — image in → music + upload out
    telegramService.registerPipelineTrigger(async (context) => {
      await uploader.run(context);
    });

    // Start listening for incoming events
    try {
      if (!profile.isWatchOnly) {
        await telegramService.start();
      } else {
        pipelineLogger.info(
          `[${profile.brandName}] Bot is in WATCH-ONLY mode — skipping Telegram polling listener`,
          "Bootstrap",
        );
      }
    } catch (err) {
      pipelineLogger.error(
        `[${profile.brandName}] Failed to start Telegram polling listener`,
        err,
        "Bootstrap",
      );
      process.exit(1);
    }

    // Recurring channel-watch automation (no-ops if <PREFIX>_WATCH_CHANNELS
    // isn't configured for this profile). Force an immediate run any time
    // via the /runwatchnow Telegram command instead of waiting for the
    // scheduled time.
    try {
      const watcher = new ChannelWatcher(profile, telegramService, config.profiles.indexOf(profile));
      telegramService.registerWatcher(watcher);
      await watcher.start();
    } catch (watcherErr) {
      pipelineLogger.error(
        `[${profile.brandName}] ChannelWatcher encountered startup error: ${watcherErr}`,
        watcherErr,
        "Bootstrap"
      );
    }
  }

  // Daily 10-minute video per channel (src/longvideo-auto): ranks the day's published Shorts after midnight IST, then makes
  // one video at a time while no Short is being processed. ON by default (DAILY_LONG_VIDEO=off stops it). Notices and
  // failures are shown on the dashboard's "Daily Video" tab and written to the log; nothing here uses Telegram.
  try {
    startAutoLong({
      store: candidateStore(),
      queue: new LongQueue(),
      ask: makeAsk(),
      fetchText: async (url, init) => {
        const res = await fetch(url, { method: init?.method ?? "GET", body: init?.body, headers: init?.headers, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.text()).slice(0, 1_500_000);
      },
      startJob: (input) => startStickmanJob(input as any),
      getJob: (id) => getStickmanJob(id) as any,
      isStickmanBusy,
      isShortActive: () => !JobQueue.isIdle(),
      youtubeFor: async (key) => (await youtubeServiceFor(key)) as any,
      brandName: (key) => config.profiles.find((p) => p.key === key)?.brandName ?? key,
      notify: async (text) => autoLongStatus.log("info", "notice", text.replace(/\n/g, " | ")),
      now: () => Date.now(),
    });
  } catch (err) {
    pipelineLogger.error("[AutoLong] could not start the daily long video", err, "Bootstrap");
  }

  pipelineLogger.info(
    `System is fully initialized and operational. ${config.profiles.length} bot(s) ready to process screenshots!`,
    "Bootstrap",
  );

  // Set up graceful shutdown handlers to cleanly close polling connections
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    pipelineLogger.info(
      `Received ${signal}. Shutting down gracefully...`,
      "Bootstrap",
    );

    for (const service of activeServices) {
      try {
        await service.stop();
      } catch (err) {
        pipelineLogger.error(
          `Failed to stop Telegram bot service gracefully`,
          err,
          "Bootstrap",
        );
      }
    }

    await closePg();
    pipelineLogger.info("All services stopped. Exiting process.", "Bootstrap");
    process.exit(0);
  };

  process.once("SIGINT", () => gracefulShutdown("SIGINT"));
  process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.once("SIGUSR2", () => gracefulShutdown("SIGUSR2"));
}

// Global unhandled error guards so system & LogServer stay alive
process.on("unhandledRejection", (reason) => {
  pipelineLogger.error(`Unhandled Rejection detected: ${reason}`, reason, "ProcessGuard");
});

process.on("uncaughtException", (err) => {
  pipelineLogger.error(`Uncaught Exception detected: ${err.message}`, err, "ProcessGuard");
});

// Run bootstrap
bootstrap().catch((err) => {
  console.error("Fatal crash during bootstrap:", err);
});
// Nodemon trigger change (exclusive mood filters)

