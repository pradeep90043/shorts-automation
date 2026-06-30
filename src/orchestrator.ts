import path from "path";
import fs from "fs";
import {
  PipelineContext,
  ITelegramService,
  IImageAnalyzer,
  IBrandingDetector,
  IBrandingRemover,
  IOcrService,
  ILayoutGenerator,
  IBrandingService,
  IAiService,
  IVideoRenderer,
  IMusicService,
  IYouTubeService,
} from "./types";
import { ImageAnalyzer } from "./image-analysis";
import { BrandingDetector } from "./branding-detector";
import { BrandingRemover } from "./branding-remover";
import { OcrService } from "./ocr";
import { LayoutGenerator } from "./layout";
import { BrandingService } from "./branding";
import { AIRenderer } from "./ai-renderer";
import { AiService } from "./ai";
import { VideoRenderer } from "./renderer";
import { MusicService } from "./music";
import { YouTubeService } from "./youtube";
import { config } from "./config";
import { pipelineLogger } from "./utils/logger";

export class PipelineOrchestrator {
  private telegramService: ITelegramService;
  private analyzer: IImageAnalyzer;
  private detector: IBrandingDetector;
  private remover: IBrandingRemover;
  private ocr: IOcrService;
  private layout: ILayoutGenerator;
  private branding: IBrandingService;
  private aiRenderer: AIRenderer;
  private ai: IAiService;
  private renderer: IVideoRenderer;
  private music: IMusicService;
  private youtube: IYouTubeService;

  constructor(telegramService: ITelegramService) {
    this.telegramService = telegramService;
    this.analyzer = new ImageAnalyzer();
    this.detector = new BrandingDetector();
    this.remover = new BrandingRemover();
    this.ocr = new OcrService();
    this.layout = new LayoutGenerator();
    this.branding = new BrandingService();
    this.aiRenderer = new AIRenderer();
    this.ai = new AiService();
    this.renderer = new VideoRenderer();
    this.music = new MusicService();
    this.youtube = new YouTubeService();
  }

  /**
   * Resumes a pipeline execution from a saved context (e.g. after manual approval)
   */
  public async resumePipeline(context: PipelineContext): Promise<void> {
    pipelineLogger.info(
      `Resuming pipeline ${context.id} from manual review override.`,
      "Orchestrator",
    );
    await this.telegramService.sendMessage(
      context.telegramMeta.chatId,
      `✅ *Manual review approved!* Resuming pipeline from layout generation...`,
      context.telegramMeta.messageId,
    );

    // Mark as approved and bypass branding removal failure
    context.status = "generating_layout";
    if (!context.brandingRemoval) {
      context.brandingRemoval = {
        success: true,
        methodUsed: "none",
        outputPath: context.originalImagePath,
        preservationReason: "Manual approval override",
      };
    } else {
      context.brandingRemoval.success = true;
    }

    context.cleanedImagePath = context.originalImagePath;

    await this.runFromStage(context, "ocr");
  }

