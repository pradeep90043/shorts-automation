import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { config } from './config';
import { VideoRenderer } from './renderer';
import { MusicService } from './music';
import { YouTubeService, UploadResult } from './youtube';
import { TelegramService } from './telegram';
import { PipelineContext, VideoMetadata } from './types';
import { pipelineLogger } from './utils/logger';

const REVIEW_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

interface PendingUpload {
  id: string;
  chatId: number;
  messageId: number;
  reviewMessageId: number;
  metadata: VideoMetadata;
  finalVideoPath: string;
  outputFilePath: string;
  outputFileName: string;
  originalImagePath: string;
  timer: ReturnType<typeof setTimeout>;
}

export class DirectUploader {
  private ai: GoogleGenAI;
  private renderer: VideoRenderer;
  private music: MusicService;
  private youtube: YouTubeService;
  private telegram: TelegramService;
  private pending = new Map<string, PendingUpload>();

  constructor(telegram: TelegramService) {
    this.ai       = new GoogleGenAI({ apiKey: config.ai.geminiApiKey });
    this.renderer = new VideoRenderer();
    this.music    = new MusicService();
    this.youtube  = new YouTubeService();
    this.telegram = telegram;

    // Wire up inline-button callbacks from Telegram
    telegram.registerReviewCallback((action, id) => {
      if      (action === 'publish')    this.onPublish(id);
      else if (action === 'cancel')     this.onCancel(id);
      else if (action === 'regenerate') this.onRegenerate(id, false);
      else if (action === 'viral')      this.onRegenerate(id, true);
    });
  }

  // ── Gemini vision → YouTube metadata ──────────────────────────────────────

