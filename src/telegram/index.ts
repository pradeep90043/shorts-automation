import { Telegraf } from 'telegraf';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { config } from '../config';
import { ITelegramService, PipelineContext, TelegramMetadata } from '../types';
import { pipelineLogger } from '../utils/logger';
import { isInstagramReelUrl, extractInstagramUrl, downloadReelFrame } from '../instagram';

const streamPipeline = promisify(pipeline);

export class TelegramService implements ITelegramService {
  private bot: Telegraf;
  private pipelineTrigger?: (context: PipelineContext) => Promise<void>;
  private approvalTrigger?: (genId: string) => Promise<void>;
  private reviewCallback?: (action: 'publish' | 'cancel' | 'regenerate' | 'viral', id: string) => void;

  constructor() {
    if (!config.telegramToken) {
      throw new Error('TELEGRAM_BOT_TOKEN environment variable is not defined.');
    }
    this.bot = new Telegraf(config.telegramToken);
    this.setupHandlers();
  }

  /**
   * Registers the orchestrator trigger callback
   */
  public registerPipelineTrigger(trigger: (context: PipelineContext) => Promise<void>): void {
    this.pipelineTrigger = trigger;
  }

  /**
   * Registers the orchestrator manual approval callback
   */
  public registerApprovalTrigger(trigger: (genId: string) => Promise<void>): void {
    this.approvalTrigger = trigger;
  }

  /**
   * Registers the review publish/cancel callback from DirectUploader
   */
  public registerReviewCallback(cb: (action: 'publish' | 'cancel' | 'regenerate' | 'viral', id: string) => void): void {
    this.reviewCallback = cb;
  }

  private reviewKeyboard(id: string) {
    return {
      inline_keyboard: [
        [
          { text: '✅ Publish Now', callback_data: `rv_pub_${id}` },
          { text: '❌ Cancel',      callback_data: `rv_can_${id}` },
        ],
        [
          { text: '🔄 Regenerate',  callback_data: `rv_reg_${id}` },
          { text: '🎯 More Viral',  callback_data: `rv_vrl_${id}` },
        ],
      ],
    };
  }

  /**
   * Send a video with all 4 review buttons.
   * Returns the message_id of the sent video message.
   */
  public async sendVideoForReview(
    chatId: number,
    videoPath: string,
    caption: string,
    id: string,
    replyToMessageId?: number
  ): Promise<number> {
    const res = await this.bot.telegram.sendVideo(
      chatId,
      { source: fs.createReadStream(videoPath) },
      {
        caption,
        parse_mode: 'Markdown',
        reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
        reply_markup: this.reviewKeyboard(id),
      } as any
    );
    return res.message_id;
  }

  /**
   * Update the caption of the review message (after regenerating metadata)
   */
  public async updateReviewCaption(chatId: number, messageId: number, caption: string, id: string): Promise<void> {
    try {
      await this.bot.telegram.editMessageCaption(chatId, messageId, undefined, caption, {
        parse_mode: 'Markdown',
        reply_markup: this.reviewKeyboard(id),
      } as any);
    } catch (_) {}
  }

  /**
   * Remove inline buttons from a message (after publish or cancel)
   */
  public async removeInlineButtons(chatId: number, messageId: number): Promise<void> {
    try {
      await this.bot.telegram.editMessageReplyMarkup(chatId, messageId, undefined, { inline_keyboard: [] });
    } catch (_) {}
  }

  public async start(): Promise<void> {
    this.bot.launch();
    pipelineLogger.info('Telegram Bot successfully started and listening for messages.', 'Telegram');
    
    // Enable graceful stop
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  public async downloadFile(fileId: string, destPath: string): Promise<void> {
    const fileLink = await this.bot.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.toString());
    
    if (!response.ok) {
      throw new Error(`Failed to download file from Telegram: ${response.statusText}`);
    }
    
    const fileStream = fs.createWriteStream(destPath);
    if (!response.body) {
      throw new Error('Telegram download response body is empty');
    }
    
    // @ts-ignore - response.body is a ReadableStream which is compatible with streamPipeline in Node
    await streamPipeline(response.body, fileStream);
  }

