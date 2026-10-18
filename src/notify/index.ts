import { normalizeCreatorHandle } from "../utils/creatorCredit";
import fs from "fs";
import path from "path";
import { config, ChannelProfile } from "../config";
import { INotifyService, PipelineContext, SourceMetadata, AssetKind, ReviewSettings } from "../types";
import { pipelineLogger } from "../utils/logger";
import { JobDatabase } from "../utils/db";
import { downloadReelFrame } from "../instagram";

export function escapeMarkdown(text: string): string {
  if (!text) return "";
  return text
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[");
}

/** Plain text for the log: the pipeline still words its progress messages with chat-style markup. */
const plain = (text: string): string => text.replace(/[*`]/g, "").replace(/\s+/g, " ").trim();

/**
 * Entry point for reels and the progress feed. The dashboard is the only interface: there is no chat bot, so progress
 * messages go to the log, review happens on the dashboard (final_review), and nothing here talks to the network.
 */
export class NotifyService implements INotifyService {
  public static readonly instances: NotifyService[] = [];
  public readonly profile: ChannelProfile;
  private db: JobDatabase;
  private pipelineTrigger?: (context: PipelineContext) => Promise<void>;
  private nextId = 1;

  constructor(profile: ChannelProfile = config.profiles[0]) {
    if (!profile) throw new Error("No channel profile configured.");
    this.profile = profile;
    this.db = new JobDatabase(profile.key);
    NotifyService.instances.push(this);
  }

  public registerPipelineTrigger(trigger: (context: PipelineContext) => Promise<void>): void {
    this.pipelineTrigger = trigger;
  }

  // The uploader and the watcher register these; with no chat buttons nothing calls them, so they are accepted and ignored.
  public registerApprovalTrigger(_trigger: (genId: string) => Promise<void>): void {}
  public registerReviewCallback(_cb: (action: "publish" | "cancel" | "regenerate" | "viral" | "toggle_voiceover" | "replace_music", id: string) => void): void {}
  public registerRevokeCallback(_cb: (id: string) => Promise<void>): void {}
  public registerTextPromptCallback(_cb: (chatId: number, text: string, messageId: number) => Promise<boolean>): void {}
  public registerAudioUploadCallback(_cb: (chatId: number, fileId: string, fileName: string, messageId: number) => Promise<boolean>): void {}
  public registerSettingsReviewCallback(_cb: (code: string, id: string) => void): void {}
  public registerWatcher(_watcher: { runDailyBatch: (force?: boolean) => Promise<any[]>; forceStart: () => Promise<void>; getStatusDetails?: () => any }): void {}

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}

  public async downloadFile(_fileId: string, _destPath: string): Promise<void> {
    throw new Error("File download from a chat is not available: reels arrive from the watcher or the dashboard.");
  }

  public async sendMessage(_chatId: number, text: string, _replyToMessageId?: number): Promise<void> {
    pipelineLogger.info(`[${this.profile.brandName}] ${plain(text)}`.slice(0, 400), "Notify");
  }

  public async deleteMessage(_chatId: number, _messageId: number): Promise<void> {}
  public async removeInlineButtons(_chatId: number, _messageId: number): Promise<void> {}

  public async sendSuccessMessageWithRevoke(chatId: number, text: string, _id: string, replyToMessageId?: number): Promise<number> {
    await this.sendMessage(chatId, text, replyToMessageId);
    return this.nextId++;
  }

  public async sendSettingsReview(chatId: number, text: string, _id: string, _settings: ReviewSettings, _mood: string, replyToMessageId?: number, _previewImagePath?: string): Promise<number> {
    await this.sendMessage(chatId, text, replyToMessageId);
    return this.nextId++;
  }

  public async updateSettingsReview(_chatId: number, _messageId: number, _text: string, _id: string, _settings: ReviewSettings, _mood: string): Promise<void> {}

  public async sendVideoForReview(chatId: number, _videoPath: string, caption: string, _id: string, replyToMessageId?: number): Promise<number> {
    await this.sendMessage(chatId, caption, replyToMessageId);
    return this.nextId++;
  }

  public async updateReviewCaption(_chatId: number, _messageId: number, _caption: string, _id: string): Promise<void> {}

  public async editReviewVideo(_chatId: number, _messageId: number, _videoPath: string, caption: string, _id: string): Promise<number> {
    pipelineLogger.info(`[${this.profile.brandName}] ${plain(caption)}`.slice(0, 400), "Notify");
    return this.nextId++;
  }

  public async sendRawVideo(_chatId: number, _videoPath: string, caption: string): Promise<number> {
    pipelineLogger.info(`[${this.profile.brandName}] ${plain(caption)}`.slice(0, 400), "Notify");
    return this.nextId++;
  }

  private async processInstagramReel(
    reelUrl: string,
    tempGenDir: string,
    id: string,
    chatId: number,
    messageId: number,
    from: { id: number; username?: string; first_name?: string },
    presetSettings?: ReviewSettings,
    // Ground truth from ChannelWatcher (it already knows exactly which
    // watched account this reel came from) — takes priority over whatever
    // we can scrape off the page ourselves.
    knownCreatorUsername?: string,
  ): Promise<void> {
    let framePath: string;
    let instagramSourceType: "image" | "image_with_music" | "video";
    let videoPath: string | undefined;
    let sourceCaptionText: string | undefined;
    let sourceCreatorUsername: string | undefined;
    try {
      const result = await downloadReelFrame(reelUrl, tempGenDir);
      framePath = result.framePath;
      instagramSourceType = result.instagramSourceType;
      videoPath = result.videoPath;
      sourceCaptionText =
        result.sourceCaption?.description || result.sourceCaption?.title;
      // knownCreatorUsername can be a search keyword (search-engine discovery has no creator);
      // only a verified handle counts, otherwise fall back to what the downloader found.
      sourceCreatorUsername =
        normalizeCreatorHandle(knownCreatorUsername) ||
        normalizeCreatorHandle(result.sourceCaption?.creatorUsername);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pipelineLogger.error("Instagram download failed", err, "Instagram");
      try {
        this.db.createJob(id, {
          status: "failed",
          currentStep: "Download failed",
          error: `Download failed: ${msg}`,
        });
      } catch {}
      await this.sendMessage(
        chatId,
        `❌ *Failed to download video*\n\`${msg.slice(0, 300)}\`\n\nMake sure the reel/video is public. (For Instagram, you must be logged into Chrome).`,
        messageId,
      );
      return;
    }

    const sourceMeta: SourceMetadata = {
      messageId,
      chatId,
      userId: from.id,
      username: from.username,
      firstName: from.first_name,
      timestamp: Math.floor(Date.now() / 1000),
      fileId: reelUrl,
    };

    const shortcodeMatch = reelUrl.match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
    const shortcode = shortcodeMatch ? shortcodeMatch[1] : undefined;

    const context: PipelineContext = {
      id,
      tempDir: tempGenDir,
      sourceMeta,
      originalImagePath: framePath,
      originalVideoPath: videoPath,
      isVideo: instagramSourceType === "video",
      status: "received",
      instagramSource: true,
      instagramSourceType,
      assetKind: AssetKind.Reel,
      captionMetadata: this.parseCaptionMetadata(sourceCaptionText),
      sourceCreatorUsername,
      // "manual_inject" marks a dashboard injection (waits for publish approval); keep it explicit
      // since sourceCreatorUsername now only ever holds a verified handle.
      channel: knownCreatorUsername === "manual_inject" ? "manual_inject" : sourceCreatorUsername,
      shortcode,
      channelPinned: true,
      channelProfileKey: this.profile.key,
    };

    if (presetSettings) {
      // Test/automation shortcut: skip the interactive settings-review gate
      // entirely — the caller has already decided the final settings.
      context.reviewSettings = presetSettings;
      context.settingsReviewDone = true;
    }

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
        const msg = err instanceof Error ? err.message : String(err);
        try {
          this.db.updateJob(id, {
            status: "failed",
            currentStep: "Pipeline failed",
            error: msg,
          });
        } catch {}
        pipelineLogger.error(
          `Pipeline failed for Instagram reel ${id}`,
          err,
          "Orchestrator",
        );
      });
    }
  }

  /** The settings a watcher reel is made with. */
  private presetSettings(): ReviewSettings {
    const keepOriginal = ["prompt_gag", "infoonspot"].includes(this.profile.key.toLowerCase());
    return {
      voiceover: !keepOriginal,
      originalAudio: keepOriginal,
      captions: !keepOriginal,
      cropTopPct: undefined,
      cropBottomPct: undefined,
      sticker: true,
    };
  }

  private startReel(
    reelUrl: string,
    chatId: number,
    anchorMessageId: number,
    from: { id: number; username?: string; first_name?: string },
    knownCreatorUsername: string | undefined,
    announce: (id: string) => string,
    failLabel: string,
    preset?: ReviewSettings,
  ): string {
    const id = `gen-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const tempGenDir = path.join(config.paths.tempDir, id);
    fs.mkdirSync(tempGenDir, { recursive: true });

    this.sendMessage(chatId, announce(id), anchorMessageId).catch(() => {});

    this.processInstagramReel(reelUrl, tempGenDir, id, chatId, anchorMessageId, from, preset, knownCreatorUsername).catch((err) => {
      pipelineLogger.error(`${failLabel} pipeline failed for ${id}`, err, "Notify");
      try {
        this.db.updateJob(id, { status: "failed", currentStep: failLabel + " failed", error: err instanceof Error ? err.message : String(err) });
      } catch {}
    });

    return id;
  }

  /** A watcher reel: voiceover, music, captions and sticker as the channel preset says. */
  public runPresetReel(
    reelUrl: string,
    chatId: number,
    anchorMessageId: number,
    from: { id: number; username?: string; first_name?: string } = { id: 0 },
    knownCreatorUsername?: string,
  ): string {
    return this.startReel(reelUrl, chatId, anchorMessageId, from, knownCreatorUsername, () => "Reel received, downloading...", "Reel", this.presetSettings());
  }

  /** A dashboard inject: the AI-recommended settings (plus the channel overrides), and the run stops at final_review for the dashboard publish. */
  public runInteractiveReel(
    reelUrl: string,
    chatId: number,
    anchorMessageId: number,
    from: { id: number; username?: string; first_name?: string } = { id: 0 },
    knownCreatorUsername?: string,
  ): string {
    return this.startReel(reelUrl, chatId, anchorMessageId, from, knownCreatorUsername, (id) => `Injected reel, downloading... (${id})`, "Ingest");  // no preset: the AI-recommended settings apply
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
}
