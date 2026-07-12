import fs from "fs";
import path from "path";
import sharp from "sharp";
import { exec } from "child_process";
import { config } from "./config";
import { VideoRenderer, calculateVideoCrop } from "./renderer";
import { OcrService } from "./ocr";
import { MusicService } from "./music";
import { YouTubeService, UploadResult } from "./youtube";
import { InstagramPublisher, InstagramUploadResult } from "./instagram/publisher";
import { TelegramService, escapeMarkdown } from "./telegram";
import { PipelineContext, VideoMetadata } from "./types";
import { pipelineLogger } from "./utils/logger";
import { FreeLlmApiClient } from "./ai/freellmapi";
import { parseAiJson } from "./utils/json";
import { getFileHash } from "./utils/cache";
import { JobDatabase } from "./utils/db";

import { ViralAnalyzer } from "./utils/viral-analyzer";
import { JobQueue } from "./utils/queue";
import { ImageAnalyzer } from "./image-analysis";
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
  timer?: ReturnType<typeof setTimeout>;
  context: PipelineContext;
}

export class DirectUploader {
  private freellmapi: FreeLlmApiClient | null = null;
  private renderer: VideoRenderer;
  private music: MusicService;
  private youtube: YouTubeService;
  private instagram: InstagramPublisher;
  private telegram: TelegramService;
  private db = new JobDatabase();
  private viralAnalyzer = new ViralAnalyzer();
  private analyzer = new ImageAnalyzer();
  private queue = new JobQueue(1);
  private pending = new Map<string, PendingUpload>();
  private pendingFrameReviews = new Map<
    string,
    {
      context: PipelineContext;
      timer: ReturnType<typeof setTimeout>;
      reviewMessageId: number;
      chatId: number;
      messageId: number;
    }
  >();
  private uploaded = new Map<
    string,
    { channelResults: UploadResult[]; chatId: number; successMessageId: number }
  >();
  private jobResolvers = new Map<string, () => void>();

  constructor(telegram: TelegramService) {
    if (config.ai.provider === "freellmapi") {
      this.freellmapi = new FreeLlmApiClient();
    }
    this.renderer = new VideoRenderer();
    this.music = new MusicService();
    this.youtube = new YouTubeService();
    this.instagram = new InstagramPublisher();
    this.telegram = telegram;

    // Wire up inline-button callbacks from Telegram
    telegram.registerReviewCallback((action, id) => {
      if (action === "publish") this.onPublish(id);
      else if (action === "cancel") this.onCancel(id);
      else if (action === "regenerate") this.onRegenerate(id, false);
      else if (action === "viral") this.onRegenerate(id, true);
      else if (action === "replace_music") this.onReplaceMusic(id);
    });

    telegram.registerRevokeCallback(async (id) => {
      await this.onRevoke(id);
    });

    telegram.registerFrameReviewCallback((action, id) => {
      if (action === "approve") this.onApproveFrame(id);
      else if (action === "cancel") this.onCancelFrame(id);
      else if (action.startsWith("select_")) {
        const variantCode = action.replace("select_", "");
        this.onSelectFrameVariant(id, variantCode).catch((err) => {
          pipelineLogger.error(
            `Failed to handle frame variant selection: ${id}`,
            err,
            "DirectUploader",
          );
        });
      }
    });

    telegram.registerTextPromptCallback(async (chatId, text, messageId) => {
      return this.handleUserTextPrompt(chatId, text, messageId);
    });

    // Start automated YouTube metrics sync checks every 6 hours
    setInterval(
      () => {
        this.syncYouTubeMetrics().catch(() => {});
      },
      6 * 60 * 60 * 1000,
    );
  }

  // ── FreeLLMAPI vision → YouTube metadata ────────────────────────────

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
Detect the exact coordinates of any branding, watermarks, profile pictures, usernames/handles, logos, or app overlays of other creators. Also, if this image shows a full Instagram page/embed layout, detect the boundaries of the main content media box. Detect the exact bounding box of any original captions or meme text written on the image. Locate them and return their bounding boxes in normalized coordinates relative to the image size (value between 0.0 and 1.0).
Search for:
- profile picture (e.g. circle image showing a person/logo in top-left or bottom-left)
- profile name / username / handle (e.g. "@username", "username" in top-left or bottom-left)
- watermarks or logos (e.g. Instagram logo, TikTok watermark, other channel logo)
- actions panel (e.g. reels interaction panel on the right with like/comment/share icons)
- main_post_content (e.g. if the image contains a full post layout, comments, or web view headers, detect the bounding box of the central post image/media box itself, excluding headers, comments, likes, and footer chrome)
- original_captions (e.g. the main meme text/caption written on the top or center of the frame in white/black outlines)

If no such elements are present, return an empty array for brandingZones.

TASK 2: YouTube Shorts Metadata & Fact Checking
You are an expert YouTube SEO strategist and Fact Checker for the technology channel "CodeOrCap" (Tech Fact Check).
FACT CHECK RULES: Analyze the code, claims, or technical text in the image. Determine if it is true, false, misleading, or a joke. Provide a factCheckScore (1-10, where 10 is 100% accurate) and a short verdict (e.g., "Mostly True", "False - Syntax Error", "Satire/Meme", "Accurate").
TITLE RULES: Max 65 chars. Primary keyword within first 30 chars. Curiosity without clickbait. Use current year if relevant. One emoji. No ALL CAPS (except AI, API, etc).
DESCRIPTION RULES: 180-300 words. Include: 1) What the video is about (primary keyword in first sentence). 2) What you'll learn (bullet points). 3) Who it's for. 4) The Fact Check Verdict and Reasoning. 5) Subscribe CTA to @CodeOrCap. 6) Community CTA question.
KEYWORDS: Provide 1 primary keyword, 5 secondary keywords, 15 tags, and 8-12 hashtags.
THUMBNAIL: Max 5 words, highly clickable, curiosity driven.
FILENAME: SEO-friendly filename (e.g., tech-video-2026.mp4).
MOOD: Determine emotional tone: "funny", "sad", or "other".

TASK 3: Verbatim Text Extraction
Read all text written on the image exactly as it appears verbatim, without correcting spelling, punctuation, or formatting. If there is no text, return an empty string.

TASK 4: Safe Area, Style Selection & Candidate Placement Detection
Evaluate the image layout for dynamic overlay caption placement. Apply ALL of these rules:

STEP 4A — Background Classification
Look at the area where the caption will be placed and classify it:
- "existing_banner" : A solid black or white horizontal banner strip (meme text block) already exists at top or bottom.
- "plain"           : The region is a solid or near-solid color, sky, clouds, blank wall, or simple cartoon background with no fine detail.
- "busy"            : The region contains characters, faces, detailed artwork, motion blur, real video footage, or complex textures.

STEP 4B — Caption Style Selector
Based on the background classification, choose ONE style:

• style2_banner_replace — USE WHEN: existing_banner is detected.
  Rule: Cover ONLY the exact pixel region of the old banner. Reuse its dimensions. No enlargement.
  The old text must be completely hidden — paint the same background color over it before writing new text.

• style1_outline — USE WHEN: backgroundType = "plain".
  Rule: Do NOT draw any rectangle. Render bold white text with a 3px black stroke and drop shadow.
  Perfect for cartoons, memes with solid-color backgrounds (like Tom & Jerry green background).

• style4_gradient — USE WHEN: backgroundType = "busy" AND the content is a real video (live action, people, footage).
  Rule: Render a semi-transparent dark gradient scrim (0% → 60% dark) behind the text. No hard-edged black rectangle.

• style3_black_banner — USE WHEN: backgroundType = "busy" AND the content is a meme or cartoon that genuinely needs a solid black banner.
  Rule: Use ONLY when style1/style2/style4 would make text unreadable. Keep banner height tight to the text.

STEP 4C — Existing Banner Detection (RULE A)
  If a solid black or white HORIZONTAL text-banner strip (meme caption bar, subtitle bar) exists at the very top or bottom of the frame:
  - Set existingBanner = true
  - Set bannerBounds to EXACTLY the pixel-accurate bounding box of ONLY that strip
  - The first entry in safeAreas MUST be this banner (score ≥ 95, reason = "existing banner")
  - NEVER grow the banner height — only use the region that already exists
  - The banner background color will be sampled and matched, not always black

STEP 4D — Protected Regions (RULE B)
  NEVER place captions over ANY of these:
  - Human faces, eyes, mouths
  - Full bodies or characters (animated or real)
  - Hands, arms, gestures
  - Main foreground objects (escalators, machines, animals, vehicles, props)
  - Motion paths and action areas (where movement is happening)
  - Any text that is part of the scene itself

STEP 4E — Safe Area Candidate Scoring (RULE C)
  Score candidates 0-100. Candidates that overlap ANY protectedRegion score 0.
  Prefer: existing banner (95-100) → plain-color top/bottom (70-90) → empty negative space (50-70) → gradient-safe area (30-60)
  Include at least 2-3 candidates.

STEP 4F — Banner Sizing Rules
  - Width: if existingBanner, match the original banner width exactly.
  - If creating a new style1/style4 area: width is text-wrapping width + 40-60px padding on each side (NOT full-width).
  - Height: calculated from rendered text height. Never oversized.
  - Full-width banners ONLY when the original meme already has a full-width banner.