  public async sendMessage(chatId: number, text: string, replyToMessageId?: number): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, text, {
        reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
        parse_mode: 'Markdown',
      });
    } catch (err) {
      pipelineLogger.error(`Failed to send Telegram message to chat ${chatId}`, err, 'Telegram');
    }
  }

  private setupHandlers(): void {
    // Start command
    this.bot.start((ctx) => {
      ctx.reply(
        '🤖 *CodeOrCap Shorts Automation Bot*\n\n' +
        'Send me any screenshot or image (PNG, JPG, JPEG), and I will:\n' +
        '1. Detect and attempt branding removal\n' +
        '2. Run OCR to parse contents\n' +
        '3. Create a clean 9:16 layout\n' +
        '4. Apply premium CodeOrCap branding\n' +
        '5. Generate AI titles & description\n' +
        '6. Render as an HD Short with animations & music\n' +
        '7. Upload directly to YouTube!\n\n' +
        'Send an image to begin!',
        { parse_mode: 'Markdown' }
      );
    });

    // Handle manual approval override command
    this.bot.command('approve', async (ctx) => {
      try {
        const messageText = ctx.message.text.trim();
        const parts = messageText.split(/\s+/);
        
        if (parts.length < 2) {
          await ctx.reply('⚠️ Please specify a generation ID:\n`/approve [ID]`', { parse_mode: 'Markdown' });
          return;
        }

        const genId = parts[1];
        
        if (this.approvalTrigger) {
          await this.approvalTrigger(genId);
        } else {
          await ctx.reply('❌ Manual approval trigger is not registered in the orchestrator.');
        }
      } catch (err) {
        pipelineLogger.error('Error handling approve command', err, 'Telegram');
        await ctx.reply(`❌ Approval failed: ${err instanceof Error ? err.message : err}`);
      }
    });

    // Handle photos
    this.bot.on('photo', async (ctx) => {
      try {
        const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Get highest resolution photo
        const fileId = photo.file_id;

        await this.initiatePipeline(
          fileId,
          ctx.message.message_id,
          ctx.chat.id,
          ctx.from.id,
          'image.jpg',
          ctx.from.username,
          ctx.from.first_name,
          ctx.message.caption
        );
      } catch (err) {
        pipelineLogger.error('Error handling Telegram photo message', err, 'Telegram');
        ctx.reply('❌ An error occurred while initializing the image pipeline.');
      }
    });

    // Handle document attachments (e.g. uncompressed images)
    this.bot.on('document', async (ctx) => {
      try {
        const doc = ctx.message.document;
        const mimeType = doc.mime_type || '';

        if (mimeType.startsWith('image/') || doc.file_name?.match(/\.(png|jpe?g)$/i)) {
          await this.initiatePipeline(
            doc.file_id,
            ctx.message.message_id,
            ctx.chat.id,
            ctx.from.id,
            doc.file_name || 'image.jpg',
            ctx.from.username,
            ctx.from.first_name,
            ctx.message.caption
          );
        } else {
          ctx.reply('⚠️ Please send only image files (PNG, JPG, JPEG).');
        }
      } catch (err) {
        pipelineLogger.error('Error handling Telegram document message', err, 'Telegram');
        ctx.reply('❌ An error occurred while initializing the image pipeline.');
      }
    });

    // Handle review inline button callbacks
    this.bot.action(/^rv_(pub|can|reg|vrl)_(.+)$/, async (ctx) => {
      const code = ctx.match[1];
      const id   = ctx.match[2];
      const actionMap: Record<string, 'publish' | 'cancel' | 'regenerate' | 'viral'> = {
        pub: 'publish', can: 'cancel', reg: 'regenerate', vrl: 'viral',
      };
      const action = actionMap[code];
      const ackMap = { publish: '🚀 Publishing…', cancel: '❌ Cancelled', regenerate: '🔄 Regenerating…', viral: '🎯 Making it viral…' };
      await ctx.answerCbQuery(ackMap[action]);
      if (this.reviewCallback) this.reviewCallback(action, id);
    });

    // Handle text messages — detect Instagram reel links
    this.bot.on('text', async (ctx) => {
      try {
        const text = ctx.message.text || '';

        if (!isInstagramReelUrl(text)) {
          // Not an Instagram link — ignore (or give a hint)
          if (!text.startsWith('/')) {
            ctx.reply('📸 Send a screenshot image or an Instagram reel link to start the pipeline.');
          }
          return;
        }

        const reelUrl = extractInstagramUrl(text)!;
        const messageId = ctx.message.message_id;
        const chatId = ctx.chat.id;

        const id = `gen-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const tempGenDir = path.join(config.paths.tempDir, id);
        fs.mkdirSync(tempGenDir, { recursive: true });

        await this.sendMessage(
          chatId,
          `🎬 *Instagram reel detected!*\n\`${reelUrl}\`\n\nDownloading & extracting frame...\n\`ID: ${id}\``,
          messageId
        );

        pipelineLogger.info(`Instagram reel received: ${reelUrl} → Gen ID: ${id}`, 'Telegram');

        // Detach from the Telegraf handler immediately — yt-dlp can take 2+ minutes
        // and Telegraf has a 90s timeout that crashes the process if we await here.
        this.processInstagramReel(reelUrl, tempGenDir, id, chatId, messageId, ctx.from).catch((err) => {
          pipelineLogger.error(`Instagram reel processing failed for ${id}`, err, 'Instagram');
        });
      } catch (err) {
        pipelineLogger.error('Error handling Instagram reel link', err, 'Telegram');
        ctx.reply('❌ An error occurred processing the Instagram link.');
      }
    });
  }

  private async processInstagramReel(
    reelUrl: string,
    tempGenDir: string,
    id: string,
    chatId: number,
    messageId: number,
    from: { id: number; username?: string; first_name?: string }
  ): Promise<void> {
    let framePath: string;
    let instagramSourceType: 'image' | 'image_with_music' | 'video';
    try {
      const result = await downloadReelFrame(reelUrl, tempGenDir);
      framePath = result.framePath;
      instagramSourceType = result.instagramSourceType;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pipelineLogger.error('Instagram download failed', err, 'Instagram');
      await this.sendMessage(
        chatId,
        `❌ *Failed to download reel*\n\`${msg.slice(0, 300)}\`\n\nMake sure you're logged into Instagram in Chrome and the reel is public.`,
        messageId
      );
      return;
    }

    const telegramMeta: TelegramMetadata = {
      messageId,
      chatId,
      userId: from.id,
      username: from.username,
      firstName: from.first_name,
      timestamp: Math.floor(Date.now() / 1000),
      fileId: reelUrl,
    };

    const context: PipelineContext = {
      id,
      tempDir: tempGenDir,
      telegramMeta,
      originalImagePath: framePath,
      status: 'received',
      instagramSource: true,
      instagramSourceType,
    };

    let contentTypeDesc = '';
    if (instagramSourceType === 'image') {
      contentTypeDesc = '📸 *Image/Carousel* (screenshotted)';
    } else if (instagramSourceType === 'image_with_music') {
      contentTypeDesc = '🎵 *Static Reel* (image with music)';
    } else {
      contentTypeDesc = '🎬 *Dynamic Video* (real video)';
    }

    await this.sendMessage(
      chatId,
      `✅ *Download complete!*\n` +
      `• *Type:* ${contentTypeDesc}\n` +
      `• *Frame Path:* \`${path.basename(framePath)}\`\n\n` +
      `Starting automation pipeline...`,
      messageId
    );

    pipelineLogger.checkpoint(`Instagram frame ready (${instagramSourceType}) — starting pipeline`, true, framePath);

    if (this.pipelineTrigger) {
      this.pipelineTrigger(context).catch((err) => {
        pipelineLogger.error(`Pipeline failed for Instagram reel ${id}`, err, 'Orchestrator');
      });
    }
  }

  private parseCaptionMetadata(caption?: string): { title: string; description: string } | undefined {
    if (!caption || caption.trim().length === 0) return undefined;
    const lines = caption.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const title = lines[0].slice(0, 100);
    const description = lines.slice(1).join('\n').trim() || lines[0];
    return { title, description };
  }

  private async initiatePipeline(
    fileId: string,
    messageId: number,
    chatId: number,
    userId: number,
    originalFileName: string,
    username?: string,
    firstName?: string,
    caption?: string
  ): Promise<void> {
    const id = `gen-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const tempGenDir = path.join(config.paths.tempDir, id);
    
    // Create generation temp directory
    fs.mkdirSync(tempGenDir, { recursive: true });

    const ext = path.extname(originalFileName) || '.jpg';
    const originalImagePath = path.join(tempGenDir, `original${ext}`);

    const telegramMeta: TelegramMetadata = {
      messageId,
      chatId,
      userId,
      username,
      firstName,
      timestamp: Math.floor(Date.now() / 1000),
      fileId,
    };

    const captionMetadata = this.parseCaptionMetadata(caption);

    const context: PipelineContext = {
      id,
      tempDir: tempGenDir,
      telegramMeta,
      originalImagePath,
      status: 'received',
      captionMetadata,
    };

    pipelineLogger.info(`Telegram received image. Assigned Gen ID: ${id}`, 'Telegram');
    pipelineLogger.checkpoint('Telegram image received', true, id);

    await this.sendMessage(chatId, `📥 *Image received!* starting automation pipeline...\n\`ID: ${id}\``, messageId);

    // Download the image
    try {
      await this.downloadFile(fileId, originalImagePath);
      pipelineLogger.checkpoint('Image downloaded', true, `Saved to ${originalImagePath}`);
    } catch (err) {
      pipelineLogger.error(`Failed to download image for ${id}`, err, 'Telegram');
      await this.sendMessage(chatId, `❌ Failed to download image from Telegram.`, messageId);
      return;
    }

    // Trigger pipeline orchestrator asynchronously
    if (this.pipelineTrigger) {
      this.pipelineTrigger(context).catch((err) => {
        pipelineLogger.error(`Pipeline orchestrator failed for Gen ID ${id}`, err, 'Orchestrator');
      });
    } else {
      pipelineLogger.warn(`No pipeline trigger registered. Image downloaded but not processed.`, 'Telegram');
      await this.sendMessage(chatId, `⚠️ Pipeline orchestrator not loaded.`, messageId);
    }
  }
}
