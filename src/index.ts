import { config, validateConfig } from "./config";
import { TelegramService } from "./telegram";
import { DirectUploader } from "./direct-uploader";
import { ChannelWatcher } from "./instagram/channelWatcher";
import { ensureAssetsExist } from "./utils/assets";
import { cleanupOldMedia } from "./utils/cleanup";
import { pipelineLogger } from "./utils/logger";
import { acquireSingleInstanceLock } from "./utils/singleInstanceLock";
import { initSchema, closePg } from "./utils/pgClient";

async function bootstrap() {
  pipelineLogger.info(
    "Starting Shorts Automation System...",
    "Bootstrap",
  );

  // 0. Refuse to start if another instance is already polling Telegram —
  // duplicate pollers cause the same message to be handled twice.
  acquireSingleInstanceLock();

  // 1. Validate environment configuration
  validateConfig();

  // 1b. Connect to Supabase and ensure tables exist
  await initSchema();

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
    const watcher = new ChannelWatcher(profile, telegramService);
    telegramService.registerWatcher(watcher);
    await watcher.start();
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

// Run bootstrap
bootstrap().catch((err) => {
  console.error("Fatal crash during bootstrap:", err);
  process.exit(1);
});
// Nodemon trigger change (exclusive mood filters)

