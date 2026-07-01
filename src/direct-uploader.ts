import fs from "fs";
import path from "path";
import sharp from "sharp";
import { exec } from "child_process";
import { config } from "./config";
import { VideoRenderer } from "./renderer";
import { MusicService } from "./music";
import { YouTubeService, UploadResult } from "./youtube";
import { TelegramService } from "./telegram";
import { PipelineContext, VideoMetadata } from "./types";
import { pipelineLogger } from "./utils/logger";
import { FreeLlmApiClient } from "./ai/freellmapi";
import { parseAiJson } from "./utils/json";

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
  context: PipelineContext;
}

export class DirectUploader {
  private freellmapi: FreeLlmApiClient | null = null;
  private renderer: VideoRenderer;
  private music: MusicService;
  private youtube: YouTubeService;
  private telegram: TelegramService;
  private pending = new Map<string, PendingUpload>();
  private uploaded = new Map<
    string,
    { channelResults: UploadResult[]; chatId: number; successMessageId: number }
  >();

  constructor(telegram: TelegramService) {
    if (config.ai.provider === "freellmapi") {
      this.freellmapi = new FreeLlmApiClient();
    }
    this.renderer = new VideoRenderer();
    this.music = new MusicService();
    this.youtube = new YouTubeService();
    this.telegram = telegram;

    // Wire up inline-button callbacks from Telegram
    telegram.registerReviewCallback((action, id) => {
      if (action === "publish") this.onPublish(id);
      else if (action === "cancel") this.onCancel(id);
      else if (action === "regenerate") this.onRegenerate(id, false);
      else if (action === "viral") this.onRegenerate(id, true);
    });

    telegram.registerRevokeCallback(async (id) => {
      await this.onRevoke(id);
    });

    telegram.registerTextPromptCallback(async (chatId, text, messageId) => {
      return this.handleUserTextPrompt(chatId, text, messageId);
    });
  }

  // ── Gemini/FreeLLMAPI vision → YouTube metadata ────────────────────────────

  private async getSmallBase64Image(
    imagePath: string,
  ): Promise<{ base64: string; mimeType: string }> {
    try {
      const buffer = await sharp(imagePath)
        .resize({ width: 480, height: 854, fit: "inside" }) // preserves aspect ratio, fits inside 480x854
        .jpeg({ quality: 75 })
        .toBuffer();
      return {
        base64: buffer.toString("base64"),
        mimeType: "image/jpeg",
      };
    } catch (err) {
      pipelineLogger.warn(
        `Failed to resize image for AI vision: ${err instanceof Error ? err.message : err}. Using original file.`,
        "DirectUploader",
      );
      const base64 = fs.readFileSync(imagePath).toString("base64");
      const mimeType = imagePath.toLowerCase().endsWith(".png")
        ? "image/png"
        : "image/jpeg";
      return { base64, mimeType };
    }
  }