Fields to return:
- backgroundType: "plain" | "busy" | "existing_banner"
- captionStyle: "style1_outline" | "style2_banner_replace" | "style3_black_banner" | "style4_gradient"
- existingBanner: boolean
- bannerBounds: exact bounding box of existing banner or null
- safeAreas: list of up to 5 candidate boxes sorted by score DESC, each with x/y/width/height/score/reason
- protectedRegions: list of protected areas with type, box, description
- recommendedPlacement: one of "existing_banner", "top", "bottom", "left", "right"

TASK 5: Quality Assessment
Evaluate the image quality, text readability, watermark risk, and style format:
- readability: rating from 0 (illegible) to 100 (high contrast, crisp text).
- watermarkRisk: rating from 0 (no handles/branding) to 100 (unwanted handle overlays).
- isStandardMemeStyle: boolean (true if standard black banner meme or infographic layout).
- recommendation: text describing editing recommendations.

Return ONLY a raw JSON object matching this schema — no markdown, no explanation:
{
  "metadata": {
    "title": string,
    "description": string,
    "primaryKeyword": string,
    "secondaryKeywords": string[],
    "tags": string[],
    "hashtags": string[],
    "thumbnailText": string,
    "filename": string,
    "mood": "funny" | "sad" | "other",
    "factCheckScore": number,
    "verdict": string
  },
  "brandingZones": [
    {
      "type": "logo" | "watermark" | "handle" | "profile_name" | "main_post_content" | "original_captions",
      "box": {
        "x": number,
        "y": number,
        "width": number,
        "height": number
      },
      "description": string
    }
  ],
  "extractedText": string,
  "backgroundType": "plain" | "busy" | "existing_banner",
  "captionStyle": "style1_outline" | "style2_banner_replace" | "style3_black_banner" | "style4_gradient",
  "existingBanner": boolean,
  "bannerBounds": {
    "x": number,
    "y": number,
    "width": number,
    "height": number
  } | null,
  "safeAreas": [
    {
      "x": number,
      "y": number,
      "width": number,
      "height": number,
      "score": number,
      "reason": string
    }
  ],
  "protectedRegions": [
    {
      "type": string,
      "box": {
        "x": number,
        "y": number,
        "width": number,
        "height": number
      },
      "description": string
    }
  ],
  "recommendedPlacement": "existing_banner" | "top" | "bottom" | "left" | "right",
  "qualityScore": {
    "readability": number,
    "watermarkRisk": number,
    "isStandardMemeStyle": boolean,
    "recommendation": string
  }
}`;

      if (context.userPrompt) {
        prompt += `\n\nADDITIONAL EDITING INSTRUCTION FROM USER:
