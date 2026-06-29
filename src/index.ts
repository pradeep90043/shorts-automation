import { validateConfig } from './config';
import { TelegramService } from './telegram';
import { DirectUploader } from './direct-uploader';
import { ensureAssetsExist } from './utils/assets';
import { pipelineLogger } from './utils/logger';

async function bootstrap() {
  pipelineLogger.info('Starting CodeOrCap Shorts Automation System...', 'Bootstrap');

  // 1. Validate environment configuration
  validateConfig();

  // 2. Ensure branding and default audio assets are present
  try {
    await ensureAssetsExist();
  } catch (err) {
    pipelineLogger.error('Failed to initialize asset files. Process exiting.', err, 'Bootstrap');
    process.exit(1);
  }

  // 3. Initialize Services
  let telegramService: TelegramService;
  try {
    telegramService = new TelegramService();
  } catch (err) {
    pipelineLogger.error('Failed to start Telegram Bot service. Ensure TELEGRAM_BOT_TOKEN is set.', err, 'Bootstrap');
    process.exit(1);
  }

  const uploader = new DirectUploader(telegramService);

  // 4. Register pipeline trigger — image in → music + upload out
  telegramService.registerPipelineTrigger(async (context) => {
    await uploader.run(context);
  });

  // 5. Start listening for incoming events
  try {
    await telegramService.start();
    pipelineLogger.info('System is fully initialized and operational. Ready to process screenshots!', 'Bootstrap');
  } catch (err) {
    pipelineLogger.error('Failed to start Telegram polling listener', err, 'Bootstrap');
    process.exit(1);
  }
}

// Run bootstrap
bootstrap().catch(err => {
  console.error('Fatal crash during bootstrap:', err);
  process.exit(1);
});