  private async runUnifiedAiVision(
    imagePath: string,
    context: PipelineContext,
  ): Promise<void> {
    pipelineLogger.info(
      "Running unified AI Vision for metadata and branding detection…",
      "DirectUploader",
    );

    if (!this.freellmapi) {
      pipelineLogger.warn(
        "FreeLLMAPI client is not initialized",
        "DirectUploader",
      );
      context.metadata = this.fallbackMetadata();
      context.brandingDetection = { detected: false, zones: [] };
      return;
    }

    try {
      const { base64, mimeType } = await this.getSmallBase64Image(imagePath);

      let prompt = `You are a computer vision assistant and growth strategist for a tech/programming YouTube Shorts channel called "CodeOrCap".

Analyze this video frame/image and perform two tasks:

TASK 1: Brand/Watermark/Content Detection
Detect the exact coordinates of any branding, watermarks, profile pictures, usernames/handles, logos, or app overlays of other creators. Also, if this image shows a full Instagram page/embed layout, detect the boundaries of the main content media box. Locate them and return their bounding boxes in normalized coordinates relative to the image size (value between 0.0 and 1.0).
Search for:
- profile picture (e.g. circle image showing a person/logo in top-left or bottom-left)
- profile name / username / handle (e.g. "@username", "username" in top-left or bottom-left)
- watermarks or logos (e.g. Instagram logo, TikTok watermark, other channel logo)
- actions panel (e.g. reels interaction panel on the right with like/comment/share icons)
- main_post_content (e.g. if the image contains a full post layout, comments, or web view headers, detect the bounding box of the central post image/media box itself, excluding headers, comments, likes, and footer chrome)

If no such elements are present, return an empty array for brandingZones.

  TASK 2: YouTube Shorts Metadata & Mood Generation
Based on the content in the image, write high-CTR, scroll-stopping, SEO-optimized metadata and identify the mood of the content.
- title: curiosity-driven, punchy, under 80 chars. Use power words and emojis.
- description: 2-3 sentences explaining the value. End with 5-6 hashtags. Max 400 chars.
- tags: 10-12 specific tags.
- mood: Determine the emotional tone or theme of the content. Choose exactly one of: "funny", "sad", or "other" (for general, educational, motivational, or tech tips).

Return ONLY a raw JSON object matching this schema — no markdown, no explanation:
{
  "metadata": {
    "title": string,
    "description": string,
    "tags": string[],
    "mood": "funny" | "sad" | "other"
  },
  "brandingZones": [
    {
      "type": "logo" | "watermark" | "handle" | "profile_name" | "main_post_content",
      "box": {
        "x": number,
        "y": number,
        "width": number,
        "height": number
      },
      "description": string
    }
  ]
}`;

      if (context.userPrompt) {
        prompt += `\n\nADDITIONAL EDITING INSTRUCTION FROM USER:
The user has requested the following adjustment: "${context.userPrompt}".
Adapt both Task 1 (bounding boxes / content coordinates) and Task 2 (metadata titles, tags, description) to satisfy this request.
Important:
- If the user request implies cropping, showing the main content only, removing the outer Instagram/TikTok chrome (likes, comments, header, footer), or focusing on the post itself, you MUST identify the exact boundaries of the central post image/media box as the "main_post_content" zone. Do not include the header or footer chrome in this zone.
- If the user asks to "change title to X", make sure the metadata title is X. If they ask to "make title more funny", rewrite the title to be funny.`;
      }

      let raw = "";
      if (this.freellmapi) {
        pipelineLogger.info(
          "Attempting metadata generation via FreeLLMAPI...",
          "DirectUploader",
        );
        raw = await this.freellmapi.generateVision(prompt, base64, mimeType);
      }

      if (!raw) {
        throw new Error("FreeLLMAPI failed to respond.");
      }

      const data = parseAiJson<{
        metadata: VideoMetadata;
        brandingZones: Array<{
          type: "logo" | "watermark" | "handle" | "profile_name";
          box: { x: number; y: number; width: number; height: number };
          description: string;
        }>;
      }>(raw);

      if (
        !data.metadata ||
        !data.metadata.title ||
        !data.metadata.description ||
        !Array.isArray(data.metadata.tags)
      ) {
        throw new Error("AI JSON missing metadata fields");
      }

      context.metadata = data.metadata;

      const zones = (data.brandingZones || []).map((item, index) => ({
        id: `ai-branding-${index}`,
        type: item.type,
        boundingBox: item.box,
        confidence: 0.9,
        description: item.description,
      }));

      context.brandingDetection = {
        detected: zones.length > 0,
        zones,
      };

      pipelineLogger.checkpoint(
        "Unified AI vision completed",
        true,
        `Metadata: "${data.metadata.title}", Branding zones: ${zones.length}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pipelineLogger.error("Unified AI vision failed", err, "DirectUploader");

      const chatId = context.telegramMeta?.chatId;
      const messageId = context.telegramMeta?.messageId;
      if (chatId) {
        if (/quota|limit|429|resource_exhausted/i.test(msg)) {
          this.telegram
            .sendMessage(
              chatId,
              `⚠️ *AI Vision Quota Error:* Your Gemini API key has exceeded its daily free tier quota.\n\n` +
                `*Details:* \`Free tier daily request limit exceeded.\`\n\n` +
                `_Fallback metadata will be used and watermark/profile blurring will be skipped._`,
              messageId,
            )
            .catch(() => {});
        } else {
          this.telegram
            .sendMessage(
              chatId,
              `⚠️ *AI Vision Error:* Failed to analyze frame: \`${msg.slice(0, 150)}\`\n\n` +
                `_Using default fallback template. Zones will not be blurred._`,
              messageId,
            )
            .catch(() => {});
        }
      }