  private async generateMetadata(imagePath: string): Promise<VideoMetadata> {
    pipelineLogger.info('Generating metadata via Gemini vision…', 'DirectUploader');

    const base64   = fs.readFileSync(imagePath).toString('base64');
    const mimeType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

    const prompt = `You are a viral YouTube Shorts strategist for a tech/programming channel called "CodeOrCap".

Analyze this image carefully — read all visible text, identify the topic, tools, languages, or concepts shown.

Generate SEO-optimised YouTube Shorts metadata that will maximise clicks and watch time.

Rules:
- title: curiosity-driven, punchy, under 80 chars. Use power words and emojis. Examples: "You're Using Git Wrong 😤 Here's The Fix", "10 VS Code Shortcuts Devs Don't Know ⚡", "This Python Trick Will Blow Your Mind 🔥"
- description: 2-3 sentences explaining the value. End with 5-6 relevant hashtags. Max 400 chars.
- tags: 10-12 specific tags covering the topic, tools, and audience (no spaces in tags).

Return ONLY a raw JSON object — no markdown, no explanation:
{"title":"...","description":"...","tags":["...","..."]}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.ai.models.generateContent({
          model: 'gemini-2.0-flash',
          contents: [{
            role: 'user',
            parts: [{ inlineData: { mimeType, data: base64 } }, { text: prompt }],
          }],
        });
        const raw = res.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const s   = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
        const obj = JSON.parse(s) as VideoMetadata;
        if (!obj.title || !obj.description || !Array.isArray(obj.tags)) {
          throw new Error('Missing required fields');
        }
        pipelineLogger.checkpoint('Metadata generated', true, `"${obj.title}"`);
        return obj;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < 2 && /503|unavailable|rate|429/i.test(msg)) {
          const wait = /429/.test(msg) ? 15000 : 5000;
          pipelineLogger.warn(`Gemini attempt ${attempt + 1} failed, retrying in ${wait/1000}s…`, 'DirectUploader');
          await new Promise(r => setTimeout(r, wait));
        } else {
          pipelineLogger.warn(`Gemini metadata failed: ${msg} — using fallback`, 'DirectUploader');
          return this.fallbackMetadata();
        }
      }
    }
    return this.fallbackMetadata();
  }

  private fallbackMetadata(): VideoMetadata {
    return {
      title: 'Mind-Blowing Tech Trick You Need To Know ⚡',
      description: 'Level up your skills with this essential tip every developer should know. Drop a 🔥 if you found this useful!\n\n#coding #programming #developer #tech #shorts',
      tags: ['coding', 'programming', 'developer', 'tech', 'shorts', 'codeorcap', 'learntocode', 'webdev'],
    };
  }

  private async generateViralMetadata(imagePath: string): Promise<VideoMetadata> {
    pipelineLogger.info('Generating viral metadata via Gemini…', 'DirectUploader');

    const base64   = fs.readFileSync(imagePath).toString('base64');
    const mimeType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

    const prompt = `You are an aggressive viral YouTube Shorts growth hacker for a tech channel called "CodeOrCap".

Analyze this image and generate the most scroll-stopping, curiosity-gap, high-CTR metadata possible.

Rules:
- title: extreme curiosity gap, controversy, or shock. Under 80 chars. Heavy emoji use. Examples: "99% of Developers Get This WRONG 💀", "I Can't Believe This Actually Works 🤯", "They Hid This Feature For Years 👀"
- description: hook in first sentence, urgency, social proof. End with 5-6 hashtags. Max 400 chars.
- tags: 10-12 viral/trending tags.

Return ONLY raw JSON — no markdown:
{"title":"...","description":"...","tags":["...","..."]}`;

    try {
      const res = await this.ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: [{
          role: 'user',
          parts: [{ inlineData: { mimeType, data: base64 } }, { text: prompt }],
        }],
      });
      const raw = res.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const s   = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const obj = JSON.parse(s) as VideoMetadata;
      if (!obj.title || !obj.description || !Array.isArray(obj.tags)) throw new Error('Missing fields');
      pipelineLogger.checkpoint('Viral metadata generated', true, `"${obj.title}"`);
      return obj;
    } catch {
      return this.fallbackMetadata();
    }
  }

  // ── Upload to all channels ─────────────────────────────────────────────────

  private async uploadAndReport(pending: PendingUpload): Promise<void> {
    const { id, chatId, messageId, reviewMessageId, metadata, finalVideoPath, outputFileName } = pending;

    // Remove the inline buttons from the review message
    await this.telegram.removeInlineButtons(chatId, reviewMessageId);

    await this.telegram.sendMessage(chatId, `🚀 *Uploading to ${config.youtube.channels.length} channel(s)…*`, messageId);

    try {
      const results: UploadResult[] = await this.youtube.uploadToAllChannels(finalVideoPath, metadata);

      const channelLines = results.map(r => `• *${r.channelName}:* ${r.url}`).join('\n');

      await this.telegram.sendMessage(
        chatId,
        `✅ *Uploaded to ${results.length} channel(s)!*\n\n` +
        `*Title:* ${metadata.title}\n\n` +
        `${channelLines}\n\n` +
        `*File:* \`output/${outputFileName}\`\n_ID: ${id}_`,
        messageId
      );