  /**
   * Main entry point to run a newly received image pipeline
   */
  public async run(context: PipelineContext): Promise<void> {
    const chatId = context.telegramMeta.chatId;
    const messageId = context.telegramMeta.messageId;

    try {
      // 1. Analyze Image
      context.status = "analyzing";
      context.analysis = await this.analyzer.analyze(context.originalImagePath);
      pipelineLogger.checkpoint(
        "Image analyzed",
        true,
        `${context.analysis.width}x${context.analysis.height}`,
      );

      // Instagram-sourced frames skip branding detection/removal entirely.
      // The frame is a raw screenshot of the post — no watermarks to clean up.
      if (context.instagramSource) {
        pipelineLogger.info(
          "Instagram source detected — skipping branding detection & removal",
          "Orchestrator",
        );
        context.cleanedImagePath = context.originalImagePath;
        await this.runFromStage(context, "ocr");
        return;
      }

      // 2. Detect Branding
      context.status = "detecting_branding";
      context.brandingDetection = await this.detector.detect(
        context.originalImagePath,
        context.analysis,
      );
      pipelineLogger.checkpoint(
        "Branding detection completed",
        true,
        `Zones: ${context.brandingDetection.zones.length}`,
      );

      // 3. Remove Branding
      context.status = "removing_branding";
      const removalResult = await this.remover.remove(
        context.originalImagePath,
        context.brandingDetection.zones,
        context.analysis,
      );

      context.brandingRemoval = removalResult;
      context.cleanedImagePath = removalResult.outputPath;

      // Handle cases where clean branding removal cannot be completed
      if (!removalResult.success) {
        context.status = "manual_review";
        pipelineLogger.checkpoint(
          "Branding removal bypassed",
          false,
          removalResult.preservationReason,
        );

        // Save the context state so it can be resumed
        this.saveContextState(context);

        await this.telegramService.sendMessage(
          chatId,
          `⚠️ *Branding Removal Alert:*\n` +
            `Automated branding removal bypassed to prevent artifacts:\n` +
            `_${removalResult.preservationReason}_\n\n` +
            `The pipeline has been held for *manual review*.\n` +
            `To proceed using the original image, reply with:\n` +
            `/approve ${context.id}`,
          messageId,
        );
        return;
      }

      await this.runFromStage(context, "ocr");
    } catch (err) {
      await this.handlePipelineFailure(context, err);
    }
  }

  /**
   * Runs the remaining pipeline stages starting from a specified status
   */
  private async runFromStage(
    context: PipelineContext,
    startStage: "ocr" | "generating_layout",
  ): Promise<void> {
    const chatId = context.telegramMeta.chatId;
    const messageId = context.telegramMeta.messageId;
    const workingImage = context.cleanedImagePath || context.originalImagePath;

    try {
      // 4. OCR
      if (startStage === "ocr") {
        context.status = "ocr";
        context.ocr = await this.ocr.extractText(workingImage);
      }

      // 5 & 6. Generate branded frame — AI renderer or classic SVG pipeline
      const aiProvider = config.ai.provider || "mock";
      const useAI =
        aiProvider === "claude" ||
        aiProvider === "antigravity" ||
        aiProvider === "freellmapi";

      if (useAI) {
        context.status = "generating_layout";
        const layoutPath = path.join(context.tempDir, "layout.png");
        const provider =
          aiProvider === "antigravity"
            ? "antigravity"
            : aiProvider === "freellmapi"
              ? "freellmapi"
              : "claude";
        context.layoutImagePath = await this.aiRenderer.generateBrandedFrame(
          workingImage,
          layoutPath,
          provider,
          context.ocr?.text,
        );

        context.status = "branding";
        const brandedPath = path.join(context.tempDir, "branded.png");
        context.brandedImagePath = await this.branding.applyCodeOrCapBranding(
          context.layoutImagePath,
          brandedPath,
        );
      } else {
        // Classic SVG + Sharp pipeline
        context.status = "generating_layout";
        const layoutPath = path.join(context.tempDir, "layout.png");
        context.layoutImagePath = await this.layout.generate(
          workingImage,
          context.analysis!,
          layoutPath,
          context.ocr?.text,
        );

        context.status = "branding";
        const brandedPath = path.join(context.tempDir, "branded.png");
        context.brandedImagePath = await this.branding.applyCodeOrCapBranding(
          context.layoutImagePath,
          brandedPath,
        );
      }

      // 7. Generate Metadata
      context.status = "generating_metadata";
      const imageCtx = `Screenshot dimensions: ${context.analysis?.width}x${context.analysis?.height}. Orientation: ${context.analysis?.orientation}`;
      context.metadata = await this.ai.generateMetadata(
        context.ocr?.text || "",
        imageCtx,
      );

      // 8. Render Video
      context.status = "rendering_video";
      const rawVideoPath = path.join(context.tempDir, "video_no_audio.mp4");
      context.renderedVideoPath = await this.renderer.renderImageToVideo(
        context.brandedImagePath,
        rawVideoPath,
        {
          durationSeconds: config.rendering.videoDurationSeconds,
          fps: config.rendering.fps,
          effect: "zoom", // Applying premium zoom motion
        },
      );

      // 9. Add Music
      context.status = "adding_music";
      const finalVideoName = `${context.id}.mp4`;
      const finalVideoPath = path.join(config.paths.outputDir, finalVideoName);
      context.finalVideoPath = await this.music.addBackgroundMusic(
        context.renderedVideoPath,
        config.paths.musicDir,
        finalVideoPath,
        context.metadata?.mood,
      );

      // 10. Upload to YouTube Shorts
      context.status = "uploading";
      await this.telegramService.sendMessage(
        chatId,
        `🚀 *Rendering completed!* Uploading to YouTube Shorts...`,
        messageId,
      );

      const uploadResult = await this.youtube.uploadShort(
        context.finalVideoPath,
        context.metadata,
      );
      context.youtubeUrl = uploadResult.url;
      context.youtubeVideoId = uploadResult.videoId;

      // 11. Completed
      context.status = "completed";
      pipelineLogger.checkpoint(
        "Short generated and uploaded successfully",
        true,
        `Gen ID: ${context.id}`,
      );

      await this.telegramService.sendMessage(
        chatId,
        `🎉 *Short Uploaded Successfully!*\n\n` +
          `*Title:* ${context.metadata.title}\n` +
          `*YouTube Link:* ${context.youtubeUrl}\n\n` +
          `_Check output file: ${path.basename(context.finalVideoPath)}_`,
        messageId,
      );

      // Clean up heavy temporary video files to free space, keep branded image for debugging if needed
      this.cleanupTempFiles(context);
    } catch (err) {
      await this.handlePipelineFailure(context, err);
    }
  }