      context.metadata = this.fallbackMetadata();
      context.brandingDetection = { detected: false, zones: [] };
    }
  }

  private async generateMetadata(imagePath: string): Promise<VideoMetadata> {
    pipelineLogger.info("Generating metadata via AI vision…", "DirectUploader");

    const { base64, mimeType } = await this.getSmallBase64Image(imagePath);

    const prompt = `You are a viral YouTube Shorts strategist for a tech/programming channel called "CodeOrCap".

Analyze this image carefully — read all visible text, identify the topic, tools, languages, or concepts shown.

Generate SEO-optimised YouTube Shorts metadata that will maximise clicks and watch time.

Rules:
- title: curiosity-driven, punchy, under 80 chars. Use power words and emojis. Examples: "You're Using Git Wrong 😤 Here's The Fix", "10 VS Code Shortcuts Devs Don't Know ⚡", "This Python Trick Will Blow Your Mind 🔥"
- description: 2-3 sentences explaining the value. End with 5-6 relevant hashtags. Max 400 chars.
- tags: 10-12 specific tags covering the topic, tools, and audience (no spaces in tags).
- mood: Determine the emotional tone or theme of the content. Choose exactly one of: "funny", "sad", or "other" (for general, educational, motivational, or tech tips).

Return ONLY a raw JSON object — no markdown, no explanation:
{"title":"...","description":"...","tags":["...","..."],"mood":"funny" | "sad" | "other"}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let raw = "";
        if (this.freellmapi) {
          pipelineLogger.info(
            "Attempting metadata generation via FreeLLMAPI...",
            "DirectUploader",
          );
          raw = await this.freellmapi.generateVision(prompt, base64, mimeType);
        }

        if (!raw) {
          throw new Error("FreeLLMAPI failed to respond.");
        }

        const obj = parseAiJson<VideoMetadata>(raw);
        if (!obj.title || !obj.description || !Array.isArray(obj.tags)) {
          throw new Error("Missing required fields");
        }
        pipelineLogger.checkpoint("Metadata generated", true, `"${obj.title}"`);
        return obj;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < 2 && /503|unavailable|rate|429/i.test(msg)) {
          const wait = /429/.test(msg) ? 15000 : 5000;
          pipelineLogger.warn(
            `AI attempt ${attempt + 1} failed, retrying in ${wait / 1000}s…`,
            "DirectUploader",
          );
          await new Promise((r) => setTimeout(r, wait));
        } else {
          pipelineLogger.warn(
            `AI metadata failed: ${msg} — using fallback`,
            "DirectUploader",
          );
          return this.fallbackMetadata();
        }
      }
    }
    return this.fallbackMetadata();
  }

  private fallbackMetadata(): VideoMetadata {
    return {
      title: "Mind-Blowing Tech Trick You Need To Know ⚡",
      description:
        "Level up your skills with this essential tip every developer should know. Drop a 🔥 if you found this useful!\n\n#coding #programming #developer #tech #shorts",
      tags: [
        "coding",
        "programming",
        "developer",
        "tech",
        "shorts",
        "codeorcap",
        "learntocode",
        "webdev",
      ],
    };
  }

  private async generateViralMetadata(
    imagePath: string,
  ): Promise<VideoMetadata> {
    pipelineLogger.info("Generating viral metadata via AI…", "DirectUploader");

    const { base64, mimeType } = await this.getSmallBase64Image(imagePath);

    const prompt = `You are an aggressive viral YouTube Shorts growth hacker for a tech channel called "CodeOrCap".

Analyze this image and generate the most scroll-stopping, curiosity-gap, high-CTR metadata possible.

Rules:
- title: extreme curiosity gap, controversy, or shock. Under 80 chars. Heavy emoji use. Examples: "99% of Developers Get This WRONG 💀", "I Can't Believe This Actually Works 🤯", "They Hid This Feature For Years 👀"
- description: hook in first sentence, urgency, social proof. End with 5-6 hashtags. Max 400 chars.
- tags: 10-12 viral/trending tags.
- mood: Determine the emotional tone or theme of the content. Choose exactly one of: "funny", "sad", or "other" (for general, educational, motivational, or tech tips).

Return ONLY raw JSON — no markdown:
{"title":"...","description":"...","tags":["...","..."],"mood":"funny" | "sad" | "other"}`;

    try {
      let raw = "";
      if (this.freellmapi) {
        pipelineLogger.info(
          "Attempting metadata generation via FreeLLMAPI...",
          "DirectUploader",
        );
        raw = await this.freellmapi.generateVision(prompt, base64, mimeType);
      }

      if (!raw) {
        throw new Error("FreeLLMAPI failed to respond.");
      }

      const obj = parseAiJson<VideoMetadata>(raw);
      if (!obj.title || !obj.description || !Array.isArray(obj.tags))
        throw new Error("Missing fields");
      pipelineLogger.checkpoint(
        "Viral metadata generated",
        true,
        `"${obj.title}"`,
      );
      return obj;
    } catch {
      return this.fallbackMetadata();
    }
  }

  // ── Upload to all channels ─────────────────────────────────────────────────

  private async uploadAndReport(pending: PendingUpload): Promise<void> {
    const {
      id,
      chatId,
      messageId,
      reviewMessageId,
      metadata,
      finalVideoPath,
      outputFileName,
    } = pending;

    // Remove the inline buttons from the review message
    await this.telegram.removeInlineButtons(chatId, reviewMessageId);

    await this.telegram.sendMessage(
      chatId,
      `🚀 *Uploading to ${config.youtube.channels.length} channel(s)…*`,
      messageId,
    );

    try {
      const results: UploadResult[] = await this.youtube.uploadToAllChannels(
        finalVideoPath,
        metadata,
      );

      const channelLines = results
        .map((r) => `• *${r.channelName}:* ${r.url}`)
        .join("\n");

      const successText =
        `✅ *Uploaded to ${results.length} channel(s)!*\n\n` +
        `*Title:* ${metadata.title}\n\n` +
        `${channelLines}\n\n` +
        `*File:* output/${outputFileName.replace(/_/g, "\\_")}\n*ID:* ${id}`;

      const successMessageId = await this.telegram.sendSuccessMessageWithRevoke(
        chatId,
        successText,
        id,
        messageId,
      );

      this.uploaded.set(id, {
        channelResults: results,
        chatId,
        successMessageId,
      });

      // Clean up/delete the review video message and the original user message from Telegram
      await this.telegram.deleteMessage(chatId, reviewMessageId);
      if (messageId) {
        await this.telegram.deleteMessage(chatId, messageId);
      }

      pipelineLogger.checkpoint(
        "All uploads complete",
        true,
        `${results.length} channel(s)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pipelineLogger.error(`Upload failed for ${id}`, err, "DirectUploader");
      await this.telegram.sendMessage(
        chatId,
        `❌ *Upload failed*\n\`${msg.slice(0, 300)}\``,
        messageId,
      );
    }

    this.pending.delete(id);
  }

  // ── Review button handlers ─────────────────────────────────────────────────

  private onPublish(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.uploadAndReport(pending).catch((err) =>
      pipelineLogger.error(`Upload error for ${id}`, err, "DirectUploader"),
    );
  }

  private onCancel(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.telegram.removeInlineButtons(pending.chatId, pending.reviewMessageId);
    this.telegram.sendMessage(
      pending.chatId,
      `❌ *Cancelled.* Video saved locally at output/${pending.outputFileName.replace(/_/g, "\\_")}`,
      pending.messageId,
    );
    pipelineLogger.info(`Upload cancelled by user for ${id}`, "DirectUploader");
  }

  private onRegenerate(id: string, viral: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;

    const label = viral ? "viral" : "standard";
    pipelineLogger.info(
      `Regenerating ${label} metadata for ${id}`,
      "DirectUploader",
    );

    const generate = viral
      ? this.generateViralMetadata(pending.originalImagePath)
      : this.generateMetadata(pending.originalImagePath);

    generate
      .then(async (metadata) => {
        // Update stored metadata
        pending.metadata = metadata;

        const caption =
          `📋 *Review your Short* _(updated)_\n\n` +
          `*Title:* ${metadata.title}\n\n` +
          `*Description:* ${metadata.description.slice(0, 200)}…\n\n` +
          `⏳ _Auto-publishes in 2 minutes if no action taken._`;

        await this.telegram.updateReviewCaption(
          pending.chatId,
          pending.reviewMessageId,
          caption,
          id,
        );
      })
      .catch((err) =>
        pipelineLogger.error(
          `Regenerate failed for ${id}`,
          err,
          "DirectUploader",
        ),
      );
  }

  private async onRevoke(id: string): Promise<void> {
    const uploadedData = this.uploaded.get(id);
    if (!uploadedData) {
      pipelineLogger.warn(
        `Revoke requested for ID ${id} but no upload records found in memory.`,
        "DirectUploader",
      );
      return;
    }

    const { channelResults, chatId, successMessageId } = uploadedData;

    // Remove the revoke inline button immediately to prevent double-clicks
    await this.telegram.removeInlineButtons(chatId, successMessageId);

    // Notify user we are starting revocation
    await this.telegram.sendMessage(
      chatId,
      `⏳ *Revoking upload from all channels…*`,
      successMessageId,
    );

    const deletionPromises = channelResults.map(async (res) => {
      const success = await this.youtube.deleteFromChannel(
        res.channelName,
        res.videoId,
      );
      return { ...res, success };
    });

    const deletionResults = await Promise.all(deletionPromises);
    const successDeletions = deletionResults.filter((d) => d.success);
    const failedDeletions = deletionResults.filter((d) => !d.success);

    if (successDeletions.length === deletionResults.length) {
      // All deleted successfully
      await this.telegram.sendMessage(
        chatId,
        `🗑️ *Revoked successfully!*\n\n` +
          `Deleted video from all ${successDeletions.length} channel(s) on YouTube.`,
        successMessageId,
      );
    } else {
      // Some or all failed
      const successLines = successDeletions
        .map((r) => `• *${r.channelName}* (Deleted)`)
        .join("\n");
      const failedLines = failedDeletions
        .map(
          (r) =>
            `• *${r.channelName}* (Failed to delete - ID: \`${r.videoId}\`)`,
        )
        .join("\n");

      let errorText = `⚠️ *Revocation partially completed/failed*:\n\n`;
      if (successLines) errorText += `${successLines}\n`;
      if (failedLines) errorText += `${failedLines}\n`;

      await this.telegram.sendMessage(chatId, errorText, successMessageId);
    }

    // Clean up from map
    this.uploaded.delete(id);
  }

  // ── Main pipeline ──────────────────────────────────────────────────────────

  public async run(context: PipelineContext): Promise<void> {
    const { id, tempDir, originalImagePath, telegramMeta } = context;
    const { chatId, messageId } = telegramMeta;
    const isVideo = context.isVideo === true;
    const mediaLabel = isVideo ? "video" : "image";

    const pristineImagePath = path.join(tempDir, "pristine_original.jpg");
    const pristineVideoPath = path.join(tempDir, "pristine_video.mp4");

    // 1. On first run, create backup of original files
    if (isVideo && context.originalVideoPath) {
      if (
        !fs.existsSync(pristineVideoPath) &&
        fs.existsSync(context.originalVideoPath)
      ) {
        fs.copyFileSync(context.originalVideoPath, pristineVideoPath);
      }
    } else if (fs.existsSync(originalImagePath)) {
      if (!fs.existsSync(pristineImagePath)) {
        fs.copyFileSync(originalImagePath, pristineImagePath);
      }
    }

    // 2. Before we start processing, restore original pristine files (prevent "editing on edited")
    if (isVideo && fs.existsSync(pristineVideoPath)) {
      fs.copyFileSync(pristineVideoPath, context.originalVideoPath!);
    } else if (fs.existsSync(pristineImagePath)) {
      fs.copyFileSync(pristineImagePath, originalImagePath);
    }

    try {
      await this.telegram.sendMessage(
        chatId,
        `⚙️ *Processing your ${mediaLabel}…*\n\`ID: ${id}\`\n\nGenerating metadata, editing video, adding music…`,
        messageId,
      );

      // If video, extract a frame first so AI vision and detection have access to it
      if (isVideo && context.originalVideoPath) {
        context.status = "analyzing";
        const extractCmd = `ffmpeg -y -ss 00:00:01 -i "${context.originalVideoPath}" -vframes 1 -q:v 2 "${originalImagePath}"`;
        await new Promise<void>((resolve, reject) => {
          exec(extractCmd, (err, _stdout, _stderr) => {
            if (err) {
              const fallbackCmd = `ffmpeg -y -ss 00:00:00 -i "${context.originalVideoPath}" -vframes 1 -q:v 2 "${originalImagePath}"`;
              exec(fallbackCmd, (err2) => {
                if (err2) reject(err2);
                else resolve();
              });
            } else {
              resolve();
            }
          });
        });
      }

      // 1 — Metadata & Branding Detection (always run vision model to detect watermarks/branding)
      await this.runUnifiedAiVision(originalImagePath, context);

      // Override with caption-provided metadata only if there's no active user prompt adjustment
      if (context.captionMetadata && !context.userPrompt) {
        pipelineLogger.info(
          "Applying caption-provided metadata override — retaining branding detection",
          "DirectUploader",
        );
        context.metadata = {
          title: context.captionMetadata.title,
          description: context.captionMetadata.description,
          tags: context.metadata?.tags || [
            "coding",
            "programming",
            "developer",
            "tech",
            "shorts",
            "codeorcap",
          ],
        };
        pipelineLogger.checkpoint(
          "Caption metadata override loaded",
          true,
          `"${context.metadata.title}"`,
        );
      }

      const metadata = context.metadata!;

      // 2 — Render/Process video
      context.status = "rendering_video";
      const rawVideoPath = path.join(tempDir, "video_raw.mp4");
      if (isVideo && context.originalVideoPath) {
        await this.renderer.processVideo(
          context.originalVideoPath,
          rawVideoPath,
          context,
          {
            durationSeconds: config.rendering.videoDurationSeconds,
            fps: config.rendering.fps,
            effect: "none",
          },
        );
      } else {
        // 2a — Blur other branding zones (logo, watermark, handle, profile_name, other) on the static image
        const otherZones = context.brandingDetection?.zones.filter(
          (z) => z.type !== "main_post_content",
        );
        if (otherZones && otherZones.length > 0) {
          try {
            pipelineLogger.info(
              `Applying blur to ${otherZones.length} branding zones on static image...`,
              "DirectUploader",
            );
            const meta = await sharp(originalImagePath).metadata();
            if (meta.width && meta.height) {
              const composites: sharp.OverlayOptions[] = [];

              for (const z of otherZones) {
                const box = z.boundingBox;
                const x = Math.round(box.x * meta.width);
                const y = Math.round(box.y * meta.height);
                const w = Math.round(box.width * meta.width);
                const h = Math.round(box.height * meta.height);

                const safeX = Math.max(0, Math.min(meta.width - 10, x));
                const safeY = Math.max(0, Math.min(meta.height - 10, y));
                const safeW = Math.max(10, Math.min(meta.width - safeX, w));
                const safeH = Math.max(10, Math.min(meta.height - safeY, h));

                // Extract the region, blur it, and prepare as a composite overlay
                const blurredRegion = await sharp(originalImagePath)
                  .extract({
                    left: safeX,
                    top: safeY,
                    width: safeW,
                    height: safeH,
                  })
                  .blur(20) // apply a strong blur to obliterate text
                  .toBuffer();

                composites.push({
                  input: blurredRegion,
                  left: safeX,
                  top: safeY,
                });
              }

              if (composites.length > 0) {
                const blurredTemp = path.join(tempDir, "original_blurred.jpg");
                await sharp(originalImagePath)
                  .composite(composites)
                  .toFile(blurredTemp);

                fs.copyFileSync(blurredTemp, originalImagePath);
                try {
                  fs.unlinkSync(blurredTemp);
                } catch {}
                pipelineLogger.checkpoint(
                  "Static image branding zones blurred successfully",
                  true,
                );
              }
            }
          } catch (err) {
            pipelineLogger.error(
              "Failed to blur static image branding zones",
              err,
              "DirectUploader",
            );
          }
        }

        // 2b — Blur outer areas of main_post_content if detected by the AI vision model (useful for screenshots of posts)
        const mainContentZone = context.brandingDetection?.zones.find(
          (z) => z.type === "main_post_content",
        );
        if (mainContentZone) {
          try {
            pipelineLogger.info(
              "Main post content detected. Blurring outer areas of static image...",
              "DirectUploader",
            );
            const box = mainContentZone.boundingBox;
            const meta = await sharp(originalImagePath).metadata();
            if (meta.width && meta.height) {
              const x = Math.round(box.x * meta.width);
              const y = Math.round(box.y * meta.height);
              const w = Math.round(box.width * meta.width);
              const h = Math.round(box.height * meta.height);

              const safeX = Math.max(0, Math.min(meta.width - 10, x));
              const safeY = Math.max(0, Math.min(meta.height - 10, y));
              const safeW = Math.max(10, Math.min(meta.width - safeX, w));
              const safeH = Math.max(10, Math.min(meta.height - safeY, h));

              const composites: sharp.OverlayOptions[] = [];

              // 1. Blur top region
              if (safeY > 5) {
                const blurredTop = await sharp(originalImagePath)
                  .extract({
                    left: 0,
                    top: 0,
                    width: meta.width,
                    height: safeY,
                  })
                  .blur(40)
                  .toBuffer();
                composites.push({ input: blurredTop, left: 0, top: 0 });
              }

              // 2. Blur bottom region
              const bottomHeight = meta.height - (safeY + safeH);
              if (bottomHeight > 5) {
                const blurredBottom = await sharp(originalImagePath)
                  .extract({
                    left: 0,
                    top: safeY + safeH,
                    width: meta.width,
                    height: bottomHeight,
                  })
                  .blur(40)
                  .toBuffer();
                composites.push({
                  input: blurredBottom,
                  left: 0,
                  top: safeY + safeH,
                });
              }

              // 3. Blur left region (between top and bottom)
              if (safeX > 5) {
                const blurredLeft = await sharp(originalImagePath)
                  .extract({ left: 0, top: safeY, width: safeX, height: safeH })
                  .blur(40)
                  .toBuffer();
                composites.push({ input: blurredLeft, left: 0, top: safeY });
              }

              // 4. Blur right region (between top and bottom)
              const rightWidth = meta.width - (safeX + safeW);
              if (rightWidth > 5) {
                const blurredRight = await sharp(originalImagePath)
                  .extract({
                    left: safeX + safeW,
                    top: safeY,
                    width: rightWidth,
                    height: safeH,
                  })
                  .blur(40)
                  .toBuffer();
                composites.push({
                  input: blurredRight,
                  left: safeX + safeW,
                  top: safeY,
                });
              }

              if (composites.length > 0) {
                const blurredTemp = path.join(
                  tempDir,
                  "original_outer_blurred.jpg",
                );
                await sharp(originalImagePath)
                  .composite(composites)
                  .toFile(blurredTemp);

                fs.copyFileSync(blurredTemp, originalImagePath);
                try {
                  fs.unlinkSync(blurredTemp);
                } catch {}
                pipelineLogger.checkpoint(
                  "Static image outer regions blurred successfully",
                  true,
                );
              }
            }
          } catch (err) {
            pipelineLogger.error(
              "Failed to blur static image outer regions",
              err,
              "DirectUploader",
            );
          }
        }

        await this.renderer.renderImageToVideo(
          originalImagePath,
          rawVideoPath,
          {
            durationSeconds: config.rendering.videoDurationSeconds,
            fps: config.rendering.fps,
            effect: "zoom",
          },
        );
      }

      // 2c — Render animated text layers via Remotion over the processed video
      if (
        context.ocr &&
        context.ocr.detailedWords &&
        context.ocr.detailedWords.length > 0
      ) {
        try {
          // AI Caption Rephrasing & User Prompt logic
          let rephrasedCaption = "";
          const rawOcrText = context.ocr.text || "";

          let aiPrompt = "";
          if (context.userPrompt) {
            aiPrompt = `You are a copywriting expert for a tech meme channel.
Modify the video caption based on the user's instructions.
User Instruction: "${context.userPrompt}"
Original Video Text: "${rawOcrText}"

Return ONLY the final caption text. Do not include social handles (words with '@'). No quotes, no explanations.`;
          } else {
            aiPrompt = `You are a copywriting expert for a tech meme channel.
Take the raw OCR text extracted from a video clip, remove any social media handles (words containing '@') or watermarks, and rephrase it into a single, punchy, high-engagement caption in standard capitalization (Title Case). Keep it clean, under 12-15 words.

OCR Text: "${rawOcrText}"

Return ONLY the rephrased caption text. No quotes, no explanations.`;
          }

          if (this.freellmapi) {
            try {
              pipelineLogger.info(
                "Rephrasing caption with AI...",
                "DirectUploader",
              );
              const aiResponse = await this.freellmapi.generateText(aiPrompt);
              rephrasedCaption = aiResponse.trim().replace(/^["']|["']$/g, "");
              pipelineLogger.checkpoint(
                "AI caption generated",
                true,
                rephrasedCaption,
              );
            } catch (err) {
              pipelineLogger.warn(
                `AI caption generation failed: ${err}. Falling back to clean OCR text.`,
                "DirectUploader",
              );
              rephrasedCaption = rawOcrText
                .split(/\s+/)
                .filter((w) => !w.includes("@"))
                .join(" ");
            }
          } else {
            rephrasedCaption = rawOcrText
              .split(/\s+/)
              .filter((w) => !w.includes("@"))
              .join(" ");
          }

          context.rephrasedCaption = rephrasedCaption;

          pipelineLogger.info(
            "Rendering animated text layers via Remotion...",
            "DirectUploader",
          );

          // 1. Copy video_raw.mp4 to Remotion public/ directory
          const remotionProjectDir = path.join(
            __dirname,
            "../website-audit-reel",
          );
          const remotionPublicDir = path.join(remotionProjectDir, "public");
          if (!fs.existsSync(remotionPublicDir)) {
            fs.mkdirSync(remotionPublicDir, { recursive: true });
          }

          const remotionInputPath = path.join(
            remotionPublicDir,
            "video_input.mp4",
          );
          fs.copyFileSync(rawVideoPath, remotionInputPath);

          // 2. Map OCR words to final 1080x1920 coordinates
          const analysis = context.analysis!;
          const detection = context.brandingDetection!;

          let yCropped = 0;
          let hCropped = analysis.height;
          let wCropped = analysis.width;
          let hScaled = 1920;
          let yOffset = 0;

          if (isVideo) {
            // Find edge zones to get exact cropping coordinates used by VideoRenderer
            const edgeTopZones = detection.zones.filter(
              (z) =>
                !z.id.startsWith("ai-branding-") &&
                z.boundingBox.y === 0 &&
                z.boundingBox.height <= 0.12,
            );
            const edgeBottomZones = detection.zones.filter(
              (z) =>
                !z.id.startsWith("ai-branding-") &&
                z.boundingBox.y + z.boundingBox.height >= 0.98 &&
                z.boundingBox.height <= 0.12,
            );

            let cropTop = 0;
            let cropBottom = 0;
            if (edgeTopZones.length > 0) {
              cropTop = Math.max(
                ...edgeTopZones.map((z) => z.boundingBox.height),
              );
            }
            if (edgeBottomZones.length > 0) {
              cropBottom = Math.max(
                ...edgeBottomZones.map((z) => z.boundingBox.height),
              );
            }

            // Fallback defaults if they were used
            const finalCropTop = cropTop > 0 ? cropTop : 0.08;
            const finalCropBottom = cropBottom > 0 ? cropBottom : 0.08;

            yCropped = Math.round(analysis.height * finalCropTop);
            hCropped =
              analysis.height -
              yCropped -
              Math.round(analysis.height * finalCropBottom);

            const aspectTarget = 1080 / 1920;
            const aspectCropped = wCropped / hCropped;

            if (aspectCropped < aspectTarget) {
              // Zoom-to-fill or height scaled
              hScaled = 1920;
              yOffset = 0;
            } else {
              hScaled = Math.round(1080 / aspectCropped);
              yOffset = Math.round((1920 - hScaled) / 2);
            }
          }

          const textLayers = context.ocr.detailedWords
            .filter((word) => word.confidence >= 85)
            .map((word) => {
              const origX = word.bbox.x0;
              const origY = word.bbox.y0;
              const origW = word.bbox.x1 - word.bbox.x0;
              const origH = word.bbox.y1 - word.bbox.y0;

              const cropX = origX - 0; // xCropped is 0
              const cropY = origY - yCropped;

              const X_px = Math.round(cropX * (1080 / wCropped));
              const Y_px = Math.round(cropY * (hScaled / hCropped)) + yOffset;
              const W_px = Math.round(origW * (1080 / wCropped));
              const H_px = Math.round(origH * (hScaled / hCropped));

              const isMemeText = word.bbox.y0 < 665;

              return {
                text: word.text,
                left: X_px,
                top: Y_px,
                width: W_px,
                height: H_px,
                isMemeText,
              };
            });

          // 3. Prepare render props
          const renderProps = {
            mediaUrl: "video_input.mp4",
            mediaType: "video",
            textLayers,
            memeCaption: context.rephrasedCaption || "",
          };

          const propsFile = path.join(tempDir, "remotion_props.json");
          fs.writeFileSync(propsFile, JSON.stringify(renderProps));

          // 4. Execute npx remotion render
          const remotionOutputPath = path.join(
            remotionPublicDir,
            "video_output.mp4",
          );

          // Delete old output to prevent caching
          if (fs.existsSync(remotionOutputPath)) {
            fs.unlinkSync(remotionOutputPath);
          }

          // Detect raw video duration using ffprobe to match original duration exactly
          let durationInFrames = 450; // fallback to 15 seconds
          try {
            const ffprobeCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${rawVideoPath}"`;
            const durationSec = await new Promise<number>((resolve, reject) => {
              exec(ffprobeCmd, (err, stdout) => {
                if (err) reject(err);
                else resolve(parseFloat(stdout.trim()));
              });
            });
            if (!isNaN(durationSec) && durationSec > 0) {
              durationInFrames = Math.round(durationSec * config.rendering.fps);
              pipelineLogger.info(
                `Detected raw video duration: ${durationSec}s (${durationInFrames} frames)`,
                "DirectUploader",
              );
            }
          } catch (err) {
            pipelineLogger.warn(
              `Failed to detect video duration via ffprobe: ${err instanceof Error ? err.message : err}. Falling back to default duration.`,
              "DirectUploader",
            );
          }

          pipelineLogger.info(
            "Executing Remotion rendering CLI command...",
            "DirectUploader",
          );
          const renderCmd = `npx remotion render DynamicText "${remotionOutputPath}" --props="${propsFile}" --duration=${durationInFrames}`;

          await new Promise<void>((resolve, reject) => {
            exec(
              renderCmd,
              { cwd: remotionProjectDir },
              (err, stdout, stderr) => {
                if (err) {
                  pipelineLogger.error(
                    "Remotion render CLI execution failed",
                    stderr || err,
                    "DirectUploader",
                  );
                  reject(err);
                } else {
                  pipelineLogger.info(
                    `Remotion CLI output: ${stdout}`,
                    "DirectUploader",
                  );
                  resolve();
                }
              },
            );
          });

          // 5. Copy outputs back to rawVideoPath
          if (fs.existsSync(remotionOutputPath)) {
            fs.copyFileSync(remotionOutputPath, rawVideoPath);
            pipelineLogger.checkpoint(
              "✓ Remotion rendering completed successfully",
              true,
            );
          } else {
            throw new Error(
              "Remotion output file not found after successful render command",
            );
          }

          // Cleanup temp files
          try {
            fs.unlinkSync(remotionInputPath);
            fs.unlinkSync(remotionOutputPath);
            fs.unlinkSync(propsFile);
          } catch (_) {}
        } catch (remotionErr) {
          pipelineLogger.error(
            "Remotion rendering failed, falling back to standard video",
            remotionErr,
            "DirectUploader",
          );
        }
      }

      // 3 — Add music
      const finalVideoPath = path.join(tempDir, "video_final.mp4");
      await this.music.addBackgroundMusic(
        rawVideoPath,
        config.paths.musicDir,
        finalVideoPath,
        metadata.mood,
      );

      // 4 — Save to output folder
      fs.mkdirSync(config.paths.outputDir, { recursive: true });
      const safeTitle = metadata.title
        .replace(/[^a-zA-Z0-9 _-]/g, "")
        .trim()
        .replace(/\s+/g, "_")
        .slice(0, 60);
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
        chatId,
        finalVideoPath,
        caption,
        id,
        messageId,
      );

      // 6 — Set 2-minute auto-publish timer
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.telegram.sendMessage(
          chatId,
          `⏰ *2 minutes elapsed — auto-publishing now…*`,
          messageId,
        );
        this.uploadAndReport(p).catch((err) =>
          pipelineLogger.error(
            `Auto-upload error for ${id}`,
            err,
            "DirectUploader",
          ),
        );
      }, REVIEW_TIMEOUT_MS);

      this.pending.set(id, {
        id,
        chatId,
        messageId,
        reviewMessageId,
        metadata,
        finalVideoPath,
        outputFilePath,
        outputFileName,
        originalImagePath,
        timer,
        context,
      });

      pipelineLogger.checkpoint(
        "Review sent to Telegram",
        true,
        `${id} — waiting up to 2 min`,
      );
    } catch (err) {
      context.status = "failed";
      context.error = err instanceof Error ? err.message : String(err);
      pipelineLogger.error(
        `DirectUploader failed for ${id}`,
        err,
        "DirectUploader",
      );
      await this.telegram.sendMessage(
        chatId,
        `❌ *Processing failed*\n\`${context.error?.slice(0, 300)}\``,
        messageId,
      );
    }
  }

  private async handleUserTextPrompt(
    chatId: number,
    promptText: string,
    messageId: number,
  ): Promise<boolean> {
    // Find if there is a pending review in this chat
    let pendingId: string | null = null;
    let pendingUpload: PendingUpload | null = null;

    for (const [id, val] of this.pending.entries()) {
      if (val.chatId === chatId) {
        pendingId = id;
        pendingUpload = val;
        break;
      }
    }

    if (!pendingId || !pendingUpload) {
      return false; // No pending review in this chat
    }

    pipelineLogger.info(
      `User text prompt received for active generation ${pendingId}: "${promptText}"`,
      "DirectUploader",
    );

    // 1. Cancel the current auto-publish timer
    clearTimeout(pendingUpload.timer);

    // 2. Remove inline buttons from the old review message
    await this.telegram
      .removeInlineButtons(chatId, pendingUpload.reviewMessageId)
      .catch(() => {});

    // 3. Notify user that we are re-processing
    await this.telegram.sendMessage(
      chatId,
      `🔄 *Instruction received:* \`"${promptText}"\`\n\nRe-processing and regenerating video based on your prompt…`,
      messageId,
    );

    // 4. Update context with user prompt, and clear cached metadata/branding to force regeneration
    const context = pendingUpload.context;
    context.userPrompt = promptText;
    context.metadata = undefined;
    context.brandingDetection = undefined;

    // Delete old intermediate files to prevent caching
    try {
      const rawVideo = path.join(context.tempDir, "video_raw.mp4");
      const finalVideo = path.join(context.tempDir, "video_final.mp4");
      if (fs.existsSync(rawVideo)) fs.unlinkSync(rawVideo);
      if (fs.existsSync(finalVideo)) fs.unlinkSync(finalVideo);
    } catch (_) {}

    // 5. Clean from pending map (since run() will create a new entry on success)
    this.pending.delete(pendingId);

    // 6. Run pipeline
    this.run(context).catch((err) => {
      pipelineLogger.error(
        `Regeneration from prompt failed for ${pendingId}`,
        err,
        "DirectUploader",
      );
    });

    return true;
  }
}