      pipelineLogger.checkpoint('All uploads complete', true, `${results.length} channel(s)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pipelineLogger.error(`Upload failed for ${id}`, err, 'DirectUploader');
      await this.telegram.sendMessage(chatId, `❌ *Upload failed*\n\`${msg.slice(0, 300)}\``, messageId);
    }

    this.pending.delete(id);
  }

  // ── Review button handlers ─────────────────────────────────────────────────

  private onPublish(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.uploadAndReport(pending).catch(err =>
      pipelineLogger.error(`Upload error for ${id}`, err, 'DirectUploader')
    );
  }

  private onCancel(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.telegram.removeInlineButtons(pending.chatId, pending.reviewMessageId);
    this.telegram.sendMessage(pending.chatId, `❌ *Cancelled.* Video saved locally at \`output/${pending.outputFileName}\``, pending.messageId);
    pipelineLogger.info(`Upload cancelled by user for ${id}`, 'DirectUploader');
  }

  private onRegenerate(id: string, viral: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;

    const label = viral ? 'viral' : 'standard';
    pipelineLogger.info(`Regenerating ${label} metadata for ${id}`, 'DirectUploader');

    const generate = viral
      ? this.generateViralMetadata(pending.originalImagePath)
      : this.generateMetadata(pending.originalImagePath);

    generate.then(async (metadata) => {
      // Update stored metadata
      pending.metadata = metadata;

      const caption =
        `📋 *Review your Short* _(updated)_\n\n` +
        `*Title:* ${metadata.title}\n\n` +
        `*Description:* ${metadata.description.slice(0, 200)}…\n\n` +
        `⏳ _Auto-publishes in 2 minutes if no action taken._`;

      await this.telegram.updateReviewCaption(pending.chatId, pending.reviewMessageId, caption, id);
    }).catch(err => pipelineLogger.error(`Regenerate failed for ${id}`, err, 'DirectUploader'));
  }

  // ── Main pipeline ──────────────────────────────────────────────────────────

  public async run(context: PipelineContext): Promise<void> {
    const { id, tempDir, originalImagePath, telegramMeta } = context;
    const { chatId, messageId } = telegramMeta;

    try {
      await this.telegram.sendMessage(
        chatId,
        `⚙️ *Processing your image…*\n\`ID: ${id}\`\n\nGenerating metadata, rendering video, adding music…`,
        messageId
      );

      // 1 — Metadata (use caption if provided, else call Gemini)
      let metadata: VideoMetadata;
      if (context.captionMetadata) {
        pipelineLogger.info('Using caption-provided metadata — skipping Gemini', 'DirectUploader');
        metadata = {
          title: context.captionMetadata.title,
          description: context.captionMetadata.description,
          tags: ['coding', 'programming', 'developer', 'tech', 'shorts', 'codeorcap'],
        };
        pipelineLogger.checkpoint('Caption metadata loaded', true, `"${metadata.title}"`);
      } else {
        metadata = await this.generateMetadata(originalImagePath);
      }

      // 2 — Image → video
      context.status = 'rendering_video';
      const rawVideoPath = path.join(tempDir, 'video_raw.mp4');
      await this.renderer.renderImageToVideo(originalImagePath, rawVideoPath, {
        durationSeconds: config.rendering.videoDurationSeconds,
        fps: config.rendering.fps,
        effect: 'zoom',
      });

      // 3 — Add music
      const finalVideoPath = path.join(tempDir, 'video_final.mp4');
      await this.music.addBackgroundMusic(rawVideoPath, config.paths.musicDir, finalVideoPath);

      // 4 — Save to output folder
      fs.mkdirSync(config.paths.outputDir, { recursive: true });
      const safeTitle    = metadata.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '_').slice(0, 60);
      const outputFileName = `${safeTitle}_${id}.mp4`;
      const outputFilePath = path.join(config.paths.outputDir, outputFileName);
      fs.copyFileSync(finalVideoPath, outputFilePath);

      // 5 — Send video to Telegram for review
      const caption =
        `📋 *Review your Short*\n\n` +
        `*Title:* ${metadata.title}\n\n` +
        `*Description:* ${metadata.description.slice(0, 200)}…\n\n` +
        `⏳ _Auto-publishes in 2 minutes if no action taken._`;

      const reviewMessageId = await this.telegram.sendVideoForReview(
        chatId, finalVideoPath, caption, id, messageId
      );

      // 6 — Set 2-minute auto-publish timer
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.telegram.sendMessage(chatId, `⏰ *2 minutes elapsed — auto-publishing now…*`, messageId);
        this.uploadAndReport(p).catch(err =>
          pipelineLogger.error(`Auto-upload error for ${id}`, err, 'DirectUploader')
        );
      }, REVIEW_TIMEOUT_MS);

      this.pending.set(id, {
        id, chatId, messageId, reviewMessageId,
        metadata, finalVideoPath, outputFilePath, outputFileName,
        originalImagePath,
        timer,
      });

      pipelineLogger.checkpoint('Review sent to Telegram', true, `${id} — waiting up to 2 min`);

    } catch (err) {
      context.status = 'failed';
      context.error  = err instanceof Error ? err.message : String(err);
      pipelineLogger.error(`DirectUploader failed for ${id}`, err, 'DirectUploader');
      await this.telegram.sendMessage(
        chatId,
        `❌ *Processing failed*\n\`${context.error?.slice(0, 300)}\``,
        messageId
      );
    }
  }
}