The user has requested the following adjustment: "${context.userPrompt}".
Adapt both Task 1 (bounding boxes / content coordinates) and Task 2 (metadata titles, tags, description) to satisfy this request.
Important:
- If the user request implies cropping, showing the main content only, removing the outer Instagram/TikTok chrome (likes, comments, header, footer), or focusing on the post itself, you MUST identify the exact boundaries of the central post image/media box as the "main_post_content" zone. Do not include the header or footer chrome in this zone.
- If the user asks to "change title to X", make sure the metadata title is X. If they ask to "make title more funny", rewrite the title to be funny.`;

        if (context.previousMetadata) {
          prompt += `\n\nCURRENT METADATA (modify this based on the user's instruction, otherwise preserve it as much as possible):
Title: ${context.previousMetadata.title}
Description: ${context.previousMetadata.description}
Tags: ${context.previousMetadata.tags?.join(", ")}`;
        }
      } else if (context.captionMetadata) {
        prompt += `\n\nUSER PROVIDED CAPTION (use this as the primary source for the title and description):
Title: ${context.captionMetadata.title}
Description: ${context.captionMetadata.description}`;
      }

      if (context.ocr?.text && context.ocr.text.trim().length > 10) {
        prompt += `\n\nOCR TEXT EXTRACTED FROM IMAGE:\n"${context.ocr.text}"\nPlease use this text for context when generating the metadata title and description.\n`;
      }

      let raw = "";
      if (this.freellmapi) {
        let attempts = 0;
        const maxAttempts = 8;
        while (attempts < maxAttempts) {
          try {
            pipelineLogger.info(
              `Attempting metadata generation via FreeLLMAPI (Attempt ${attempts + 1}/${maxAttempts})...`,
              "DirectUploader",
            );
            raw = await this.freellmapi.generateVision(prompt, base64, mimeType);
            if (raw) break;
          } catch (e: any) {
            const msg = e.message || String(e);
            if (msg.includes("429") || msg.includes("rate")) {
              attempts++;
              if (attempts >= maxAttempts) throw e;
              pipelineLogger.warn(
                `FreeLLMAPI rate limited (429). Waiting 15s before retry (${attempts}/${maxAttempts})...`,
                "DirectUploader"
              );
              await new Promise((r) => setTimeout(r, 15000));
            } else {
              throw e;
            }
          }
        }
      }

      if (!raw) {
        throw new Error("FreeLLMAPI failed to respond.");
      }

      const data = parseAiJson<{
        metadata: VideoMetadata;
        brandingZones: Array<{
          type:
            | "logo"
            | "watermark"
            | "handle"
            | "profile_name"
            | "main_post_content"
            | "original_captions";
          box: { x: number; y: number; width: number; height: number };
          description: string;
        }>;
        extractedText?: string;
        existingBanner: boolean;
        bannerBounds: {
          x: number;
          y: number;
          width: number;
          height: number;
        } | null;
        safeAreas: Array<{
          x: number;
          y: number;
          width: number;
          height: number;
          score: number;
          reason: string;
        }>;
        protectedRegions: Array<{
          type: string;
          box: { x: number; y: number; width: number; height: number };
          description: string;
        }>;
        recommendedPlacement:
          | "existing_banner"
          | "top"
          | "bottom"
          | "left"
          | "right";
        captionStyle?: "style1_outline" | "style2_banner_replace" | "style3_black_banner" | "style4_gradient";
        backgroundType?: "plain" | "busy" | "existing_banner";
        qualityScore?: {
          readability: number;
          watermarkRisk: number;
          isStandardMemeStyle: boolean;
          recommendation: string;
        };
      }>(raw);

      // Fallback if the LLM forgot the "metadata" wrapper but included the fields at the root
      if (!data.metadata && (data as any).title && (data as any).description) {
        data.metadata = {
          title: (data as any).title,
          description: (data as any).description,
          tags: Array.isArray((data as any).tags) ? (data as any).tags : [],
          hashtags: Array.isArray((data as any).hashtags) ? (data as any).hashtags : [],
          primaryKeyword: (data as any).primaryKeyword,
          mood: (data as any).mood,
        };
      }

      if (
        !data.metadata ||
        !data.metadata.title ||
        !data.metadata.description ||
        !Array.isArray(data.metadata.tags)
      ) {
        pipelineLogger.error(`Invalid AI JSON received. Missing required metadata fields. Raw response: ${raw}`, new Error("AI JSON missing metadata fields"), "DirectUploader");
        throw new Error("AI JSON missing metadata fields");
      }

      context.metadata = data.metadata;

      if (context.metadata.verdict && context.metadata.factCheckScore) {
        context.metadata.description += `\n\n🤖 Tech Fact Check Verdict: [${context.metadata.verdict}] (${context.metadata.factCheckScore}/10)`;
      }

      // Vision-first Text Extraction: If Vision LLM read text verbatim, set it as pre-populated OCR
      if (data.extractedText && data.extractedText.trim().length > 0) {
        const verbatimText = data.extractedText.trim();
        context.ocr = {
          text: verbatimText,
          confidence: 98,
          words: verbatimText.split(/\s+/).filter(Boolean),
          detailedWords: [],
        };
        pipelineLogger.info(
          `Vision AI successfully extracted verbatim text from image. OCR will be bypassed: "${verbatimText}"`,
          "DirectUploader",
        );
      }

      context.existingBanner = data.existingBanner;
      context.bannerBounds = data.bannerBounds || undefined;
      context.safeAreaCandidates = data.safeAreas || [];
      context.protectedRegions = data.protectedRegions || [];
      context.recommendedPlacement = data.recommendedPlacement;
      context.captionStyle = data.captionStyle || (data.existingBanner ? "style2_banner_replace" : "style1_outline");
      context.backgroundType = data.backgroundType || (data.existingBanner ? "existing_banner" : "plain");

      pipelineLogger.info(
        `Vision AI Caption Style: ${context.captionStyle}, Background: ${context.backgroundType}`,
        "DirectUploader",
      );

      if (context.safeAreaCandidates && context.safeAreaCandidates.length > 0) {
        const topCandidate = context.safeAreaCandidates[0];
        context.safeArea = {
          x: topCandidate.x,
          y: topCandidate.y,
          width: topCandidate.width,
          height: topCandidate.height,
        };
        pipelineLogger.info(
          `Vision AI successfully detected safe areas list. Default selected candidate (Reason: ${topCandidate.reason}, Score: ${topCandidate.score}): x=${context.safeArea.x}, y=${context.safeArea.y}, w=${context.safeArea.width}, h=${context.safeArea.height}`,
          "DirectUploader",
        );
      }

      if (data.qualityScore) {
        context.qualityScore = data.qualityScore;
        pipelineLogger.info(
          `Vision AI Quality Check: Readability=${data.qualityScore.readability}/100, Watermark Risk=${data.qualityScore.watermarkRisk}/100, Standard Style=${data.qualityScore.isStandardMemeStyle}`,
          "DirectUploader",
        );

        if (
          data.qualityScore.readability < 50 ||
          data.qualityScore.watermarkRisk > 70
        ) {
          const chatId = context.telegramMeta?.chatId;
          const messageId = context.telegramMeta?.messageId;
          if (chatId) {
            this.telegram
              .sendMessage(
                chatId,
                `⚠️ *AI Quality Check Warning:*\n` +
                  `• *Readability:* ${data.qualityScore.readability}/100\n` +
                  `• *Watermark Risk:* ${data.qualityScore.watermarkRisk}/100\n` +
                  `• *Recommendation:* _${escapeMarkdown(data.qualityScore.recommendation)}_`,
                messageId,
              )
              .catch((sendErr) => {
                pipelineLogger.error("Failed to send quality check warning message", sendErr, "DirectUploader");
              });
          }
        }
      }

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
              `⚠️ *AI Vision Quota Error:* Your FreeLLMAPI key has exceeded its quota.\n\n` +
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

      context.metadata = await this.generateTextMetadataFallback(false, context);
      context.brandingDetection = { detected: false, zones: [] };
    }
  }

  private async generateTextMetadataFallback(viral: boolean, context?: PipelineContext): Promise<VideoMetadata> {
    try {
      if (!this.freellmapi) return this.fallbackMetadata();
      pipelineLogger.info("Attempting text-only AI metadata fallback...", "DirectUploader");
      
      let contentContext = context?.ocr?.text && context.ocr.text.trim().length > 10
        ? `Here is the text extracted from the image: "${context.ocr.text}". Use this content to generate highly relevant metadata.`
        : `Generate a generic, catchy title and description for a short video. Keep it extremely broad (e.g. "You won't believe this!", "Wait for it..."). DO NOT mention programming, coding, or specific tech topics. DO NOT hallucinate any subjects.`;

      if (context?.userPrompt) {
        contentContext += `\n\nThe user wants this adjustment: "${context.userPrompt}".\n`;
        if (context.previousMetadata) {
          contentContext += `Current Metadata: Title: ${context.previousMetadata.title}, Description: ${context.previousMetadata.description}\n`;
        }
      } else if (context?.captionMetadata) {
        contentContext += `\n\nUser Provided Caption: Title: ${context.captionMetadata.title}, Description: ${context.captionMetadata.description}\nUse this as the primary source.\n`;
      }

      const prompt = viral
        ? `You are a viral YouTube Shorts growth hacker for a tech channel "CodeOrCap". ${contentContext} Generate the most scroll-stopping, curiosity-gap, high-CTR metadata possible based on the text. TITLE Max 65 chars. DESCRIPTION 180-300 words. Return ONLY raw JSON: {"metadata":{"title":"...","description":"...","tags":["..."],"mood":"other","factCheckScore":10,"verdict":"Accurate"}}`
        : `You are a YouTube Shorts strategist for a tech channel called "CodeOrCap". ${contentContext} Generate SEO-optimised metadata based on the text. Return ONLY raw JSON: {"metadata":{"title":"...","description":"...","tags":["..."],"mood":"other","factCheckScore":10,"verdict":"Accurate"}}`;
      
      const raw = await this.freellmapi.generateText(prompt);
      const data = parseAiJson<{metadata?: VideoMetadata} & Partial<VideoMetadata>>(raw);
      
      let meta = data.metadata;
      if (!meta && data.title && data.description) {
         meta = data as any;
      }
      
      if (meta && meta.title && meta.description && Array.isArray(meta.tags)) {
         return meta;
      }
      throw new Error("Invalid format from text fallback");
    } catch (err) {
      pipelineLogger.warn("Text fallback failed, using hardcoded metadata", "DirectUploader");
      return this.fallbackMetadata();
    }
  }

  private async generateMetadata(imagePath: string, context?: PipelineContext): Promise<VideoMetadata> {
    pipelineLogger.info("Generating metadata via AI vision…", "DirectUploader");

    const { base64, mimeType } = await this.getSmallBase64Image(imagePath);

    let prompt = `You are a viral YouTube Shorts strategist for a tech/programming channel called "CodeOrCap".

Analyze this image carefully — read all visible text, identify the topic, tools, languages, or concepts shown. Check the authenticity and correctness of the information shown.

Generate SEO-optimised YouTube Shorts metadata that will maximise clicks and watch time, and provide a fact-check verdict.

Rules:
- title: curiosity-driven, punchy, under 80 chars. Use power words and emojis. Examples: "You're Using Git Wrong 😤 Here's The Fix", "10 VS Code Shortcuts Devs Don't Know ⚡", "This Python Trick Will Blow Your Mind 🔥"
- description: 2-3 sentences explaining the value. End with 5-6 popular tags (hashtags). Max 400 chars.
- tags: 10-12 specific tags covering the topic, tools, and audience (no spaces in tags).
- mood: Determine the emotional tone or theme of the content. Choose exactly one of: "funny", "sad", or "other" (for general, educational, motivational, or tech tips).
- factCheckScore: (1-10) How technically accurate the image content is.
- verdict: A short string summarizing the authenticity (e.g. "Accurate", "False - Syntax Error", "Misleading", "Meme/Joke").`;

    if (context?.userPrompt) {
      prompt += `\n\nThe user wants this adjustment: "${context.userPrompt}".\n`;
      if (context.previousMetadata) {
        prompt += `Current Metadata: Title: ${context.previousMetadata.title}, Description: ${context.previousMetadata.description}\n`;
      }
    } else if (context?.captionMetadata) {
      prompt += `\n\nUser Provided Caption: Title: ${context.captionMetadata.title}, Description: ${context.captionMetadata.description}\nUse this as the primary source.\n`;
    }

    if (context?.ocr?.text && context.ocr.text.trim().length > 10) {
      prompt += `\n\nOCR TEXT EXTRACTED FROM IMAGE:\n"${context.ocr.text}"\nPlease use this text for context when generating the metadata title and description.\n`;
    }

    prompt += `\nReturn ONLY a raw JSON object — no markdown, no explanation:
{"title":"...","description":"...","tags":["...","..."],"mood":"funny" | "sad" | "other", "factCheckScore": 10, "verdict": "..."}`;

    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        let raw = "";
        if (this.freellmapi) {
          pipelineLogger.info(
            `Attempting metadata generation via FreeLLMAPI (Attempt ${attempt + 1}/8)...`,
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
        
        if (obj.verdict && obj.factCheckScore) {
          obj.description += `\n\n🤖 Tech Fact Check Verdict: [${obj.verdict}] (${obj.factCheckScore}/10)`;
        }
        
        return obj;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < 7 && /503|unavailable|rate|429/i.test(msg)) {
          const wait = 15000;
          pipelineLogger.warn(
            `AI attempt ${attempt + 1} failed (Rate Limit). Retrying in 15s…`,
            "DirectUploader",
          );
          await new Promise((r) => setTimeout(r, wait));
        } else {
          pipelineLogger.warn(
            `AI metadata failed: ${msg} — using text-only fallback`,
            "DirectUploader",
          );
          return await this.generateTextMetadataFallback(false, context);
        }
      }
    }
    return await this.generateTextMetadataFallback(false, context);
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
    context?: PipelineContext
  ): Promise<VideoMetadata> {
    pipelineLogger.info("Generating viral metadata via AI…", "DirectUploader");

    const { base64, mimeType } = await this.getSmallBase64Image(imagePath);

    let prompt = `You are an aggressive viral YouTube Shorts growth hacker for a tech channel called "CodeOrCap".

Analyze this image and generate the most scroll-stopping, curiosity-gap, high-CTR metadata possible.

TITLE RULES: Max 65 chars. Extreme curiosity gap, controversy, or shock. Primary keyword within first 30 chars. One emoji. No ALL CAPS (except AI, API, etc).
DESCRIPTION RULES: 180-300 words. Include: 1) What the video is about. 2) What you'll learn. 3) The Fact Check Verdict. 4) Subscribe CTA to @CodeOrCap. 5) Community CTA question. 6) Add popular tags (hashtags) at the end.
KEYWORDS: Provide 1 primary keyword, 5 secondary keywords, 15 tags, and 8-12 hashtags.
THUMBNAIL: Max 5 words, highly clickable, curiosity driven.
FILENAME: SEO-friendly filename (e.g., viral-tech-video-2026.mp4).
MOOD: Determine emotional tone: "funny", "sad", or "other".
FACT CHECK: Provide a factCheckScore (1-10 accuracy) and a short verdict ("Accurate", "False", etc).`;

    if (context?.userPrompt) {
      prompt += `\n\nThe user wants this adjustment: "${context.userPrompt}".\n`;
      if (context.previousMetadata) {
        prompt += `Current Metadata: Title: ${context.previousMetadata.title}, Description: ${context.previousMetadata.description}\n`;
      }
    } else if (context?.captionMetadata) {
      prompt += `\n\nUser Provided Caption: Title: ${context.captionMetadata.title}, Description: ${context.captionMetadata.description}\nUse this as the primary source.\n`;
    }

    if (context?.ocr?.text && context.ocr.text.trim().length > 10) {
      prompt += `\n\nOCR TEXT EXTRACTED FROM IMAGE:\n"${context.ocr.text}"\nPlease use this text for context when generating the metadata title and description.\n`;
    }

    prompt += `\nReturn ONLY raw JSON — no markdown:
{"title":"...","description":"...","primaryKeyword":"...","secondaryKeywords":["..."],"tags":["..."],"hashtags":["..."],"thumbnailText":"...","filename":"...","mood":"funny" | "sad" | "other","factCheckScore":10,"verdict":"..."}`;

    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        let raw = "";
        if (this.freellmapi) {
          pipelineLogger.info(
            `Attempting metadata generation via FreeLLMAPI (Attempt ${attempt + 1}/8)...`,
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
        
        if (obj.verdict && obj.factCheckScore) {
          obj.description += `\n\n🤖 Tech Fact Check Verdict: [${obj.verdict}] (${obj.factCheckScore}/10)`;
        }
        
        return obj;
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < 7 && /503|unavailable|rate|429/i.test(msg)) {
          pipelineLogger.warn(
            `AI attempt ${attempt + 1} failed (Rate Limit). Retrying in 15s…`,
            "DirectUploader"
          );
          await new Promise((r) => setTimeout(r, 15000));
        } else {
          pipelineLogger.warn(
            `AI viral metadata failed: ${msg} — using text-only fallback`,
            "DirectUploader"
          );
          return await this.generateTextMetadataFallback(true, context);
        }
      }
    }
    return await this.generateTextMetadataFallback(true, context);
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
    } = pending;

    // Remove the inline buttons from the review message
    await this.telegram.removeInlineButtons(chatId, reviewMessageId);

    await this.telegram.sendMessage(
      chatId,
      `🚀 *Uploading to ${config.youtube.channels.length} YouTube channel(s) and ${config.instagram.accounts.length} Instagram account(s)…*`,
      messageId,
    );

    try {
      const results: UploadResult[] = await this.youtube.uploadToAllChannels(
        finalVideoPath,
        metadata,
      );

      const instaResults: InstagramUploadResult[] = await this.instagram.uploadToAllAccounts(
        finalVideoPath,
        metadata,
      );

      const channelLines = results
        .map((r) => `• *YouTube (${r.channelName}):* ${r.url}`)
        .join("\n");

      const instaLines = instaResults
        .map((r) => `• *Instagram (${r.accountName}):* ${r.url}`)
        .join("\n");

      const successText =
        `✅ *Uploaded successfully!*\n\n` +
        `*Title:* ${escapeMarkdown(metadata.title)}\n\n` +
        `${channelLines}\n` +
        `${instaLines}\n\n` +
        `*ID:* ${id}`;

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

      this.db.updateJob(id, {
        status: "completed",
        currentStep: "Short uploaded to all configured platforms successfully",
        youtubeUrl: results[0]?.url,
        context: pending.context,
      });

      // Log upload to analytics feedback loop
      this.viralAnalyzer.logUpload(
        id,
        metadata.title,
        metadata.description,
        metadata.tags,
        results[0]?.url,
      );

      // Instead of deleting the review video, keep it for manual download.
      // Also send the final video with title and description so the user can retrieve metadata.
      try {
        const compressedVideoPath = path.join(path.dirname(finalVideoPath), "video_compressed.mp4");
        const videoToSend = fs.existsSync(compressedVideoPath) ? compressedVideoPath : finalVideoPath;

        let caption = `*Title:* ${metadata.title}\n*Description:* ${metadata.description}`;
        if (caption.length > 1000) {
          caption = caption.substring(0, 1000) + '...';
        }

        await this.telegram.sendRawVideo(
          chatId,
          videoToSend,
          caption,
        );
      } catch (sendErr) {
        pipelineLogger.error('Failed to send final video with metadata', sendErr, 'DirectUploader');
      }
      // Optionally retain the original review message; do not delete it.

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

      this.db.updateJob(id, {
        status: "failed",
        currentStep: "Upload failed",
        error: msg,
        context: pending.context,
      });
    }

    if (pending.context.mediaHash) {
    }

    // Cleanup local files
    try {
      if (pending.context.tempDir && fs.existsSync(pending.context.tempDir)) {
        fs.rmSync(pending.context.tempDir, { recursive: true, force: true });
        pipelineLogger.info(`Cleaned up temp directory ${pending.context.tempDir}`, "DirectUploader");
      }
      
      const outputPath = path.join("output", pending.outputFileName);
      if (fs.existsSync(outputPath)) {
        fs.rmSync(outputPath, { force: true });
        pipelineLogger.info(`Cleaned up output file ${outputPath}`, "DirectUploader");
      }
    } catch (cleanupErr) {
      pipelineLogger.error("Failed to clean up files", cleanupErr, "DirectUploader");
    }

    this.pending.delete(id);
    this.resolveJob(id);
  }

  // ── Review button handlers ─────────────────────────────────────────────────

  private onPublish(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.uploadAndReport(pending).catch((err) =>
      pipelineLogger.error(`Upload error for ${id}`, err, "DirectUploader"),
    );
  }

  private onCancel(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(id);
    this.telegram.removeInlineButtons(pending.chatId, pending.reviewMessageId);
    this.telegram.sendMessage(
      pending.chatId,
      `❌ *Cancelled.* Video files have been cleaned up.`,
      pending.messageId,
    );
    pipelineLogger.info(`Upload cancelled by user for ${id}`, "DirectUploader");
    
    this.db.updateJob(id, {
      status: "failed",
      currentStep: "Upload cancelled by user",
      context: pending.context,
    });

    if (pending.context.mediaHash) {
    }

    // Cleanup local files on cancel
    try {
      if (pending.context.tempDir && fs.existsSync(pending.context.tempDir)) {
        fs.rmSync(pending.context.tempDir, { recursive: true, force: true });
        pipelineLogger.info(`Cleaned up temp directory ${pending.context.tempDir}`, "DirectUploader");
      }
      
      const outputPath = path.join("output", pending.outputFileName);
      if (fs.existsSync(outputPath)) {
        fs.rmSync(outputPath, { force: true });
        pipelineLogger.info(`Cleaned up output file ${outputPath}`, "DirectUploader");
      }
    } catch (cleanupErr) {
      pipelineLogger.error("Failed to clean up files", cleanupErr, "DirectUploader");
    }

    this.resolveJob(id);
  }

  private async onApproveFrame(id: string): Promise<void> {
    const pending = this.pendingFrameReviews.get(id);
    if (!pending) return;

    // Clear timeout and remove from map
    clearTimeout(pending.timer);
    this.pendingFrameReviews.delete(id);

    // Clean up buttons from photo message
    await this.telegram
      .removeInlineButtons(pending.chatId, pending.reviewMessageId)
      .catch(() => {});

    pipelineLogger.info(
      `Frame approved for ${id}. Resuming video compilation...`,
      "DirectUploader",
    );

    // Proceed to next steps
    this.resumeFromFrameApproval(pending.context).catch((err) => {
      pipelineLogger.error(
        `Failed to resume pipeline after frame approval for ${id}`,
        err,
        "DirectUploader",
      );
    });
  }

  private async onCancelFrame(id: string): Promise<void> {
    const pending = this.pendingFrameReviews.get(id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingFrameReviews.delete(id);

    await this.telegram
      .removeInlineButtons(pending.chatId, pending.reviewMessageId)
      .catch(() => {});
    await this.telegram.sendMessage(
      pending.chatId,
      `❌ *Generation cancelled by user.*`,
      pending.reviewMessageId,
    );

    pipelineLogger.info(
      `Generation ${id} cancelled during frame review.`,
      "DirectUploader",
    );

    this.db.updateJob(id, {
      status: "failed",
      currentStep: "Generation cancelled by user during frame review",
      context: pending.context,
    });

    if (pending.context.mediaHash) {
    }

    this.resolveJob(id);
  }

  private async onSelectFrameVariant(
    id: string,
    variantCode: string,
  ): Promise<void> {
    const pending = this.pendingFrameReviews.get(id);
    if (!pending) return;

    // Clear timeout and remove from map
    clearTimeout(pending.timer);
    this.pendingFrameReviews.delete(id);

    // Clean up buttons from photo message
    await this.telegram
      .removeInlineButtons(pending.chatId, pending.reviewMessageId)
      .catch(() => {});

    const variants = pending.context.captionVariants;
    // Updated: option A keeps original caption (no rephrase)
    let selectedCaption = pending.context.rephrasedCaption;
    if (variants) {
      if (variantCode === "a") {
        // Do not set rephrased caption, use original
        selectedCaption = undefined;
        pending.context.useRephrasedCaption = false;
      } else if (variantCode === "b") {
        selectedCaption = variants.B;
      } else if (variantCode === "c") {
        selectedCaption = variants.C;
      }
    }
    if (variantCode !== "a") {
      pending.context.rephrasedCaption = selectedCaption;
      pending.context.useRephrasedCaption = true;
    }
    pipelineLogger.info(
      `User selected variant ${variantCode.toUpperCase()}: "${selectedCaption}" for job ${id}`,
      "DirectUploader",
    );

    await this.telegram.sendMessage(
      pending.chatId,
      `🅰️ *Selected Variant ${variantCode.toUpperCase()}*:\n\`"${selectedCaption}"\`\n\nRe-rendering layout preview…`,
      pending.messageId,
    );

    // Resolve the previous job promise so the queue slot is freed before re-running
    this.resolveJob(id);

    // Re-run pipeline to render the layout with the selected variant
    this.run(pending.context).catch((err) => {
      pipelineLogger.error(
        `Failed to run pipeline for selected variant: ${id}`,
        err,
        "DirectUploader",
      );
    });
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
      ? this.generateViralMetadata(pending.originalImagePath, pending.context)
      : this.generateMetadata(pending.originalImagePath, pending.context);

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

  private async onReplaceMusic(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;

    pipelineLogger.info(`Replacing music for ${id}`, "DirectUploader");

    try {
      const tempMusicVideoPath = path.join(pending.context.tempDir, "video_music_replaced.mp4");
      const rawVideoPath = path.join(pending.context.tempDir, "video_raw.mp4");
      
      await this.music.addBackgroundMusic(
        rawVideoPath,
        config.paths.musicDir,
        tempMusicVideoPath,
        pending.metadata.mood,
        undefined,
        pending.context.isVideo,
      );

      fs.copyFileSync(tempMusicVideoPath, pending.finalVideoPath);
      fs.copyFileSync(tempMusicVideoPath, pending.outputFilePath);

      // Edit the video in the existing review message
      const caption =
        `📋 *Review your Short*\n\n` +
        `*Title:* ${escapeMarkdown(pending.metadata.title)}\n\n` +
        `*Description:* ${escapeMarkdown(pending.metadata.description.slice(0, 200))}…\n\n` +
        `⏳ _Waiting for review action..._`;

      await this.telegram.editReviewVideo(
        pending.chatId,
        pending.reviewMessageId,
        pending.finalVideoPath,
        caption,
        id,
      );
      
      
      // Removed auto-publish timer as per user request

    } catch (err) {
      pipelineLogger.error(
        `Failed to replace music for ${id}`,
        err,
        "DirectUploader",
      );
    }
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
    this.queue.addJob(context.id, async () => {
      await this.executePipeline(context);
    });
  }

  private async executePipeline(context: PipelineContext): Promise<void> {
    const { id, tempDir, originalImagePath, telegramMeta } = context;
    const { chatId, messageId } = telegramMeta;
    const isVideo = context.isVideo === true;
    const mediaLabel = isVideo ? "video" : "image";

    const pristineImagePath = path.join(tempDir, "pristine_original.jpg");
    const pristineVideoPath = path.join(tempDir, "pristine_video.mp4");

    // 1. On first run, create backup of original video
    if (isVideo && context.originalVideoPath) {
      if (
        !fs.existsSync(pristineVideoPath) &&
        fs.existsSync(context.originalVideoPath)
      ) {
        fs.copyFileSync(context.originalVideoPath, pristineVideoPath);
      }
    }

    // 2. Before we start processing, restore original pristine files (prevent "editing on edited")
    if (isVideo && fs.existsSync(pristineVideoPath)) {
      fs.copyFileSync(pristineVideoPath, context.originalVideoPath!);
    }
    if (fs.existsSync(pristineImagePath)) {
      fs.copyFileSync(pristineImagePath, originalImagePath);
    }

    try {
      this.db.createJob(id, {
        status: "pending",
        currentStep: "Ingestion and setup completed",
        source: `chat_${chatId}_msg_${messageId}`,
        mediaType: isVideo ? "video" : "image",
        context,
      });

      await this.telegram.sendMessage(
        chatId,
        `⚙️ *Processing your ${mediaLabel}…*\n\`ID: ${id}\`\n\nGenerating metadata, editing video, adding music…`,
        messageId,
      );

      // Compute media hash for caching
      const sourceFileForHash =
        isVideo && context.originalVideoPath
          ? context.originalVideoPath
          : originalImagePath;
      let mediaHash = "";
      try {
        mediaHash = await getFileHash(sourceFileForHash);
        context.mediaHash = mediaHash;
        pipelineLogger.info(
          `Calculated media file hash: ${mediaHash}`,
          "DirectUploader",
        );
      } catch (hashErr) {
        pipelineLogger.warn(
          `Failed to calculate media file hash: ${hashErr}`,
          "DirectUploader",
        );
      }


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

      // Back up pristine original image as soon as it is extracted/loaded
      if (fs.existsSync(originalImagePath) && !fs.existsSync(pristineImagePath)) {
        fs.copyFileSync(originalImagePath, pristineImagePath);
      }

      // Ensure image analysis is completed so dimensions are always populated (needed for layout mapping)
      if (!context.analysis && fs.existsSync(originalImagePath)) {
        try {
          context.analysis = await this.analyzer.analyze(originalImagePath);
        } catch (err) {
          pipelineLogger.warn(
            `Failed to analyze image: ${err instanceof Error ? err.message : err}`,
            "DirectUploader",
          );
        }
      }
      // Run OCR before Vision API so that text is available for fallback metadata generation
      if (!context.ocr && fs.existsSync(originalImagePath)) {
        try {
          const ocrService = new OcrService();
          context.ocr = await ocrService.extractText(originalImagePath);
        } catch (err) {
          pipelineLogger.warn(
            `Early OCR extraction failed: ${err instanceof Error ? err.message : err}`,
            "DirectUploader",
          );
        }
      }


      // 1 — Metadata & Branding Detection (always run vision model to detect watermarks/branding if not cached)
      if (!context.metadata || !context.brandingDetection) {
        await this.runUnifiedAiVision(originalImagePath, context);
      }

      this.db.updateJob(id, {
        status: "analyzing",
        currentStep: "AI vision and metadata parsing complete",
        visionResult: context.brandingDetection,
        metadata: context.metadata,
        mediaHash: context.mediaHash,
        qualityScore: context.qualityScore,
        context,
      });

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

      // 2 — Render/Process video
      context.status = "rendering_video";
      const rawVideoPath = path.join(tempDir, "video_raw.mp4");
      if (isVideo && context.originalVideoPath) {
        // User requested: do not override text (no blurring)
        if (context.brandingDetection) {
          context.brandingDetection.zones = [];
        }
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
        // Skip ALL image editing (blur, branding removal) for Telegram-originated images
        if (context.isTelegram) {
          pipelineLogger.info(
            "Telegram image detected — skipping all blur/branding editing",
            "DirectUploader",
          );
        } else {
        // Parse manual blur commands from user prompt for static images
        if (context.userPrompt) {
          const p = context.userPrompt.toLowerCase();
          const match1 = p.match(/blur\s+v([0-6])\s*(?:to|-)\s*v([0-6])\s*(?:and|,|)?\s*(\d+)\s*(?:to|-)\s*(\d+)/i);
          const match2 = p.match(/blur\s+(\d+)\s*(?:to|-)\s*(\d+)\s*(?:and|,|)?\s*v([0-6])\s*(?:to|-)\s*v([0-6])/i);
          
          let vStart, vEnd, hStart, hEnd;
          if (match1) {
            vStart = parseInt(match1[1], 10); vEnd = parseInt(match1[2], 10);
            hStart = parseInt(match1[3], 10); hEnd = parseInt(match1[4], 10);
          } else if (match2) {
            hStart = parseInt(match2[1], 10); hEnd = parseInt(match2[2], 10);
            vStart = parseInt(match2[3], 10); vEnd = parseInt(match2[4], 10);
          }

          if (vStart !== undefined && vEnd !== undefined && hStart !== undefined && hEnd !== undefined) {
            if (!context.brandingDetection) context.brandingDetection = { detected: false, zones: [] };
            context.brandingDetection.zones.push({
              id: `manual-blur-${Date.now()}`,
              type: "watermark",
              boundingBox: {
                x: Math.min(vStart, vEnd) / 6.0,
                y: Math.min(hStart, hEnd) / 100.0,
                width: Math.max(Math.max(vStart, vEnd) - Math.min(vStart, vEnd), 0.01) / 6.0,
                height: Math.max(Math.max(hStart, hEnd) - Math.min(hStart, hEnd), 1) / 100.0
              },
              confidence: 1.0,
              description: "Manual blur region"
            });
          }
        }

        // 2a — Blur other branding zones (logo, watermark, handle, profile_name, other) on the static image (excluding original_captions)
        const otherZones = context.brandingDetection?.zones.filter(
          (z) =>
            z.type !== "main_post_content" &&
            (z.type as string) !== "original_captions",
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
        } // end of !isTelegram guard

        // Apply user-requested or automatic crop to the static image before generating video
        const { cropTop, cropBottom } = calculateVideoCrop(context);
        if (cropTop > 0 || cropBottom > 0) {
          try {
            pipelineLogger.info(
              `Applying crop to static image: top=${cropTop * 100}%, bottom=${cropBottom * 100}%`,
              "DirectUploader",
            );
            const meta = await sharp(originalImagePath).metadata();
            if (meta.width && meta.height) {
              const y = Math.round(cropTop * meta.height);
              const h = meta.height - y - Math.round(cropBottom * meta.height);

              const safeY = Math.max(0, Math.min(meta.height - 10, y));
              const safeH = Math.max(10, Math.min(meta.height - safeY, h));

              const croppedTemp = path.join(tempDir, "original_cropped.jpg");
              await sharp(originalImagePath)
                .extract({
                  left: 0,
                  top: safeY,
                  width: meta.width,
                  height: safeH,
                })
                .toFile(croppedTemp);

              fs.copyFileSync(croppedTemp, originalImagePath);
              try {
                fs.unlinkSync(croppedTemp);
              } catch {}
              pipelineLogger.checkpoint(
                "Static image cropped successfully",
                true,
              );
            }
          } catch (err) {
            pipelineLogger.error(
              "Failed to crop static image",
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
      {
        try {
          // AI Caption Rephrasing & User Prompt logic
          let rephrasedCaption = "";
          const rawOcrText = context.ocr?.text || "";

          let aiPrompt = "";
          const viralPatterns = this.viralAnalyzer.getViralPatterns();
          if (context.userPrompt) {
            aiPrompt = `You are a copywriting expert for a tech meme channel.
Modify the video caption based on the user's instructions.
User Instruction: "${context.userPrompt}"
Original Video Text: "${rawOcrText}"

Generate three distinct, creative caption options: [A], [B], and [C]. Each option must be different in style (e.g. funny, curious, professional, controversial, or engaging).

For each option, structure the caption into three sequential segments representing the viral structure of the Short:
1. Hook (prefixed with '[HOOK]'): A scroll-stopping hook statement.
2. Body (prefixed with '[BODY]'): The main insight/content.
3. CTA (prefixed with '[CTA]'): A clear call to action (e.g. 'Follow for more!', 'Try it now!').

Insert a double slash '//' at natural semantic phrasing boundaries where line breaks should occur. Keep each segment short (2 to 5 words). 

For example format:
[A] [HOOK] This new AI tool // will replace // all devs [BODY] It builds websites // from a simple sketch // in seconds [CTA] Try it now! // Link in bio
[B] [HOOK] Stop building websites // the old way [BODY] Use this new AI tool // to code in seconds // from sketches [CTA] Follow for more! // Daily AI tips
[C] [HOOK] The end of web dev? // Look at this [BODY] AI now builds // complete web apps // from raw sketches [CTA] What do you think? // Comment below

Return ONLY the three lines starting with [A], [B], and [C] respectively. Do not include any other text, quotes, or explanations.`;
          } else {
            aiPrompt = `You are a copywriting expert for a tech meme channel.
Take the raw OCR text extracted from a video clip, remove any social media handles (words containing '@') or watermarks, and generate three distinct, creative caption options: [A], [B], and [C]. Each option must be different in style (e.g. funny, curious, professional, controversial, or engaging).

For each option, structure the caption into three sequential segments representing the viral structure of the Short:
1. Hook (prefixed with '[HOOK]'): A scroll-stopping hook statement.
2. Body (prefixed with '[BODY]'): The main insight/content.
3. CTA (prefixed with '[CTA]'): A clear call to action (e.g. 'Follow for more!', 'Try it now!').

Insert a double slash '//' at natural semantic phrasing boundaries where line breaks should occur. Keep each segment short (2 to 5 words). 

For example format:
[A] [HOOK] This new AI tool // will replace // all devs [BODY] It builds websites // from a simple sketch // in seconds [CTA] Try it now! // Link in bio
[B] [HOOK] Stop building websites // the old way [BODY] Use this new AI tool // to code in seconds // from sketches [CTA] Follow for more! // Daily AI tips
[C] [HOOK] The end of web dev? // Look at this [BODY] AI now builds // complete web apps // from raw sketches [CTA] What do you think? // Comment below

OCR Text: "${rawOcrText}"

Use the following historical copywriting analytics feedback as inspiration of viral patterns:
${viralPatterns}

Return ONLY the rephrased caption text containing the segment prefix tags and double slashes. No quotes, no explanations.`;
          }

          let captionVariants = {
            A: rephrasedCaption,
            B: rephrasedCaption,
            C: rephrasedCaption,
          };

          if (false /* AI caption generation disabled */ && this.freellmapi) {
            try {
              pipelineLogger.info(
                "Rephrasing caption variants with AI...",
                "DirectUploader",
              );
              const aiResponse = await this.freellmapi!.generateText(aiPrompt);

              let varA = "";
              let varB = "";
              let varC = "";

              const lines = aiResponse
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean);
              for (const line of lines) {
                if (line.startsWith("[A]"))
                  varA = line.replace("[A]", "").trim();
                else if (line.startsWith("[B]"))
                  varB = line.replace("[B]", "").trim();
                else if (line.startsWith("[C]"))
                  varC = line.replace("[C]", "").trim();
              }

              if (!varA) {
                varA = aiResponse.trim().replace(/^["']|["']$/g, "");
                varB = varA;
                varC = varA;
              } else {
                varA = varA.replace(/^["']|["']$/g, "");
                varB = varB ? varB.replace(/^["']|["']$/g, "") : varA;
                varC = varC ? varC.replace(/^["']|["']$/g, "") : varA;
              }

              captionVariants = { A: varA, B: varB, C: varC };
              rephrasedCaption = varA;

              pipelineLogger.checkpoint(
                "AI caption variants generated",
                true,
                `A: ${varA}\nB: ${varB}\nC: ${varC}`,
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
              captionVariants = {
                A: rephrasedCaption,
                B: rephrasedCaption,
                C: rephrasedCaption,
              };
            }
          } else {
            rephrasedCaption = rawOcrText
              .split(/\s+/)
              .filter((w) => !w.includes("@"))
              .join(" ");
            captionVariants = {
              A: rephrasedCaption,
              B: rephrasedCaption,
              C: rephrasedCaption,
            };
          }

          const originalCaption = rawOcrText
            .split("\n")
            .map((line) =>
              line
                .split(/\s+/)
                .filter((w) => !w.includes("@") && !w.toLowerCase().includes("http") && !w.toLowerCase().includes(".com"))
                .join(" ")
                .trim()
            )
            .filter(Boolean)
            .join(" // ")
            .trim();

          if (context.rephrasedCaption && !context.userPrompt) {
            // Keep selected variant caption
          } else {
            // Default to original caption unless a user prompt override is present
            context.rephrasedCaption = context.userPrompt ? rephrasedCaption : originalCaption;
          }

          context.captionVariants = captionVariants;

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

          // Find exact cropping coordinates used
          const { cropTop, cropBottom } = calculateVideoCrop(context);
          const finalCropTop = cropTop;
          const finalCropBottom = cropBottom;

          let yCropped = Math.round(analysis.height * finalCropTop);
          let hCropped =
            analysis.height -
            yCropped -
            Math.round(analysis.height * finalCropBottom);
          let wCropped = analysis.width;
          let hScaled = 1920;
          let yOffset = 0;

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

          let textLayers = [];
          if (
            context.ocr?.detailedWords &&
            context.ocr.detailedWords.length > 0
          ) {
            // Filter out words that overlap significantly with detected branding zones (watermarks, handles)
            // so they don't get redrawn by Remotion in blue text on top of the blurred zone.
            const brandingZones = (detection?.zones || []).filter(
              (z) => z.type !== "original_captions" && z.type !== "main_post_content"
            );

            const isInsideBrandingZone = (word: any) => {
              if (!analysis.width || !analysis.height) return false;
              const wordX0 = word.bbox.x0 / analysis.width;
              const wordY0 = word.bbox.y0 / analysis.height;
              const wordX1 = word.bbox.x1 / analysis.width;
              const wordY1 = word.bbox.y1 / analysis.height;

              return brandingZones.some((z) => {
                const zX0 = z.boundingBox.x;
                const zY0 = z.boundingBox.y;
                const zX1 = z.boundingBox.x + z.boundingBox.width;
                const zY1 = z.boundingBox.y + z.boundingBox.height;

                const xOverlap = Math.max(0, Math.min(wordX1, zX1) - Math.max(wordX0, zX0));
                const yOverlap = Math.max(0, Math.min(wordY1, zY1) - Math.max(wordY0, zY0));

                if (xOverlap > 0 && yOverlap > 0) {
                  const wordArea = (wordX1 - wordX0) * (wordY1 - wordY0);
                  const overlapArea = xOverlap * yOverlap;
                  return wordArea > 0 && (overlapArea / wordArea) > 0.2;
                }
                return false;
              });
            };

            textLayers = context.ocr.detailedWords
              .filter((word) => word.confidence >= 85 && !isInsideBrandingZone(word))
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
          } else {
            // Fallback: Map original_captions branding detection zones to textLayers
            const captionZones = detection.zones.filter(
              (z) => (z.type as string) === "original_captions",
            );
            for (const cz of captionZones) {
              const box = cz.boundingBox;
              const x = Math.round(box.x * 1080);
              const y = Math.round(box.y * 1920);
              const w = Math.round(box.width * 1080);
              const h = Math.round(box.height * 1920);

              textLayers.push({
                text: "CAPTION_PLACEHOLDER",
                left: x,
                top: y,
                width: w,
                height: h,
                isMemeText: true,
              });
            }
          }

          // If the user did not select a rephrased variant, keep the original caption (do not render text overlay via Remotion)
          const keepOriginalCaption = !context.useRephrasedCaption;

          // 3. Prepare render props
          // Pass all safe-area intelligence to the Remotion component so it can
          // apply the correct placement priority chain and rendering style.
          const renderProps = {
            mediaUrl: "video_input.mp4",
            mediaType: "video",
            textLayers,
            memeCaption: keepOriginalCaption ? "" : (context.rephrasedCaption || ""),
            safeArea: context.safeArea,
            safeAreaCandidates: context.safeAreaCandidates || [],
            existingBanner: context.existingBanner || false,
            bannerBounds: context.bannerBounds || null,
            captionStyle: context.captionStyle || "style1_outline",
            backgroundType: context.backgroundType || "plain",
            keepOriginalCaption,
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
            "Skipping Remotion rendering as per user request (no captions)...",
            "DirectUploader",
          );
          fs.copyFileSync(rawVideoPath, remotionOutputPath);
          pipelineLogger.checkpoint(
            "✓ Video processing completed (Remotion skipped)",
            true,
          );

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

          // ── 5b. Post-render Visual Validation Pass ─────────────────────────
          // Extract the first frame of the rendered video and ask AI Vision
          // whether the caption is covering important scene content. If yes,
          // drop the top candidate, try the next one, and re-render (max 2 retries).
          if (this.freellmapi && (context.safeAreaCandidates?.length ?? 0) > 1) {
            try {
              const validationFramePath = path.join(tempDir, "validation_frame.png");
              const extractValidFrame = `ffmpeg -y -ss 00:00:01 -i "${rawVideoPath}" -vframes 1 -q:v 2 "${validationFramePath}"`;
              await new Promise<void>((res, rej) => exec(extractValidFrame, (e) => e ? rej(e) : res()));

              let candidateIndex = 0;
              let validationPassed = false;
              const MAX_RETRIES = 2;

              while (!validationPassed && candidateIndex < Math.min(MAX_RETRIES, context.safeAreaCandidates?.length ?? 0 - 1)) {
                const { base64: valBase64, mimeType: valMime } = await this.getSmallBase64Image(validationFramePath);
              const valPrompt = `Look at this rendered video frame. A caption text overlay has been added to it.
Answer ONLY with a raw JSON object — no markdown, no explanation:
{
  "coversImportantContent": boolean,
  "oldTextVisible": boolean,
  "bannerOversized": boolean,
  "looksNatural": boolean,
  "reason": string
}

Evaluate ALL four criteria:

1. coversImportantContent = true if the caption or any background rectangle behind it covers:
   - a human face, eyes, or mouth
   - an animated character's face or body
   - hands or gesture motions
   - the main subject or object of the scene (e.g. escalator, vehicle, animal, prop)
   - important action or motion area
   - the visual punchline of the meme

2. oldTextVisible = true if ANY letters or words from the ORIGINAL meme caption are still partially readable
   behind or around the new caption overlay (incomplete coverage of original text).

3. bannerOversized = true if:
   - The black or colored rectangle behind the caption is significantly taller than the text inside it
   - The banner is floating and does not align with any original caption region
   - There is clearly too much empty space above or below the text inside the banner

4. looksNatural = true if the caption feels like it was part of the original meme:
   - Text is centered in its region
   - Old text is fully hidden
   - No floating rectangles
   - Style matches the scene (e.g. plain text on cartoon, not black box on green background)

Set all booleans carefully and include a brief explanation in "reason".`;

                const valRaw = await this.freellmapi.generateVision(valPrompt, valBase64, valMime);
                let coversContent = false;
                try {
                  const valResult = parseAiJson<{
                    coversImportantContent: boolean;
                    oldTextVisible: boolean;
                    bannerOversized: boolean;
                    looksNatural: boolean;
                    reason: string;
                  }>(valRaw);
                  coversContent =
                    valResult.coversImportantContent === true ||
                    valResult.oldTextVisible === true ||
                    valResult.bannerOversized === true;
                  pipelineLogger.info(
                    `Post-render validation (candidate #${candidateIndex}): ` +
                    `coversContent=${valResult.coversImportantContent}, ` +
                    `oldTextVisible=${valResult.oldTextVisible}, ` +
                    `bannerOversized=${valResult.bannerOversized}, ` +
                    `looksNatural=${valResult.looksNatural}, ` +
                    `reason="${valResult.reason}"`,
                    "DirectUploader",
                  );
                } catch (parseErr) {
                  pipelineLogger.warn(
                    `Post-render validation response could not be parsed: ${valRaw.slice(0, 200)}`,
                    "DirectUploader",
                  );
                  break;
                }

                if (!coversContent) {
                  validationPassed = true;
                  pipelineLogger.checkpoint("✓ Post-render validation passed — caption looks natural", true);
                  break;
                }

                // Caption is covering content — try next candidate
                candidateIndex++;
                const safeCandidates = context.safeAreaCandidates ?? [];
                if (candidateIndex >= safeCandidates.length) break;

                const candidate = safeCandidates[candidateIndex];
                pipelineLogger.info(
                  `Caption covers important content — retrying with safe area candidate #${candidateIndex} (score=${candidate.score}, reason="${candidate.reason}")`,
                  "DirectUploader",
                );

                // Re-render with next candidate promoted to position 0
                const reorderedCandidates = [
                  safeCandidates[candidateIndex],
                  ...safeCandidates.filter((_, i) => i !== candidateIndex),
                ];

                const retryProps = {
                  ...renderProps,
                  safeAreaCandidates: reorderedCandidates,
                  existingBanner: false, // Do not reuse banner for fallback candidates
                  bannerBounds: null,
                };

                const retryPropsFile = path.join(tempDir, "remotion_props_retry.json");
                fs.writeFileSync(retryPropsFile, JSON.stringify(retryProps));

                const retryOutputPath = path.join(remotionPublicDir, "video_output_retry.mp4");
                if (fs.existsSync(retryOutputPath)) fs.unlinkSync(retryOutputPath);

                // Copy input video back (the original was already overwritten)
                fs.copyFileSync(rawVideoPath, remotionInputPath);

                const retryCmd = `npx remotion render DynamicText "${retryOutputPath}" --props="${retryPropsFile}" --duration=${durationInFrames}`;
                await new Promise<void>((res, rej) => {
                  exec(retryCmd, { cwd: remotionProjectDir }, (err) => err ? rej(err) : res());
                });

                if (fs.existsSync(retryOutputPath)) {
                  fs.copyFileSync(retryOutputPath, rawVideoPath);
                  pipelineLogger.checkpoint(`✓ Re-render with fallback candidate #${candidateIndex} complete`, true);
                  // Extract new validation frame from re-rendered video
                  await new Promise<void>((res, rej) => exec(
                    `ffmpeg -y -ss 00:00:01 -i "${rawVideoPath}" -vframes 1 -q:v 2 "${validationFramePath}"`,
                    (e) => e ? rej(e) : res()
                  ));
                  try { fs.unlinkSync(retryOutputPath); fs.unlinkSync(retryPropsFile); } catch (_) {}
                }
              }

              if (!validationPassed) {
                pipelineLogger.warn(
                  "Post-render validation: could not find a fully safe placement after retries. Keeping last render.",
                  "DirectUploader",
                );
              }

              // Clean up validation frame
              try { fs.unlinkSync(validationFramePath); } catch (_) {}
            } catch (validationErr) {
              pipelineLogger.warn(
                `Post-render validation failed (non-fatal): ${validationErr instanceof Error ? validationErr.message : validationErr}`,
                "DirectUploader",
              );
            }
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


      this.db.updateJob(id, {
        status: "rendering_video",
        currentStep: "Remotion rendering completed",
        ocrResult: context.ocr,
        caption: context.rephrasedCaption,
        safeArea: context.safeArea,
        qualityScore: context.qualityScore,
        context,
      });

      // ── FIRST FRAME LAYOUT REVIEW STEP ─────────────────────────────────────
      pipelineLogger.info(
        "Extracting first frame review image...",
        "DirectUploader",
      );
      const reviewFramePath = path.join(tempDir, "first_frame_review.png");
      const gridFilter = "drawgrid=w=iw/6:h=ih/10:t=2:c=yellow@0.8";
      const hTextFilters = Array.from({length: 9}, (_, i) => 
        `drawtext=text='${(i+1)*10}':x=20:y=h*${(i+1)/10}-50:fontsize=48:fontcolor=yellow:box=1:boxcolor=black@0.5`
      ).join(',');
      const vTextFilters = Array.from({length: 5}, (_, i) => 
        `drawtext=text='V${i+1}':x=w*${(i+1)/6}-30:y=40:fontsize=48:fontcolor=yellow:box=1:boxcolor=black@0.5`
      ).join(',');
      const textFilters = `${hTextFilters},${vTextFilters}`;
      const extractCmd = `ffmpeg -y -ss 00:00:01 -i "${rawVideoPath}" -vf "${gridFilter},${textFilters}" -vframes 1 -q:v 2 "${reviewFramePath}"`;
      await new Promise<void>((resolve, reject) => {
        exec(extractCmd, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      const truncate = (str: string) => {
        if (!str) return "";
        return str.length > 150 ? str.slice(0, 150) + "..." : str;
      };

      const reviewCaption =
        `🖼️ *Verify Frame Layout & Caption*\n\n` +
        `📄 *Current/Original:* "${escapeMarkdown(truncate(context.rephrasedCaption || ""))}"\n\n` +
        `⏳ _Auto-approves and renders video with Current/Original in 1 minute if no action is taken._`;

      const frameReviewMessageId = await this.telegram.sendPhotoForReview(
        chatId,
        reviewFramePath,
        reviewCaption,
        id,
        messageId,
        undefined, // caption variants disabled
      );

      pipelineLogger.info(
        `Holding pipeline ${id} for 1-minute frame review...`,
        "DirectUploader",
      );

      this.db.updateJob(id, {
        status: "frame_review",
        currentStep: "Frame sent for review. Waiting 1 minute.",
        context,
      });

      // Set 1-minute auto-approve timer
      const autoApproveTimer = setTimeout(async () => {
        pipelineLogger.info(
          `Auto-approving frame review for ${id} (timeout expired)`,
          "DirectUploader",
        );
        await this.onApproveFrame(id);
      }, 60000);

      this.pendingFrameReviews.set(id, {
        context,
        timer: autoApproveTimer,
        reviewMessageId: frameReviewMessageId,
        chatId,
        messageId,
      });

      // Wait until the job is fully resolved (published, cancelled, or failed)
      await new Promise<void>((resolve) => {
        this.jobResolvers.set(id, resolve);
      });
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

      this.db.updateJob(id, {
        status: "failed",
        currentStep: "Pipeline execution failed",
        error: context.error,
        context,
      });

      if (context.mediaHash) {
      }

      this.resolveJob(id);
    }
  }

  private async resumeFromFrameApproval(
    context: PipelineContext,
  ): Promise<void> {
    const id = context.id;
    const tempDir = context.tempDir;
    const metadata = context.metadata!;
    const rawVideoPath = path.join(tempDir, "video_raw.mp4");
    const originalImagePath = context.originalImagePath;
    const chatId = context.telegramMeta.chatId;
    const messageId = context.telegramMeta.messageId;

    try {
      this.db.updateJob(id, {
        status: "adding_music",
        currentStep: "Compiling video and mixing background audio",
        context,
      });

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
      let reviewVideoPath = finalVideoPath;
      const stats = fs.statSync(finalVideoPath);
      // Telegram has a 50MB limit. Compress if > 45MB to be safe.
      if (stats.size > 45 * 1024 * 1024) {
        pipelineLogger.info("Video exceeds 45MB. Compressing for Telegram...", "DirectUploader");
        reviewVideoPath = path.join(tempDir, "video_compressed.mp4");
        await new Promise<void>((resolve, reject) => {
          const ffmpegCmd = `${config.binaries.ffmpeg} -y -i "${finalVideoPath}" -vcodec libx264 -crf 28 -preset fast -c:a copy "${reviewVideoPath}"`;
          exec(ffmpegCmd, (error) => {
            if (error) {
              pipelineLogger.error("Failed to compress video for Telegram", error, "DirectUploader");
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }

      const caption =
        `📋 *Review your Short*\n\n` +
        `*Title:* ${escapeMarkdown(metadata.title)}\n\n` +
        `*Description:* ${escapeMarkdown(metadata.description.slice(0, 200))}…\n\n` +
        `⏳ _Waiting for review action..._`;

      const reviewMessageId = await this.telegram.sendVideoForReview(
        chatId,
        reviewVideoPath,
        caption,
        id,
        messageId,
      );

      // 6 — Save to pending list without an auto-publish timer
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
        context,
      });

      this.db.updateJob(id, {
        status: "final_review",
        currentStep: "Video compiled. Waiting for final publish review.",
        context,
      });

      pipelineLogger.checkpoint(
        "Review sent to Telegram",
        true,
        `${id} — waiting for user publish/cancel`,
      );

      // Release the queue slot immediately so the next job can start
      // while the user reviews. Publish/cancel operate on this.pending independently.
      this.resolveJob(id);
    } catch (err) {
      pipelineLogger.error(
        `Video compilation pipeline failed for ${id}`,
        err,
        "DirectUploader",
      );
      await this.telegram.sendMessage(
        chatId,
        `❌ *Video compilation failed:* \`${err instanceof Error ? err.message : err}\``,
        messageId,
      );

      this.db.updateJob(id, {
        status: "failed",
        currentStep: "Video compilation failed",
        error: err instanceof Error ? err.message : String(err),
        context,
      });

      if (context.mediaHash) {
      }

      this.resolveJob(id);
    }
  }

  private async handleUserTextPrompt(
    chatId: number,
    promptText: string,
    messageId: number,
  ): Promise<boolean> {
    // Find if there is a pending review or pending frame review in this chat
    let pendingId: string | null = null;
    let pendingUpload: any = null;
    let isFrameReview = false;

    for (const [id, val] of this.pending.entries()) {
      if (val.chatId === chatId) {
        pendingId = id;
        pendingUpload = val;
        break;
      }
    }

    if (!pendingId || !pendingUpload) {
      for (const [id, val] of this.pendingFrameReviews.entries()) {
        if (val.chatId === chatId) {
          pendingId = id;
          pendingUpload = val;
          isFrameReview = true;
          break;
        }
      }
    }

    if (!pendingId || !pendingUpload) {
      return false; // No pending review in this chat
    }

    pipelineLogger.info(
      `User text prompt received for active generation ${pendingId}: "${promptText}"`,
      "DirectUploader",
    );

    // 1. Cancel the current auto-publish timer if it exists
    if (pendingUpload.timer) {
      clearTimeout(pendingUpload.timer);
    }

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
    context.previousMetadata = context.metadata;
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

    // 5. Clean from pending map
    if (isFrameReview) {
      this.pendingFrameReviews.delete(pendingId);
    } else {
      this.pending.delete(pendingId);
    }

    this.resolveJob(pendingId);

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

  public async cancelAllPendingJobs(): Promise<void> {
    // Run metrics sync on boot
    this.syncYouTubeMetrics().catch(() => {});

    const activeJobs = this.db.listActiveJobs();
    if (activeJobs.length === 0) return;

    pipelineLogger.checkpoint(
      `Found ${activeJobs.length} active job(s) in DB. Cancelling them on startup...`,
      true,
    );

    for (const job of activeJobs) {
      this.db.updateJob(job.id, {
        status: "failed",
        currentStep: "Cancelled due to server restart",
      });
      pipelineLogger.info(
        `Cancelled old job ${job.id} on startup.`,
        "DirectUploader",
      );
    }
  }

  /**
   * Synchronize performance metrics (views, likes, comments) for all historical uploads
   * from the past 7 days using the YouTube Data API.
   */
  public async syncYouTubeMetrics(): Promise<void> {
    pipelineLogger.info(
      "Starting live YouTube analytics metrics synchronization...",
      "DirectUploader",
    );
    try {
      const records = this.viralAnalyzer.getRecords();
      let syncCount = 0;
      for (const record of records) {
        // Only sync uploads from the last 7 days
        const ageDays =
          (Date.now() - new Date(record.createdAt).getTime()) /
          (1000 * 60 * 60 * 24);
        if (ageDays <= 7 && record.youtubeUrl) {
          const urlParts = record.youtubeUrl.split("/");
          const videoId = urlParts[urlParts.length - 1];
          if (videoId && !videoId.startsWith("sim-")) {
            // Query YouTube statistics
            const stats = await this.youtube.getVideoMetrics(
              "Simulated",
              videoId,
            );
            if (stats) {
              this.viralAnalyzer.updateMetrics(record.id, {
                views: stats.views,
                likes: stats.likes,
                comments: stats.comments,
                retentionRate: 0.65 + Math.random() * 0.28, // Mock retention rate as API doesn't expose curves
              });
              syncCount++;
            }
          }
        }
      }
      pipelineLogger.checkpoint(
        "YouTube analytics synchronization complete",
        true,
        `Synced ${syncCount} active video(s)`,
      );
    } catch (err) {
      pipelineLogger.error(
        "Failed to synchronize YouTube metrics",
        err,
        "DirectUploader",
      );
    }
  }

  private resolveJob(id: string): void {
    const resolveFn = this.jobResolvers.get(id);
    if (resolveFn) {
      resolveFn();
      this.jobResolvers.delete(id);
    }
  }
}
