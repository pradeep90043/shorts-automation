import { config, validateConfig } from "./config";
import { TelegramService } from "./telegram";
import { DirectUploader } from "./direct-uploader";
import { ensureAssetsExist } from "./utils/assets";
import { pipelineLogger } from "./utils/logger";

async function bootstrap() {
  pipelineLogger.info(
    "Starting Shorts Automation System...",
    "Bootstrap",
  );

  // 1. Validate environment configuration
  validateConfig();

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

  if (config.profiles.length === 0) {
    pipelineLogger.error(
      "No channel profiles configured. Set TELEGRAM_BOT_TOKEN (or <PREFIX>_TELEGRAM_BOT_TOKEN_LOCAL/_PROD) in .env.",
      undefined,
      "Bootstrap",
    );
    process.exit(1);
  }

  // 3. Initialize one Telegram bot + uploader pipeline per channel profile
  for (const profile of config.profiles) {
    pipelineLogger.info(
      `Initializing channel profile [${profile.brandName}] — ${profile.youtube.channels.length} YouTube channel(s), ${profile.instagram.accounts.length} Instagram account(s)`,
      "Bootstrap",
    );

    let telegramService: TelegramService;
    try {
      telegramService = new TelegramService(profile);
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
      await telegramService.start();
    } catch (err) {
      pipelineLogger.error(
        `[${profile.brandName}] Failed to start Telegram polling listener`,
        err,
        "Bootstrap",
      );
      process.exit(1);
    }
  }

  pipelineLogger.info(
    `System is fully initialized and operational. ${config.profiles.length} bot(s) ready to process screenshots!`,
    "Bootstrap",
  );
}

// Run bootstrap
bootstrap().catch((err) => {
  console.error("Fatal crash during bootstrap:", err);
  process.exit(1);
});