  private saveContextState(context: PipelineContext): void {
    try {
      const statePath = path.join(context.tempDir, "context.json");
      fs.writeFileSync(statePath, JSON.stringify(context, null, 2), "utf8");
      pipelineLogger.info(
        `Saved context state to ${statePath}`,
        "Orchestrator",
      );
    } catch (err) {
      pipelineLogger.error("Failed to save context state", err, "Orchestrator");
    }
  }

  public getSavedContext(id: string): PipelineContext | null {
    try {
      const statePath = path.join(config.paths.tempDir, id, "context.json");
      if (fs.existsSync(statePath)) {
        const data = fs.readFileSync(statePath, "utf8");
        return JSON.parse(data) as PipelineContext;
      }
    } catch (err) {
      pipelineLogger.error(
        `Failed to retrieve saved context ${id}`,
        err,
        "Orchestrator",
      );
    }
    return null;
  }

  private cleanupTempFiles(context: PipelineContext): void {
    try {
      // Remove temporary no-audio video to save space
      if (
        context.renderedVideoPath &&
        fs.existsSync(context.renderedVideoPath)
      ) {
        fs.unlinkSync(context.renderedVideoPath);
      }
      // Keep layout and branded PNGs as they are lightweight and useful for visual verification
      pipelineLogger.info(
        `Cleaned up temporary video files for ${context.id}`,
        "Orchestrator",
      );
    } catch (err) {
      pipelineLogger.warn(
        `Failed to clean up temp files: ${err instanceof Error ? err.message : err}`,
        "Orchestrator",
      );
    }
  }

  private async handlePipelineFailure(
    context: PipelineContext,
    error: any,
  ): Promise<void> {
    context.status = "failed";
    const errMsg = error instanceof Error ? error.message : String(error);
    context.error = errMsg;

    pipelineLogger.checkpoint("Pipeline execution failed", false, errMsg);
    this.saveContextState(context);

    await this.telegramService.sendMessage(
      context.telegramMeta.chatId,
      `❌ *Pipeline execution failed!*\n\n` +
        `*Error:* \`${errMsg}\`\n\n` +
        `Check logs for details. Gen ID: \`${context.id}\``,
      context.telegramMeta.messageId,
    );
  }
}
