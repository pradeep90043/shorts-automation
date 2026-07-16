import { Telegraf } from "telegraf";
import fs from "fs";
import path from "path";
import { pipeline } from "stream";
import { promisify } from "util";
import { config, ChannelProfile } from "../config";
import { ITelegramService, PipelineContext, TelegramMetadata, AssetKind, ReviewSettings } from "../types";
import { pipelineLogger } from "../utils/logger";
import {
  isInstagramReelUrl,
  extractInstagramUrl,
  downloadReelFrame,
  isTikTokUrl,
  extractTikTokUrl,
} from "../instagram";

const streamPipeline = promisify(pipeline);

export function escapeMarkdown(text: string): string {
  if (!text) return "";
  return text
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[");
}

export class TelegramService implements ITelegramService {
  private bot: Telegraf;
  public readonly profile: ChannelProfile;
  private pipelineTrigger?: (context: PipelineContext) => Promise<void>;
  private approvalTrigger?: (genId: string) => Promise<void>;
  private reviewCallback?: (
    action: "publish" | "cancel" | "regenerate" | "viral" | "toggle_voiceover" | "replace_music",
    id: string,
  ) => void;
  private revokeCallback?: (id: string) => Promise<void>;
  private textPromptCallback?: (
    chatId: number,
    text: string,
    messageId: number,
  ) => Promise<boolean>;
  private audioUploadCallback?: (
    chatId: number,
    fileId: string,
    fileName: string,
    messageId: number,
  ) => Promise<boolean>;
  private settingsReviewCallback?: (code: string, id: string) => void;

  constructor(profile: ChannelProfile = config.profiles[0]) {
    if (!profile || !profile.telegramToken) {
      throw new Error(
        "No Telegram bot token configured. Set TELEGRAM_BOT_TOKEN (or <PREFIX>_TELEGRAM_BOT_TOKEN_LOCAL/_PROD) in .env.",
      );
    }
    this.profile = profile;
    this.bot = new Telegraf(profile.telegramToken);
    this.setupHandlers();
  }

  /**
   * Registers the orchestrator trigger callback
   */
  public registerPipelineTrigger(
    trigger: (context: PipelineContext) => Promise<void>,
  ): void {
    this.pipelineTrigger = trigger;
  }

  /**
   * Registers the orchestrator manual approval callback
   */
  public registerApprovalTrigger(
    trigger: (genId: string) => Promise<void>,
  ): void {
    this.approvalTrigger = trigger;
  }

  /**
   * Registers the review publish/cancel callback from DirectUploader
   */
  public registerReviewCallback(
    cb: (
      action: "publish" | "cancel" | "regenerate" | "viral" | "toggle_voiceover" | "replace_music",
      id: string,
    ) => void,
  ): void {
    this.reviewCallback = cb;
  }

  /**
   * Registers the revoke callback from DirectUploader
   */
  public registerRevokeCallback(cb: (id: string) => Promise<void>): void {
    this.revokeCallback = cb;
  }

  public registerTextPromptCallback(
    cb: (chatId: number, text: string, messageId: number) => Promise<boolean>,
  ): void {
    this.textPromptCallback = cb;
  }

  public registerAudioUploadCallback(
    cb: (chatId: number, fileId: string, fileName: string, messageId: number) => Promise<boolean>,
  ): void {
    this.audioUploadCallback = cb;
  }

  public registerSettingsReviewCallback(
    cb: (code: string, id: string) => void,
  ): void {
    this.settingsReviewCallback = cb;
  }

  private reviewKeyboard(id: string) {
    return {
      inline_keyboard: [
        [
          { text: "✅ Publish Now", callback_data: `rv_pub_${id}` },
          { text: "❌ Cancel", callback_data: `rv_can_${id}` },
        ],
        [
          { text: "🔄 Regenerate", callback_data: `rv_reg_${id}` },
          { text: "🎯 More Viral", callback_data: `rv_vrl_${id}` },
        ],
        [
          { text: "🔊 / 🔇 Toggle Voiceover", callback_data: `rv_togv_${id}` },
          { text: "🎵 Replace Music", callback_data: `rv_mus_${id}` },
        ],
      ],
    };
  }

  /**
   * Send a video with all review buttons.
   * Returns the message_id of the sent video message.
   */
  public async sendVideoForReview(
    chatId: number,
    videoPath: string,
    caption: string,
    id: string,
    replyToMessageId?: number,
  ): Promise<number> {
    const res = await this.bot.telegram.sendVideo(
      chatId,
      { source: fs.createReadStream(videoPath) },
      {
        caption,
        parse_mode: "Markdown",
        reply_parameters: replyToMessageId
          ? { message_id: replyToMessageId }
          : undefined,
        reply_markup: this.reviewKeyboard(id),
      } as any,
    );
    return res.message_id;
  }
  /**
   * Inline keyboard for the pre-processing settings review.
   * Toggle buttons reflect the current state; the selected crop step is marked.
   */
  private settingsKeyboard(id: string, s: ReviewSettings) {
    const onOff = (v: boolean) => (v ? "ON ✅" : "OFF");
    const cropRow = (prefix: "ct" | "cb", selected: number, arrow: string) =>
      [0, 5, 10, 15, 20, 25].map((pct) => ({
        text: `${pct === selected ? "•" : ""}${arrow}${pct}`,
        callback_data: `st_${prefix}${pct}_${id}`,
      }));
    return {
      inline_keyboard: [
        [
          { text: `🎙 Voiceover: ${onOff(s.voiceover)}`, callback_data: `st_vo_${id}` },
          { text: `🔊 Orig Audio: ${onOff(s.originalAudio)}`, callback_data: `st_oa_${id}` },
        ],
        [
          { text: `🎵 Music: ${onOff(s.music)}`, callback_data: `st_mu_${id}` },
          { text: `💬 Captions: ${onOff(s.captions)}`, callback_data: `st_cc_${id}` },
        ],
        cropRow("ct", s.cropTopPct, "⬆"),
        cropRow("cb", s.cropBottomPct, "⬇"),
        [
          { text: "▶️ Process Now", callback_data: `st_go_${id}` },
          { text: "❌ Cancel", callback_data: `st_can_${id}` },
        ],
      ],
    };
  }

  /**
   * Send the pre-processing settings review message with toggle buttons.
   * Returns the message_id of the sent message.
   */
  public async sendSettingsReview(
    chatId: number,
    text: string,
    id: string,
    settings: ReviewSettings,
    replyToMessageId?: number,
  ): Promise<number> {
    const res = await this.bot.telegram.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_parameters: replyToMessageId
        ? { message_id: replyToMessageId }
        : undefined,
      reply_markup: this.settingsKeyboard(id, settings),
    } as any);
    return res.message_id;
  }

  /**
   * Refresh the settings review message after a toggle tap. Errors are
   * swallowed so rapid taps hitting Telegram rate limits cannot crash.
   */
  public async updateSettingsReview(
    chatId: number,
    messageId: number,
    text: string,
    id: string,
    settings: ReviewSettings,
  ): Promise<void> {
    try {
      await this.bot.telegram.editMessageText(chatId, messageId, undefined, text, {
        parse_mode: "Markdown",
        reply_markup: this.settingsKeyboard(id, settings),
      } as any);
    } catch (_) {}
  }
  /**
   * Update the caption of the review message (after regenerating metadata)
   */
  public async updateReviewCaption(
    chatId: number,
    messageId: number,
    caption: string,
    id: string,
  ): Promise<void> {
    try {
      await this.bot.telegram.editMessageCaption(
        chatId,
        messageId,
        undefined,
        caption,
        {
          parse_mode: "Markdown",
          reply_markup: this.reviewKeyboard(id),
        } as any,
      );
    } catch (_) {}
  }

  /**
   * Update the video of the review message (e.g. after replacing music).
   * Telegram sometimes rejects editMessageMedia (e.g. message too old or
   * media unchanged) — in that case send a fresh review message instead of
   * failing silently. Returns the message_id that now carries the review
   * keyboard (the original one, or the fresh message on fallback).
   */
  public async editReviewVideo(
    chatId: number,
    messageId: number,
    videoPath: string,
    caption: string,
    id: string,
  ): Promise<number> {
    try {
      await this.bot.telegram.editMessageMedia(
        chatId,
        messageId,
        undefined,
        {
          type: "video",
          media: { source: fs.createReadStream(videoPath) },
          caption,
          parse_mode: "Markdown",
        },
        {
          reply_markup: this.reviewKeyboard(id),
        } as any
      );
      pipelineLogger.info(
        `Review message ${messageId} media updated successfully`,
        "Telegram",
      );
      return messageId;
    } catch (err) {
      pipelineLogger.warn(
        `Failed to edit message media, sending a fresh review message instead: ${err instanceof Error ? err.message : err}`,
        "Telegram",
      );
      return this.sendVideoForReview(chatId, videoPath, caption, id, messageId);
    }
  }

  /**
   * Remove inline buttons from a message (after publish or cancel)
   */
  public async removeInlineButtons(
    chatId: number,
    messageId: number,
  ): Promise<void> {
    try {
      await this.bot.telegram.editMessageReplyMarkup(
        chatId,
        messageId,
        undefined,
        { inline_keyboard: [] },
      );
    } catch (_) {}
  }

  /**
   * Send a success message with a revoke button
   */
  public async sendSuccessMessageWithRevoke(
    chatId: number,
    text: string,
    id: string,
    replyToMessageId?: number,
  ): Promise<number> {
    const res = await this.bot.telegram.sendMessage(chatId, text, {
      reply_parameters: replyToMessageId
        ? { message_id: replyToMessageId }
        : undefined,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🗑️ Revoke Upload", callback_data: `rvk_${id}` }],
        ],
      },
    });
    return res.message_id;
  }

  // New method to send a raw video without review buttons, used for final video delivery
  public async sendRawVideo(
    chatId: number,
    videoPath: string,
    caption: string,
  ): Promise<number> {
    const res = await this.bot.telegram.sendVideo(
      chatId,
      { source: fs.createReadStream(videoPath) },
      {
        caption,
        parse_mode: "Markdown",
      } as any,
    );
    return res.message_id;
  }

  public async start(): Promise<void> {
    this.bot.launch();
    pipelineLogger.info(
      `Telegram Bot [${this.profile.brandName}] successfully started and listening for messages.`,
      "Telegram",
    );

    // Enable graceful stop
    process.once("SIGINT", () => this.bot.stop("SIGINT"));
    process.once("SIGTERM", () => this.bot.stop("SIGTERM"));
  }

  public async downloadFile(fileId: string, destPath: string): Promise<void> {
    const fileLink = await this.bot.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.toString());

    if (!response.ok) {
      throw new Error(
        `Failed to download file from Telegram: ${response.statusText}`,
      );
    }

    const fileStream = fs.createWriteStream(destPath);
    if (!response.body) {
      throw new Error("Telegram download response body is empty");
    }

    // @ts-ignore - response.body is a ReadableStream which is compatible with streamPipeline in Node
    await streamPipeline(response.body, fileStream);
  }

  public async sendMessage(
    chatId: number,
    text: string,
    replyToMessageId?: number,
  ): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, text, {
        reply_parameters: replyToMessageId
          ? { message_id: replyToMessageId }
          : undefined,
        parse_mode: "Markdown",
      });
    } catch (err) {
      pipelineLogger.error(
        `Failed to send Telegram message to chat ${chatId}`,
        err,
        "Telegram",
      );
    }
  }

  public async deleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.bot.telegram.deleteMessage(chatId, messageId);
      pipelineLogger.info(
        `Deleted message ${messageId} in chat ${chatId}`,
        "Telegram",
      );
    } catch (err) {
      pipelineLogger.warn(
        `Failed to delete message ${messageId} in chat ${chatId}: ${err instanceof Error ? err.message : err}`,
        "Telegram",
      );
    }
  }

  private setupHandlers(): void {
    // Start command
    this.bot.start((ctx) => {
      ctx.reply(
        `🤖 *${this.profile.brandName} Shorts Automation Bot*\n\n` +
          "Send me any screenshot or image (PNG, JPG, JPEG), and I will:\n" +
          "1. Detect and attempt branding removal\n" +
          "2. Run OCR to parse contents\n" +
          "3. Create a clean 9:16 layout\n" +
          "4. Apply premium CodeOrCap branding\n" +
          "5. Generate AI titles & description\n" +
          "6. Render as an HD Short with animations & music\n" +
          "7. Upload directly to YouTube!\n\n" +
          "Send an image to begin!",
        { parse_mode: "Markdown" },
      );
    });

    // Handle logs command — sends only TODAY's log lines (use /fulllogs for everything)
    this.bot.command("logs", async (ctx) => {
      try {
        const logPath = path.resolve(process.cwd(), "logs/combined.log");
        if (!fs.existsSync(logPath)) {
          await ctx.reply("❌ Log file not found on the server.");
          return;
        }

        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const todayLines = fs
          .readFileSync(logPath, "utf8")
          .split("\n")
          .filter((line) => line.includes(`"timestamp":"${today}`));

        if (todayLines.length === 0) {
          await ctx.reply(`ℹ️ No log entries for today (${today}) yet. Use /fulllogs for the complete log.`);
          return;
        }

        const todayLogPath = path.join(config.paths.tempDir, `logs-${today}.log`);
        fs.mkdirSync(config.paths.tempDir, { recursive: true });
        fs.writeFileSync(todayLogPath, todayLines.join("\n"));

        await ctx.replyWithDocument({
          source: fs.createReadStream(todayLogPath),
          filename: `prod-logs-${today}.log`
        }, { caption: `Production logs for ${today} (${todayLines.length} entries). Use /fulllogs for the complete log.` });

        try { fs.unlinkSync(todayLogPath); } catch {}
      } catch (err) {
        await ctx.reply(`❌ Failed to retrieve logs: ${err instanceof Error ? err.message : err}`);
      }
    });

    // Handle fulllogs command — sends the entire combined log file
    this.bot.command("fulllogs", async (ctx) => {
      try {
        const logPath = path.resolve(process.cwd(), "logs/combined.log");
        if (fs.existsSync(logPath)) {
          await ctx.replyWithDocument({
            source: fs.createReadStream(logPath),
            filename: "prod-combined.log"
          }, { caption: "Here are the complete production logs." });
        } else {
          await ctx.reply("❌ Log file not found on the server.");
        }
      } catch (err) {
        await ctx.reply(`❌ Failed to retrieve logs: ${err instanceof Error ? err.message : err}`);
      }
    });

    // Handle manual approval override command
    this.bot.command("approve", async (ctx) => {
      try {
        const messageText = ctx.message.text.trim();
        const parts = messageText.split(/\s+/);

        if (parts.length < 2) {
          await ctx.reply(
            "⚠️ Please specify a generation ID:\n`/approve [ID]`",
            { parse_mode: "Markdown" },
          );
          return;
        }

        const genId = parts[1];

        if (this.approvalTrigger) {
          await this.approvalTrigger(genId);
        } else {
          await ctx.reply(
            "❌ Manual approval trigger is not registered in the orchestrator.",
          );
        }
      } catch (err) {
        pipelineLogger.error("Error handling approve command", err, "Telegram");
        await ctx.reply(
          `❌ Approval failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    });

    // Handle status command
    this.bot.command("status", async (ctx) => {
      const msg = await ctx.reply("⏳ Checking API Statuses...");
      
      let freellmStatus = "🔴 Offline";
      let ytStatus = "🔴 Offline";
      let igStatus = "🔴 Offline";

      // Check FreeLLMAPI
      if (config.ai.freellmapiKey) {
        try {
          const res = await fetch(`${config.ai.freellmapiUrl.replace(/\/$/, "")}/v1/models`, {
            headers: { "Authorization": `Bearer ${config.ai.freellmapiKey}` }
          });
          freellmStatus = res.ok ? "🟢 Online" : `🔴 Error ${res.status}`;
        } catch(e) { freellmStatus = "🔴 Network Error"; }
      } else { freellmStatus = "⚪️ Not Configured"; }

      // Check YouTube (for this bot's channel profile)
      const ytConf = this.profile.youtube;
      if (ytConf.clientId && ytConf.channels.length > 0) {
        try {
          const { google } = require("googleapis");
          const oauth2 = new google.auth.OAuth2(ytConf.clientId, ytConf.clientSecret, ytConf.redirectUri);
          oauth2.setCredentials({ refresh_token: ytConf.channels[0].refreshToken });
          const yt = google.youtube({ version: "v3", auth: oauth2 });
          const res = await yt.channels.list({ part: ["snippet"], mine: true });
          if (res.data.items && res.data.items.length > 0) {
            ytStatus = `🟢 Online (${res.data.items[0].snippet?.title})`;
          } else {
            ytStatus = "🔴 Auth Failed";
          }
        } catch(e) { ytStatus = "🔴 OAuth Error"; }
      } else { ytStatus = "⚪️ Not Configured"; }

      // Check Instagram (for this bot's channel profile)
      if (this.profile.instagram.accounts.length > 0) {
        const acc = this.profile.instagram.accounts[0];
        if (acc.accessToken && acc.igUserId) {
          try {
            const res = await fetch(`https://graph.facebook.com/v21.0/${acc.igUserId}?fields=username&access_token=${acc.accessToken}`);
            const data = await res.json() as any;
            igStatus = res.ok ? `🟢 Online (@${data.username})` : `🔴 API Error`;
          } catch(e) { igStatus = "🔴 Network Error"; }
        } else { igStatus = "⚪️ Incomplete Config"; }
      } else { igStatus = "⚪️ Not Configured"; }

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        undefined,
        `📊 *API Status Report*\n\n` +
        `*FreeLLMAPI:* ${freellmStatus}\n` +
        `*YouTube API:* ${ytStatus}\n` +
        `*Instagram API:* ${igStatus}\n`,
        { parse_mode: "Markdown" }
      );
    });

    // Handle photos
    this.bot.on("photo", async (ctx) => {
      try {
        const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Get highest resolution photo
        const fileId = photo.file_id;

        await this.initiatePipeline(
          fileId,
          ctx.message.message_id,
          ctx.chat.id,
          ctx.from.id,
          "image.jpg",
          ctx.from.username,
          ctx.from.first_name,
          ctx.message.caption,
        );
      } catch (err) {
        pipelineLogger.error(
          "Error handling Telegram photo message",
          err,
          "Telegram",
        );
        ctx.reply(
          "❌ An error occurred while initializing the image pipeline.",
        );
      }
    });

    // Handle document attachments (e.g. uncompressed images or audio files)
    this.bot.on("document", async (ctx) => {
      try {
        const doc = ctx.message.document;
        const mimeType = doc.mime_type || "";

        if (
          mimeType.startsWith("image/") ||
          doc.file_name?.match(/\.(png|jpe?g)$/i)
        ) {
          await this.initiatePipeline(
            doc.file_id,
            ctx.message.message_id,
            ctx.chat.id,
            ctx.from.id,
            doc.file_name || "image.jpg",
            ctx.from.username,
            ctx.from.first_name,
            ctx.message.caption,
          );
        } else if (
          mimeType.startsWith("audio/") ||
          doc.file_name?.match(/\.(mp3|wav|m4a|aac|ogg)$/i)
        ) {
          await this.handleIncomingAudio(ctx, doc.file_id, doc.file_name || "audio.mp3");
        } else {
          ctx.reply("⚠️ Please send only image files (PNG, JPG, JPEG) or audio files (MP3, WAV, M4A, AAC, OGG).");
        }
      } catch (err) {
        pipelineLogger.error(
          "Error handling Telegram document message",
          err,
          "Telegram",
        );
        ctx.reply(
          "❌ An error occurred while processing the document.",
        );
      }
    });

    // Handle audio files sent directly as audio
    this.bot.on("audio", async (ctx) => {
      try {
        const audio = ctx.message.audio;
        await this.handleIncomingAudio(ctx, audio.file_id, audio.file_name || "audio.mp3");
      } catch (err) {
        pipelineLogger.error("Error handling Telegram audio message", err, "Telegram");
        ctx.reply("❌ An error occurred while processing the audio.");
      }
    });

    // Handle voice notes
    this.bot.on("voice", async (ctx) => {
      try {
        const voice = ctx.message.voice;
        await this.handleIncomingAudio(ctx, voice.file_id, "voice.ogg");
      } catch (err) {
        pipelineLogger.error("Error handling Telegram voice message", err, "Telegram");
        ctx.reply("❌ An error occurred while processing the voice note.");
      }
    });

    // Handle video messages directly uploaded from Telegram
    this.bot.on("video", async (ctx) => {
      try {
        const video = ctx.message.video;
        const fileId = video.file_id;

        await this.initiateVideoPipeline(
          fileId,
          ctx.message.message_id,
          ctx.chat.id,
          ctx.from.id,
          video.file_name || "video.mp4",
          ctx.from.username,
          ctx.from.first_name,
          ctx.message.caption,
        );
      } catch (err) {
        pipelineLogger.error(
          "Error handling Telegram video message",
          err,
          "Telegram",
        );
        ctx.reply(
          "❌ An error occurred while initializing the video pipeline.",
        );
      }
    });

    // Handle review inline button callbacks
    this.bot.action(/^rv_(pub|can|reg|vrl|togv|mus)_(.+)$/, async (ctx) => {
      const code = ctx.match[1];
      const id = ctx.match[2];
      const actionMap: Record<
        string,
        "publish" | "cancel" | "regenerate" | "viral" | "toggle_voiceover" | "replace_music"
      > = {
        pub: "publish",
        can: "cancel",
        reg: "regenerate",
        vrl: "viral",
        togv: "toggle_voiceover",
        mus: "replace_music",
      };
      const action = actionMap[code];
      const ackMap = {
        publish: "🚀 Publishing…",
        cancel: "❌ Cancelled",
        regenerate: "🔄 Regenerating…",
        viral: "🎯 Making it viral…",
        toggle_voiceover: "🔊 Toggling Voiceover…",
        replace_music: "🎵 Send your audio file now…",
      };
      try {
        await ctx.answerCbQuery(ackMap[action]);
      } catch (err) {
        pipelineLogger.warn(
          `Failed to answer callback query: ${err instanceof Error ? err.message : err}`,
          "Telegram",
        );
      }
      if (this.reviewCallback) this.reviewCallback(action, id);
    });

    // Handle revoke inline button callbacks
    this.bot.action(/^rvk_(.+)$/, async (ctx) => {
      const id = ctx.match[1];
      try {
        await ctx.answerCbQuery("🗑️ Revoking upload…");
      } catch (err) {
        pipelineLogger.warn(
          `Failed to answer callback query: ${err instanceof Error ? err.message : err}`,
          "Telegram",
        );
      }
      if (this.revokeCallback) {
        await this.revokeCallback(id);
      }
    });

    // Handle pre-processing settings review inline button callbacks
    this.bot.action(/^st_([a-z]+\d*)_(.+)$/, async (ctx) => {
      const code = ctx.match[1];
      const id = ctx.match[2];
      const ack =
        code === "go"
          ? "▶️ Processing…"
          : code === "can"
            ? "❌ Cancelled"
            : "✔️ Updated";
      try {
        await ctx.answerCbQuery(ack);
      } catch (err) {
        pipelineLogger.warn(
          `Failed to answer callback query: ${err instanceof Error ? err.message : err}`,
          "Telegram",
        );
      }
      if (this.settingsReviewCallback) this.settingsReviewCallback(code, id);
    });

    // Handle text messages — detect Instagram reel links
    this.bot.on("text", async (ctx) => {
      try {
        const text = ctx.message.text || "";

        if (text.startsWith("/")) {
          return; // Ignore command messages
        }

        const isReel = isInstagramReelUrl(text);
        const isTikTok = isTikTokUrl(text);
        const isSocialVideo = isReel || isTikTok;

        // 1. Check if this is an interactive text prompt for a pending review (only if it's not a new Reel/TikTok link)
        if (!isSocialVideo && this.textPromptCallback) {
          const handled = await this.textPromptCallback(
            ctx.chat.id,
            text,
            ctx.message.message_id,
          );
          if (handled) {
            return; // Successfully intercepted and handled
          }
        }

        // 2. Fallback to Social Video Url detection
        if (!isSocialVideo) {
          // Not a supported link — ignore (or give a hint)
          ctx.reply(
            "📸 Send a screenshot image, an Instagram reel link, or a TikTok link to start the pipeline.",
          );
          return;
        }

        const videoUrl = isReel ? extractInstagramUrl(text)! : extractTikTokUrl(text)!;
        const platformName = isReel ? "Instagram reel" : "TikTok video";
        const messageId = ctx.message.message_id;
        const chatId = ctx.chat.id;

        const id = `gen-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const tempGenDir = path.join(config.paths.tempDir, id);
        fs.mkdirSync(tempGenDir, { recursive: true });

        await this.sendMessage(
          chatId,
          `🎬 *${platformName} detected!*\n\`${videoUrl}\`\n\nDownloading & extracting frame...\n\`ID: ${id}\``,
          messageId,
        );

        pipelineLogger.info(
          `${platformName} received: ${videoUrl} → Gen ID: ${id}`,
          "Telegram",
        );

        // Detach from the Telegraf handler immediately — yt-dlp can take 2+ minutes
        // and Telegraf has a 90s timeout that crashes the process if we await here.
        this.processInstagramReel(
          videoUrl,
          tempGenDir,
          id,
          chatId,
          messageId,
          ctx.from,
        ).catch((err) => {
          pipelineLogger.error(
            `Instagram reel processing failed for ${id}`,
            err,
            "Instagram",
          );
        });
      } catch (err) {
        pipelineLogger.error(
          "Error handling Instagram reel link",
          err,
          "Telegram",
        );
        ctx.reply("❌ An error occurred processing the Instagram link.");
      }
    });
  }

  private async processInstagramReel(
    reelUrl: string,
    tempGenDir: string,
    id: string,
    chatId: number,
    messageId: number,
    from: { id: number; username?: string; first_name?: string },
  ): Promise<void> {
    let framePath: string;
    let instagramSourceType: "image" | "image_with_music" | "video";
    let videoPath: string | undefined;
    let sourceCaptionText: string | undefined;
    try {
      const result = await downloadReelFrame(reelUrl, tempGenDir);
      framePath = result.framePath;
      instagramSourceType = result.instagramSourceType;
      videoPath = result.videoPath;
      sourceCaptionText =
        result.sourceCaption?.description || result.sourceCaption?.title;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pipelineLogger.error("Instagram download failed", err, "Instagram");
      await this.sendMessage(
        chatId,
        `❌ *Failed to download video*\n\`${msg.slice(0, 300)}\`\n\nMake sure the reel/video is public. (For Instagram, you must be logged into Chrome).`,
        messageId,
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
      originalVideoPath: videoPath,
      isVideo: instagramSourceType === "video",
      status: "received",
      instagramSource: true,
      instagramSourceType,
      assetKind: AssetKind.Reel,
      captionMetadata: this.parseCaptionMetadata(sourceCaptionText),
    };

    let contentTypeDesc = "";
    if (instagramSourceType === "image") {
      contentTypeDesc = "📸 *Image/Carousel* (screenshotted)";
    } else if (instagramSourceType === "image_with_music") {
      contentTypeDesc = "🎵 *Static Reel* (image with music)";
    } else {
      contentTypeDesc = "🎬 *Dynamic Video* (real video)";
    }

    const captionPreview = sourceCaptionText
      ? `captured ✅\n\`${sourceCaptionText.slice(0, 200).replace(/`/g, "'")}${sourceCaptionText.length > 200 ? "…" : ""}\``
      : "not found";
    await this.sendMessage(
      chatId,
      `✅ *Download complete!*\n` +
        `• *Type:* ${contentTypeDesc}\n` +
        `• *Frame Path:* \`${path.basename(framePath)}\`\n` +
        `• *Original Caption:* ${captionPreview}\n\n` +
        `Starting automation pipeline...`,
      messageId,
    );

    pipelineLogger.checkpoint(
      `Instagram frame ready (${instagramSourceType}) — starting pipeline`,
      true,
      framePath,
    );

    if (this.pipelineTrigger) {
      this.pipelineTrigger(context).catch((err) => {
        pipelineLogger.error(
          `Pipeline failed for Instagram reel ${id}`,
          err,
          "Orchestrator",
        );
      });
    }
  }

  private parseCaptionMetadata(
    caption?: string,
  ): { title: string; description: string } | undefined {
    if (!caption || caption.trim().length === 0) return undefined;
    const lines = caption
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const title = lines[0].slice(0, 100);
    const description = lines.slice(1).join("\n").trim() || lines[0];
    return { title, description };
  }

  private async handleIncomingAudio(ctx: any, fileId: string, fileName: string): Promise<void> {
    try {
      if (this.audioUploadCallback) {
        const handled = await this.audioUploadCallback(
          ctx.chat.id,
          fileId,
          fileName,
          ctx.message.message_id
        );
        if (handled) return;
      }
      ctx.reply("🎵 Audio file received, but no active video is currently awaiting a music change.");
    } catch (err) {
      pipelineLogger.error("Error handling incoming audio", err, "Telegram");
      ctx.reply("❌ Failed to process the audio file.");
    }
  }

  private async initiatePipeline(
    fileId: string,
    messageId: number,
    chatId: number,
    userId: number,
    originalFileName: string,
    username?: string,
    firstName?: string,
    caption?: string,
  ): Promise<void> {
    const id = `gen-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const tempGenDir = path.join(config.paths.tempDir, id);

    // Create generation temp directory
    fs.mkdirSync(tempGenDir, { recursive: true });

    const ext = path.extname(originalFileName) || ".jpg";
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
      isTelegram: true,
      status: "received",
      captionMetadata,
      assetKind: AssetKind.MemeImage,
    };

    pipelineLogger.info(
      `Telegram received image. Assigned Gen ID: ${id}`,
      "Telegram",
    );
    pipelineLogger.checkpoint("Telegram image received", true, id);

    await this.sendMessage(
      chatId,
      `📥 *Image received!* starting automation pipeline...\n\`ID: ${id}\``,
      messageId,
    );

    // Download the image
    try {
      await this.downloadFile(fileId, originalImagePath);
      pipelineLogger.checkpoint(
        "Image downloaded",
        true,
        `Saved to ${originalImagePath}`,
      );
    } catch (err) {
      pipelineLogger.error(
        `Failed to download image for ${id}`,
        err,
        "Telegram",
      );
      await this.sendMessage(
        chatId,
        `❌ Failed to download image from Telegram.`,
        messageId,
      );
      return;
    }

    // Trigger pipeline orchestrator asynchronously
    if (this.pipelineTrigger) {
      this.pipelineTrigger(context).catch((err) => {
        pipelineLogger.error(
          `Pipeline orchestrator failed for Gen ID ${id}`,
          err,
          "Orchestrator",
        );
      });
    } else {
      pipelineLogger.warn(
        `No pipeline trigger registered. Image downloaded but not processed.`,
        "Telegram",
      );
      await this.sendMessage(
        chatId,
        `⚠️ Pipeline orchestrator not loaded.`,
        messageId,
      );
    }
  }

  private async initiateVideoPipeline(
    fileId: string,
    messageId: number,
    chatId: number,
    userId: number,
    originalFileName: string,
    username?: string,
    firstName?: string,
    caption?: string,
  ): Promise<void> {
    const id = `gen-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const tempGenDir = path.join(config.paths.tempDir, id);

    // Create generation temp directory
    fs.mkdirSync(tempGenDir, { recursive: true });

    const ext = path.extname(originalFileName) || ".mp4";
    const originalVideoPath = path.join(tempGenDir, `original${ext}`);
    const originalImagePath = path.join(tempGenDir, `original.jpg`); // for extracted frame

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
      originalVideoPath,
      isVideo: true,
      isTelegram: true,
      status: "received",
      captionMetadata,
      assetKind: AssetKind.MemeVideo,
    };

    pipelineLogger.info(
      `Telegram received video. Assigned Gen ID: ${id}`,
      "Telegram",
    );
    pipelineLogger.checkpoint("Telegram video received", true, id);

    await this.sendMessage(
      chatId,
      `📥 *Video received!* starting automation pipeline...\n\`ID: ${id}\``,
      messageId,
    );

    // Download the video
    try {
      await this.downloadFile(fileId, originalVideoPath);
      pipelineLogger.checkpoint(
        "Video downloaded",
        true,
        `Saved to ${originalVideoPath}`,
      );
    } catch (err) {
      pipelineLogger.error(
        `Failed to download video for ${id}`,
        err,
        "Telegram",
      );
      await this.sendMessage(
        chatId,
        `❌ Failed to download video from Telegram.`,
        messageId,
      );
      return;
    }

    // Trigger pipeline orchestrator asynchronously
    if (this.pipelineTrigger) {
      this.pipelineTrigger(context).catch((err) => {
        pipelineLogger.error(
          `Pipeline orchestrator failed for Gen ID ${id}`,
          err,
          "Orchestrator",
        );
      });
    } else {
      pipelineLogger.warn(
        `No pipeline trigger registered. Video downloaded but not processed.`,
        "Telegram",
      );
      await this.sendMessage(
        chatId,
        `⚠️ Pipeline orchestrator not loaded.`,
        messageId,
      );
    }
  }
}
