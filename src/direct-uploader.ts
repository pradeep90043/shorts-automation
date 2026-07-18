import fs from "fs";
import path from "path";
import sharp from "sharp";
import { exec, execSync } from "child_process";
import { config, ChannelProfile } from "./config";
import { VideoRenderer, calculateVideoCrop } from "./renderer";
import { OcrService } from "./ocr";
import { MusicService, normalizeMood } from "./music";
import { YouTubeService, UploadResult } from "./youtube";
import { InstagramPublisher, InstagramUploadResult } from "./instagram/publisher";
import { TelegramService, escapeMarkdown } from "./telegram";
import { PipelineContext, VideoMetadata } from "./types";
import { pipelineLogger } from "./utils/logger";
import { FreeLlmApiClient } from "./ai/freellmapi";
import { GeminiClient } from "./ai/gemini";
import { parseAiJson } from "./utils/json";
import { getFileHash } from "./utils/cache";
import { JobDatabase } from "./utils/db";
import { getCopyrightRisk, formatRisk } from "./audio/copyrightCheck";

import { ViralAnalyzer } from "./utils/viral-analyzer";
import { JobQueue } from "./utils/queue";
import { ImageAnalyzer } from "./image-analysis";
import { TTSService } from "./audio/tts";
import { estimateWordTimings, groupWordsIntoLines, generateASSFile } from "./audio/subtitles";
import { buildGridPreview } from "./utils/gridPreview";
import { TranscriptionService } from "./audio/transcription";

// Metadata format rules (title/description/keywords/analysis) live on the channel
// profile's ContentTheme (src/config/themes.ts) so every generation path (unified
// vision, vision fallback, viral, text-only) matches the channel's niche.

// Quota errors with "limit: 0", an exhausted DAILY quota, or the proxy reporting
// every upstream model rate-limited can never succeed on retry within the same
// run — fail fast to the next fallback instead of sleeping.
const isPermanentQuotaError = (msg: string): boolean =>
  /limit:\s*0|PerDayPerProject|free_tier_requests|All models rate-limited/i.test(msg);

const AI_MAX_ATTEMPTS = 3;
const AI_RETRY_DELAY_MS = 15000;

interface UnifiedVisionResponse {
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
  recommendedPlacement: "existing_banner" | "top" | "bottom" | "left" | "right";
  captionStyle?: "style1_outline" | "style2_banner_replace" | "style3_black_banner" | "style4_gradient";
  backgroundType?: "plain" | "busy" | "existing_banner";
  qualityScore?: {
    readability: number;
    watermarkRisk: number;
    isStandardMemeStyle: boolean;
    recommendation: string;
  };
  recommendedSettings?: {
    voiceover?: boolean;
    originalAudio?: boolean;
    music?: boolean;
    captions?: boolean;
    cropTopPct?: number;
    cropBottomPct?: number;
    creatorTextDetected?: boolean;
    reason?: string;
  };
}

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
  lastMusicTrack?: string;
  musicCaptionLine?: string;
}

export class DirectUploader {
  private freellmapi: FreeLlmApiClient | null = null;
  private gemini: GeminiClient = new GeminiClient();
  private renderer: VideoRenderer;
  private music: MusicService;
  private youtube: YouTubeService;
  private instagram: InstagramPublisher;
  private telegram: TelegramService;
  private db: JobDatabase;
  private profile: ChannelProfile;
  private tts: TTSService;

  private get theme() {
    return this.profile.theme;
  }
  private get voiceoverPromptLanguage(): string {
    return this.profile.key.toLowerCase() === "codeorcap"
      ? "natural, professional English"
      : "Hinglish (a conversational mix of Hindi and English, written in English alphabet)";
  }
  private viralAnalyzer = new ViralAnalyzer();
  private analyzer = new ImageAnalyzer();
  private queue = new JobQueue(1);
  private pending = new Map<string, PendingUpload>();
  private pendingSettingsReviews = new Map<
    string,
    {
      context: PipelineContext;
      resolve: (decision: "proceed" | "cancel" | "restart") => void;
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

  constructor(telegram: TelegramService, profile?: ChannelProfile) {
    this.profile = profile || telegram.profile;
    if (config.ai.provider === "freellmapi") {
      this.freellmapi = new FreeLlmApiClient();
    }
    this.renderer = new VideoRenderer(
      this.profile.handle,
      this.profile.brandName,
    );
    this.music = new MusicService();
    this.youtube = new YouTubeService(this.profile.youtube);
    this.instagram = new InstagramPublisher(this.profile.instagram.accounts);
    // Each channel profile keeps its own job db file (legacy name for the default profile)
    this.db = new JobDatabase(
      this.profile.isDefault ? undefined : this.profile.key,
    );
    this.telegram = telegram;
    this.tts = new TTSService();

    // Wire up inline-button callbacks from Telegram
    telegram.registerReviewCallback((action, id) => {
      if (action === "publish") this.onPublish(id);
      else if (action === "cancel") this.onCancel(id);
      else if (action === "regenerate") this.onRegenerate(id, false);
      else if (action === "viral") this.onRegenerate(id, true);
      else if (action === "toggle_voiceover") this.onToggleVoiceover(id);
      else if (action === "replace_music") {
        const pending = this.pending.get(id);
        if (pending) {
          this.telegram.sendMessage(
            pending.chatId,
            `🎵 *Please upload or send an audio file* (MP3, WAV, M4A, AAC, OGG) or record a voice note now to replace the background music for this Short.`,
            pending.reviewMessageId
          ).catch(() => {});
        }
      }
    });

    telegram.registerRevokeCallback(async (id) => {
      await this.onRevoke(id);
    });

    telegram.registerAudioUploadCallback(async (chatId, fileId, fileName, messageId) => {
      return this.handleUserAudioUpload(chatId, fileId, fileName, messageId);
    });

    telegram.registerSettingsReviewCallback((code, id) => {
      this.onSettingsAction(code, id);
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
    imagePath: string | string[],
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
      context.metadataIsFallback = true;
      context.metadata = this.fallbackMetadata();
      context.brandingDetection = { detected: false, zones: [] };
      return;
    }

    try {
      context.metadataIsFallback = false;
      const imagePaths = Array.isArray(imagePath) ? imagePath : [imagePath];
      const results = await Promise.all(
        imagePaths.map((imgPath) => this.getSmallBase64Image(imgPath))
      );
      const base64s = results.map((r) => r.base64);
      const mimeTypes = results.map((r) => r.mimeType);

      let prompt = `You are a computer vision assistant and growth strategist for ${this.theme.channelDescriptor} called "${this.profile.brandName}".

These 4 frames represent the visual progression of the video at 0%, 25%, 50%, and 75% of its duration. Describe what is happening at each stage and write a voiceover script that tracks this progression.

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

TASK 2: YouTube Shorts Metadata & Content Analysis
You are an expert YouTube SEO strategist for ${this.theme.channelDescriptor} called "${this.profile.brandName}".
${this.theme.analysisRules}
${this.theme.titleRules}
${this.theme.descriptionRules(this.profile.brandName)}
KEYWORDS: ${this.theme.keywordsRule}
THUMBNAIL: Max 5 words, highly clickable, curiosity driven.
FILENAME: SEO-friendly filename (e.g., short-video-2026.mp4).
MOOD: Determine emotional tone: "funny", "serious", "emotional", "motivational", "technical", "horror", "romantic", "sad", or "other".
VOICEOVER: Write a short, highly engaging 10-15 second script (approx 20-30 words) in ${this.voiceoverPromptLanguage} that describes the content. It should sound very natural, hook the viewer immediately, and explain what is happening or read the meme text in an entertaining way.

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

TASK 6: Recommended Processing Settings
Recommend how this video should be processed. Rules:
- originalAudio: true when the original audio carries the content (speech, dialogue, a story being told, meaningful sound). False when audio is just generic music or absent.
- voiceover: true when the video has no meaningful audio narrative and would benefit from an AI-narrated script (e.g. silent memes, stories told via on-screen text). False when the original speech IS the content.
- music: true when there is no dialogue/speech to preserve (background music enhances silent or music-only clips). False when original speech must stay audible.
- captions: true when there is speech to subtitle or a voiceover script will be narrated. False for pure visual/music content.
- cropTopPct / cropBottomPct: percentage of the frame height to crop away (MUST be one of 0, 5, 10, 15, 20, 25). Recommend cropping only to remove creator banners, usernames, app chrome, or captions baked near the very top/bottom edges (use the brandingZones you found). 0 when nothing needs removing.
- creatorTextDetected: true if any creator captions, usernames, or text overlays are baked into the video frames.
- reason: one short sentence explaining the recommendation.

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
    "mood": "funny" | "serious" | "emotional" | "motivational" | "technical" | "horror" | "romantic" | "sad" | "other",
    "factCheckScore": number,
    "verdict": string,
    "voiceoverScript": string
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
  },
  "recommendedSettings": {
    "voiceover": boolean,
    "originalAudio": boolean,
    "music": boolean,
    "captions": boolean,
    "cropTopPct": number,
    "cropBottomPct": number,
    "creatorTextDetected": boolean,
    "reason": string
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
      } else {
        prompt += this.buildCaptionPromptBlock(context);
      }

      if (context.ocr?.text && context.ocr.text.trim().length > 10) {
        prompt += `\n\nOCR TEXT EXTRACTED FROM IMAGE:\n"${context.ocr.text}"\nPlease use this text for context when generating the metadata title and description.\n`;
      }

      if (context.transcript?.text) {
        // Send only the text (word-level timing JSON bloats the payload and
        // causes timeouts; the timings are used locally for caption burning).
        const lastWord =
          context.transcript.words?.[context.transcript.words.length - 1];
        const speechSpan = lastWord
          ? ` (speech runs 0s–${Math.round(lastWord.end)}s)`
          : "";
        prompt += `\n\nOriginal video transcript${speechSpan}: "${context.transcript.text.slice(0, 2000)}"
Use this to write a voiceover script that matches the content arc of the video. Do not reveal the ending before it happens on screen.\n`;
      }

      let raw = "";
      let usedProvider = "FreeLLMAPI";
      let freeLlmApiFailure: any = null;
      if (this.freellmapi) {
        let attempts = 0;
        const maxAttempts = AI_MAX_ATTEMPTS;
        while (attempts < maxAttempts) {
          try {
            pipelineLogger.info(
              `Attempting metadata generation via FreeLLMAPI (Attempt ${attempts + 1}/${maxAttempts})...`,
              "DirectUploader",
            );
            raw = await this.freellmapi.generateVision(prompt, base64s, mimeTypes);
            if (raw) break;
          } catch (e: any) {
            const msg = e.message || String(e);
            if (isPermanentQuotaError(msg)) {
              pipelineLogger.warn(
                "FreeLLMAPI quota is exhausted (permanent for this run) — skipping retries and falling back.",
                "DirectUploader",
              );
              freeLlmApiFailure = e;
              break;
            }
            if (msg.includes("429") || msg.includes("rate")) {
              attempts++;
              if (attempts >= maxAttempts) {
                freeLlmApiFailure = e;
                break;
              }
              pipelineLogger.warn(
                `FreeLLMAPI rate limited (429). Waiting 15s before retry (${attempts}/${maxAttempts})...`,
                "DirectUploader"
              );
              await new Promise((r) => setTimeout(r, AI_RETRY_DELAY_MS));
            } else if (msg.includes("timed out")) {
              attempts++;
              if (attempts >= maxAttempts) {
                freeLlmApiFailure = e;
                break;
              }
              pipelineLogger.warn(
                `FreeLLMAPI timed out. Retrying immediately (${attempts}/${maxAttempts})...`,
                "DirectUploader"
              );
            } else {
              freeLlmApiFailure = e;
              break;
            }
          }
        }
      }

      if (!raw && freeLlmApiFailure && this.gemini.enabled) {
        pipelineLogger.warn(
          `FreeLLMAPI failed (${freeLlmApiFailure.message || freeLlmApiFailure}) — falling back to Gemini vision...`,
          "DirectUploader",
        );
        try {
          raw = await this.gemini.generateVision(prompt, base64s, mimeTypes);
          usedProvider = "Gemini";
          pipelineLogger.info("Gemini vision fallback succeeded.", "DirectUploader");
        } catch (geminiErr: any) {
          pipelineLogger.warn(
            `Gemini vision fallback also failed: ${geminiErr.message || geminiErr}`,
            "DirectUploader",
          );
        }
      }

      if (!raw) {
        throw freeLlmApiFailure || new Error("FreeLLMAPI failed to respond.");
      }

      let data: UnifiedVisionResponse;
      try {
        data = parseAiJson<UnifiedVisionResponse>(raw);
      } catch (parseErr: any) {
        // A malformed-JSON response can't be fixed by re-asking the same
        // provider the same way — but a different provider might return
        // valid JSON from the identical prompt+images.
        if (usedProvider === "FreeLLMAPI" && this.gemini.enabled) {
          pipelineLogger.warn(
            `FreeLLMAPI returned malformed JSON (${parseErr.message}) — retrying vision via Gemini...`,
            "DirectUploader",
          );
          try {
            raw = await this.gemini.generateVision(prompt, base64s, mimeTypes);
            data = parseAiJson<UnifiedVisionResponse>(raw);
            usedProvider = "Gemini";
            pipelineLogger.info("Gemini vision fallback succeeded.", "DirectUploader");
          } catch (geminiErr: any) {
            pipelineLogger.warn(
              `Gemini vision fallback also failed: ${geminiErr.message || geminiErr}`,
              "DirectUploader",
            );
            throw parseErr;
          }
        } else {
          throw parseErr;
        }
      }

      // Fallback if the LLM forgot the "metadata" wrapper but included the fields at the root
      if (!data.metadata && (data as any).title && (data as any).description) {
        data.metadata = {
          title: (data as any).title,
          description: (data as any).description,
          tags: Array.isArray((data as any).tags) ? (data as any).tags : [],
          hashtags: Array.isArray((data as any).hashtags) ? (data as any).hashtags : [],
          primaryKeyword: (data as any).primaryKeyword,
          mood: (data as any).mood,
          voiceoverScript: (data as any).voiceoverScript,
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

      context.metadata = this.ensureRequiredHashtags(data.metadata);

      if (this.theme.appendVerdict && context.metadata.verdict && context.metadata.factCheckScore) {
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

      this.applyRecommendedSettings(context, data.recommendedSettings);

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
      this.applyRecommendedSettings(context, undefined);
    }
  }

  /**
   * Turn the AI's (possibly partial or missing) recommendedSettings into a fully
   * populated context.aiRecommendedSettings, deriving sensible defaults from what
   * the pipeline already knows when the AI didn't answer.
   */
  private applyRecommendedSettings(
    context: PipelineContext,
    rec?: {
      voiceover?: boolean;
      originalAudio?: boolean;
      music?: boolean;
      captions?: boolean;
      cropTopPct?: number;
      cropBottomPct?: number;
      creatorTextDetected?: boolean;
      reason?: string;
    },
  ): void {
    const snapCrop = (value: unknown): number => {
      const n = typeof value === "number" && isFinite(value) ? value : 0;
      const clamped = Math.min(25, Math.max(0, n));
      return Math.round(clamped / 5) * 5;
    };

    const hasTranscriptWords = !!context.transcript?.words?.length;
    context.aiRecommendedSettings = {
      voiceover: rec?.voiceover ?? !!context.metadata?.voiceoverScript,
      originalAudio: rec?.originalAudio ?? !!context.hasOriginalAudio,
      music: rec?.music ?? !context.hasOriginalAudio,
      captions:
        rec?.captions ??
        (hasTranscriptWords || !!context.metadata?.voiceoverScript),
      cropTopPct: snapCrop(rec?.cropTopPct),
      cropBottomPct: snapCrop(rec?.cropBottomPct),
      sticker: false, // creative choice — always starts OFF, never AI-recommended
    };
    context.creatorTextDetected =
      rec?.creatorTextDetected ??
      (context.brandingDetection?.zones || []).some(
        (z) => z.type === "original_captions",
      );

    pipelineLogger.info(
      `AI recommended settings: ${JSON.stringify(context.aiRecommendedSettings)}, creatorText=${context.creatorTextDetected}${rec?.reason ? `, reason="${rec.reason}"` : ""}`,
      "DirectUploader",
    );
  }

  /**
   * Guarantee the theme's required hashtag/tag is present regardless of what the
   * LLM returned (e.g. #science for tech, #storytime for stories).
   */
  private ensureRequiredHashtags(meta: VideoMetadata): VideoMetadata {
    const tag = this.theme.requiredHashtag; // e.g. "science" (tech) or "storytime" (stories)
    const tagRegex = new RegExp(`#${tag}\\b`, "i");
    if (meta.description && !tagRegex.test(meta.description)) {
      const lines = meta.description.trimEnd().split("\n");
      const lastLine = lines[lines.length - 1];
      if (lastLine.includes("#")) {
        // Description already ends with a hashtag line — append to it
        lines[lines.length - 1] = `${lastLine} #${tag}`;
        meta.description = lines.join("\n");
      } else {
        meta.description = `${meta.description.trimEnd()}\n\n#${tag}`;
      }
    }
    if (
      Array.isArray(meta.hashtags) &&
      !meta.hashtags.some((h) => h.replace(/^#/, "").toLowerCase() === tag)
    ) {
      meta.hashtags.push(`#${tag}`);
    }
    if (
      Array.isArray(meta.tags) &&
      !meta.tags.some((t) => t.toLowerCase() === tag)
    ) {
      meta.tags.push(tag);
    }
    return meta;
  }

  private buildCaptionPromptBlock(context?: PipelineContext): string {
    if (!context?.captionMetadata) return "";
    const { title, description } = context.captionMetadata;
    if (context.instagramSource) {
      pipelineLogger.info(
        `Including original reel caption as prompt context (${(description || title || "").length} chars)`,
        "DirectUploader",
      );
      return `\n\nADDITIONAL CONTEXT — ORIGINAL CAPTION FROM THE SOURCE POST (Instagram/TikTok):
"""
${title && title !== description ? title + "\n" : ""}${description}
"""
Use this caption ONLY as extra context to better understand the video's actual topic, facts, and terminology. Do NOT copy its wording, style, or hashtags. Generate the title and description strictly following the format rules given above.\n`;
    }
    return `\n\nUSER PROVIDED CAPTION (use this as the primary source for the title and description):
Title: ${title}
Description: ${description}\n`;
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
      } else {
        contentContext += this.buildCaptionPromptBlock(context);
      }

      const prompt = viral
        ? `You are a viral YouTube Shorts growth hacker for ${this.theme.channelDescriptor} called "${this.profile.brandName}". ${contentContext} Generate the most scroll-stopping, curiosity-gap, high-CTR metadata possible based on the text.\n${this.theme.titleRules}\n${this.theme.descriptionRules(this.profile.brandName)}\nWrite a short, engaging 10-15 second voiceover script (approx 20-30 words) in ${this.voiceoverPromptLanguage} describing the content.\nReturn ONLY raw JSON: {"metadata":{"title":"...","description":"...","tags":["..."],"mood":"other","factCheckScore":10,"verdict":"Accurate","voiceoverScript":"..."}}`
        : `You are a YouTube Shorts strategist for ${this.theme.channelDescriptor} called "${this.profile.brandName}". ${contentContext} Generate SEO-optimised metadata based on the text.\n${this.theme.titleRules}\n${this.theme.descriptionRules(this.profile.brandName)}\nWrite a short, engaging 10-15 second voiceover script (approx 20-30 words) in ${this.voiceoverPromptLanguage} describing the content.\nReturn ONLY raw JSON: {"metadata":{"title":"...","description":"...","tags":["..."],"mood":"other","factCheckScore":10,"verdict":"Accurate","voiceoverScript":"..."}}`;
      
      // Retry timeouts once — the free API is intermittently slow. If
      // FreeLLMAPI still fails, Gemini gets one attempt with the same prompt
      // before giving up to the hardcoded template.
      let raw = "";
      try {
        raw = await this.freellmapi.generateText(prompt);
      } catch (e: any) {
        const msg = e?.message || String(e);
        if (msg.includes("timed out")) {
          pipelineLogger.warn(
            "Text fallback timed out. Retrying once...",
            "DirectUploader",
          );
          try {
            raw = await this.freellmapi.generateText(prompt);
          } catch (e2: any) {
            raw = await this.tryGeminiTextFallback(prompt, e2);
          }
        } else {
          raw = await this.tryGeminiTextFallback(prompt, e);
        }
      }
      const data = parseAiJson<{metadata?: VideoMetadata} & Partial<VideoMetadata>>(raw);
      
      let meta = data.metadata;
      if (!meta && data.title && data.description) {
         meta = data as any;
      }
      
      if (meta && meta.title && meta.description && Array.isArray(meta.tags)) {
         return this.ensureRequiredHashtags(meta);
      }
      throw new Error("Invalid format from text fallback");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pipelineLogger.warn(
        `Text fallback failed (${msg.slice(0, 150)}), using hardcoded template metadata`,
        "DirectUploader",
      );

      // Surface the failure in Telegram — otherwise the video silently goes to
      // review with a generic template title
      if (context) context.metadataIsFallback = true;
      const chatId = context?.telegramMeta?.chatId;
      if (chatId) {
        this.telegram
          .sendMessage(
            chatId,
            `❌ *AI metadata generation failed* (FreeLLMAPI, model: auto)\n` +
              `\`${msg.replace(/`/g, "'").slice(0, 200)}\`\n\n` +
              `_Using a generic template title/description instead. Tap 🔄 Regenerate on the review message to retry AI generation._`,
            context?.telegramMeta?.messageId,
          )
          .catch(() => {});
      }
      return this.fallbackMetadata();
    }
  }

  /**
   * Last attempt before the hardcoded template: retry the same text prompt
   * via Gemini. Re-throws the ORIGINAL FreeLLMAPI error (not a Gemini error)
   * if Gemini is unavailable or also fails, so the eventual Telegram warning
   * still names the real root cause.
   */
  private async tryGeminiTextFallback(prompt: string, originalErr: any): Promise<string> {
    if (!this.gemini.enabled) throw originalErr;
    pipelineLogger.warn(
      `FreeLLMAPI text fallback failed (${originalErr?.message || originalErr}) — trying Gemini...`,
      "DirectUploader",
    );
    try {
      const raw = await this.gemini.generateText(prompt);
      pipelineLogger.info("Gemini text fallback succeeded.", "DirectUploader");
      return raw;
    } catch (geminiErr: any) {
      pipelineLogger.warn(
        `Gemini text fallback also failed: ${geminiErr.message || geminiErr}`,
        "DirectUploader",
      );
      throw originalErr;
    }
  }

  private async generateMetadata(imagePath: string, context?: PipelineContext): Promise<VideoMetadata> {
    pipelineLogger.info("Generating metadata via AI vision…", "DirectUploader");

    const { base64, mimeType } = await this.getSmallBase64Image(imagePath);

    let prompt = `You are a viral YouTube Shorts strategist for ${this.theme.channelDescriptor} called "${this.profile.brandName}".

Analyze this image carefully — read all visible text and identify the topic, theme, or concepts shown.

Generate SEO-optimised YouTube Shorts metadata that will maximise clicks and watch time.

Rules:
- ${this.theme.titleRules}
- ${this.theme.descriptionRules(this.profile.brandName)}
- tags: 10-12 specific tags covering the topic, theme, and audience (no spaces in tags).
- mood: Determine the emotional tone or theme of the content. Choose exactly one of: "funny", "sad", or "other" (for general, educational, or motivational content).
- voiceoverScript: Write a short, highly engaging 10-15 second script (approx 20-30 words) in ${this.voiceoverPromptLanguage} that describes the content. It should sound very natural, hook the viewer immediately, and explain what is happening or read the meme text in an entertaining way.
- ${this.theme.analysisRules}`;

    if (context?.userPrompt) {
      prompt += `\n\nThe user wants this adjustment: "${context.userPrompt}".\n`;
      if (context.previousMetadata) {
        prompt += `Current Metadata: Title: ${context.previousMetadata.title}, Description: ${context.previousMetadata.description}\n`;
      }
    } else {
      prompt += this.buildCaptionPromptBlock(context);
    }

    if (context?.ocr?.text && context.ocr.text.trim().length > 10) {
      prompt += `\n\nOCR TEXT EXTRACTED FROM IMAGE:\n"${context.ocr.text}"\nPlease use this text for context when generating the metadata title and description.\n`;
    }

    prompt += `\nReturn ONLY a raw JSON object — no markdown, no explanation:
{"title":"...","description":"...","tags":["...","..."],"mood":"funny" | "sad" | "other", "factCheckScore": 10, "verdict": "...", "voiceoverScript": "..."}`;

    for (let attempt = 0; attempt < AI_MAX_ATTEMPTS; attempt++) {
      try {
        let raw = "";
        if (this.freellmapi) {
          pipelineLogger.info(
            `Attempting metadata generation via FreeLLMAPI (Attempt ${attempt + 1}/${AI_MAX_ATTEMPTS})...`,
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
        this.ensureRequiredHashtags(obj);

        if (this.theme.appendVerdict && obj.verdict && obj.factCheckScore) {
          obj.description += `\n\n🤖 Tech Fact Check Verdict: [${obj.verdict}] (${obj.factCheckScore}/10)`;
        }
        
        return obj;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < AI_MAX_ATTEMPTS - 1 && !isPermanentQuotaError(msg) && /503|unavailable|rate|429/i.test(msg)) {
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
      title: this.theme.fallback.title,
      description: this.theme.fallback.description,
      tags: [
        ...this.theme.fallback.tags,
        this.profile.handle.replace("@", ""),
      ],
    };
  }

  private async generateViralMetadata(
    imagePath: string,
    context?: PipelineContext
  ): Promise<VideoMetadata> {
    pipelineLogger.info("Generating viral metadata via AI…", "DirectUploader");

    const { base64, mimeType } = await this.getSmallBase64Image(imagePath);

    let prompt = `You are an aggressive viral YouTube Shorts growth hacker for ${this.theme.channelDescriptor} called "${this.profile.brandName}".

Analyze this image and generate the most scroll-stopping, curiosity-gap, high-CTR metadata possible.

TITLE RULES: Max 65 chars. Extreme curiosity gap, controversy, or shock. Primary keyword within first 30 chars. One emoji. No ALL CAPS (except AI, API, etc).
${this.theme.descriptionRules(this.profile.brandName)}
KEYWORDS: ${this.theme.keywordsRule}
THUMBNAIL: Max 5 words, highly clickable, curiosity driven.
FILENAME: SEO-friendly filename (e.g., viral-short-video-2026.mp4).
MOOD: Determine emotional tone: "funny", "serious", "emotional", "motivational", "technical", "horror", "romantic", "sad", or "other".
${this.theme.analysisRules}`;

    if (context?.userPrompt) {
      prompt += `\n\nThe user wants this adjustment: "${context.userPrompt}".\n`;
      if (context.previousMetadata) {
        prompt += `Current Metadata: Title: ${context.previousMetadata.title}, Description: ${context.previousMetadata.description}\n`;
      }
    } else {
      prompt += this.buildCaptionPromptBlock(context);
    }

    if (context?.ocr?.text && context.ocr.text.trim().length > 10) {
      prompt += `\n\nOCR TEXT EXTRACTED FROM IMAGE:\n"${context.ocr.text}"\nPlease use this text for context when generating the metadata title and description.\n`;
    }

    prompt += `\nReturn ONLY raw JSON — no markdown:
{"title":"...","description":"...","primaryKeyword":"...","secondaryKeywords":["..."],"tags":["..."],"hashtags":["..."],"thumbnailText":"...","filename":"...","mood":"funny" | "sad" | "other","factCheckScore":10,"verdict":"..."}`;

    for (let attempt = 0; attempt < AI_MAX_ATTEMPTS; attempt++) {
      try {
        let raw = "";
        if (this.freellmapi) {
          pipelineLogger.info(
            `Attempting metadata generation via FreeLLMAPI (Attempt ${attempt + 1}/${AI_MAX_ATTEMPTS})...`,
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
        this.ensureRequiredHashtags(obj);

        if (this.theme.appendVerdict && obj.verdict && obj.factCheckScore) {
          obj.description += `\n\n🤖 Tech Fact Check Verdict: [${obj.verdict}] (${obj.factCheckScore}/10)`;
        }
        
        return obj;
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < AI_MAX_ATTEMPTS - 1 && !isPermanentQuotaError(msg) && /503|unavailable|rate|429/i.test(msg)) {
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

  private async optimizeAndTrimVideo(videoPath: string): Promise<void> {
    const tempDir = path.dirname(videoPath);
    const tempOutPath = path.join(tempDir, `opt_${path.basename(videoPath)}`);
    
    // 1. Get video duration using ffprobe
    const ffprobeCmd = `${config.binaries.ffprobe} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
    const durationStr = await new Promise<string>((resolve, reject) => {
      exec(ffprobeCmd, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
    
    const duration = parseFloat(durationStr);
    if (isNaN(duration) || duration <= 0) {
      pipelineLogger.warn(`Could not determine video duration for optimization: ${videoPath}`, "DirectUploader");
      return;
    }
    
    pipelineLogger.info(`Input video duration: ${duration.toFixed(2)}s`, "DirectUploader");
    
    if (duration > 59.0) {
      pipelineLogger.info(`Video exceeds 59s. Trimming and optimizing with faststart...`, "DirectUploader");
      // Trimming requires re-encoding to prevent keyframe alignment issues
      const trimCmd = `${config.binaries.ffmpeg} -y -i "${videoPath}" -t 59.0 -c:v libx264 -preset superfast -crf 23 -c:a aac -movflags +faststart "${tempOutPath}"`;
      await new Promise<void>((resolve, reject) => {
        exec(trimCmd, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } else {
      pipelineLogger.info(`Optimizing video with faststart...`, "DirectUploader");
      // Just copy stream and add faststart flags (instant)
      const fastCmd = `${config.binaries.ffmpeg} -y -i "${videoPath}" -c copy -movflags +faststart "${tempOutPath}"`;
      await new Promise<void>((resolve, reject) => {
        exec(fastCmd, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    
    if (fs.existsSync(tempOutPath)) {
      fs.renameSync(tempOutPath, videoPath);
      pipelineLogger.info(`Video optimized successfully: ${videoPath}`, "DirectUploader");
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
    } = pending;

    // CC-BY tracks (Kevin MacLeod / incompetech) legally require attribution
    const musicFile =
      pending.lastMusicTrack || pending.context.selectedMusicTrack;
    if (
      musicFile &&
      path.basename(musicFile).startsWith("Kevin_MacLeod_") &&
      !metadata.description.includes("Kevin MacLeod")
    ) {
      const trackName = path
        .basename(musicFile, path.extname(musicFile))
        .replace(/^Kevin_MacLeod_/, "")
        .replace(/_/g, " ");
      metadata.description += `\n\nMusic: "${trackName}" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0: https://creativecommons.org/licenses/by/4.0/`;
    }

    // Remove the inline buttons from the review message
    await this.telegram.removeInlineButtons(chatId, reviewMessageId);

    await this.telegram.sendMessage(
      chatId,
      `🚀 *Uploading to ${this.profile.youtube.channels.length} YouTube channel(s) and ${this.profile.instagram.accounts.length} Instagram account(s)…*`,
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
        .map((r) => `• *YouTube (${escapeMarkdown(r.channelName)}):* ${escapeMarkdown(r.url)}`)
        .join("\n");

      const instaLines = instaResults
        .map((r) => `• *Instagram (${escapeMarkdown(r.accountName)}):* ${escapeMarkdown(r.url)}`)
        .join("\n");

      // Per-channel failures return null and are filtered out — surface them
      // instead of implying every platform succeeded.
      const expectedYt = this.profile.youtube.channels.length;
      const expectedIg = this.profile.instagram.accounts.length;
      const failLines: string[] = [];
      if (expectedYt > 0 && results.length < expectedYt) {
        failLines.push(
          `⚠️ *YouTube upload FAILED on ${expectedYt - results.length} of ${expectedYt} channel(s)* — check logs`,
        );
      }
      if (expectedIg > 0 && instaResults.length < expectedIg) {
        failLines.push(
          `⚠️ *Instagram upload FAILED on ${expectedIg - instaResults.length} of ${expectedIg} account(s)* — check logs`,
        );
      }
      const failBlock = failLines.length ? failLines.join("\n") + "\n\n" : "";
      const headline =
        failLines.length === 0
          ? `✅ *Uploaded successfully!*`
          : `⚠️ *Upload partially failed*`;

      const successText =
        `${headline}\n\n` +
        failBlock +
        `*Title:* ${escapeMarkdown(metadata.title)}\n\n` +
        `${channelLines}\n` +
        `${instaLines}\n\n` +
        `*ID:* ${escapeMarkdown(id)}`;

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

        const messageId = await this.telegram.sendRawVideo(
          chatId,
          videoToSend,
          `*Title:* ${metadata.title}`,
        );

        let fullDescription = `*Description:*\n${metadata.description}`;
        
        if (metadata.factCheckScore !== undefined) {
          fullDescription += `\n\n*Fact Check Score:* ${metadata.factCheckScore}/10`;
        }
        if (metadata.verdict) {
          fullDescription += `\n*Verdict:* ${metadata.verdict}`;
        }
        if (fullDescription.length > 4000) {
          fullDescription = fullDescription.substring(0, 4000) + '...';
        }
        
        await this.telegram.sendMessage(
          chatId,
          fullDescription,
          messageId
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

  private async onToggleVoiceover(id: string) {
    const job = this.db.getJob(id);
    // Only allow toggling voiceover during final review
    if (!job || job.status !== "final_review") return;
    
    // Determine which video to show
    const tempDir = job.context.tempDir;
    const finalNoVoicePath = path.join(tempDir, "video_final_no_voice.mp4");
    const finalVoicePath = path.join(tempDir, "video_final_voice.mp4");

    // Auto-publish renders only the selected variant (video_final.mp4); the
    // voice/no-voice pair only exists after a Replace Music re-mix.
    if (!fs.existsSync(finalNoVoicePath) && !fs.existsSync(finalVoicePath)) {
      const pendingEntry = this.pending.get(id);
      if (pendingEntry) {
        await this.telegram
          .sendMessage(
            pendingEntry.chatId,
            `🔇 *Voiceover toggle unavailable for this job* — send a text prompt to regenerate with different settings instead.`,
            pendingEntry.reviewMessageId,
          )
          .catch(() => {});
      }
      return;
    }

    // Toggle the voiceover flag
    job.context.useVoiceover = !job.context.useVoiceover;

    const finalVideoPath = job.context.useVoiceover && fs.existsSync(finalVoicePath) 
      ? finalVoicePath 
      : finalNoVoicePath;
      
    // Update the output file for final publishing
    const metadata = job.context.metadata!;
    const safeTitle = metadata.title
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 60);
    const outputFileName = `${safeTitle}_${id}.mp4`;
    const outputFilePath = path.join(config.paths.outputDir, outputFileName);
    fs.copyFileSync(finalVideoPath, outputFilePath);

    // Update the pending object in memory so the publisher uses the right video
    const pending = this.pending.get(id);
    if (pending) {
      pending.finalVideoPath = finalVideoPath;
    }

    // Update context in DB
    this.db.updateJob(id, { context: job.context });
    
    // Update the message to indicate status
    const statusText = job.context.useVoiceover ? "🔊 Voiceover: **ON**" : "🔇 Voiceover: **OFF**";
    const fallbackWarningLine = job.context.metadataIsFallback
      ? `❌ *AI metadata FAILED — generic template in use. Tap 🔄 Regenerate!*\n\n`
      : "";
    const caption =
      `📋 *Review your Short*\n\n` +
      fallbackWarningLine +
      `*Title:* ${escapeMarkdown(metadata.title)}\n\n` +
      `*Description:* ${escapeMarkdown(metadata.description.slice(0, 200))}…\n\n` +
      statusText + `\n\n` +
      `⏳ _Waiting for review action..._`;

    if (job.context.telegramMeta.messageId) {
      // Compress if needed for Telegram
      let reviewVideoPath = finalVideoPath;
      const stats = fs.statSync(finalVideoPath);
      if (stats.size > 45 * 1024 * 1024) {
        pipelineLogger.info("Video exceeds 45MB. Compressing for Telegram...", "DirectUploader");
        reviewVideoPath = path.join(tempDir, "video_compressed.mp4");
        await new Promise<void>((resolve, reject) => {
          const ffmpegCmd = `${config.binaries.ffmpeg} -y -i "${finalVideoPath}" -vcodec libx264 -crf 28 -preset fast -c:a copy -movflags +faststart "${reviewVideoPath}"`;
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

      await this.telegram.editReviewVideo(
        job.context.telegramMeta.chatId,
        job.context.telegramMeta.messageId,
        reviewVideoPath,
        caption,
        id
      );
    }
  }

  // ── Pre-processing settings review gate ────────────────────────────────────

  private buildSettingsReviewText(context: PipelineContext): string {
    const rec = context.aiRecommendedSettings;
    const mood = context.metadata?.mood || "other";
    const captionSource = context.transcript?.words?.length
      ? "Whisper transcript"
      : context.metadata?.voiceoverScript
        ? "Voiceover script"
        : "None available";
    return (
      `🛠 *Review Processing Settings*\n\n` +
      `🎭 *Mood:* ${escapeMarkdown(mood)}\n` +
      `✍️ *Creator text detected:* ${context.creatorTextDetected ? "Yes" : "No"}\n` +
      `🔊 *Original audio present:* ${context.hasOriginalAudio ? "Yes" : "No"}\n` +
      `💬 *Caption source:* ${captionSource}\n` +
      `✂️ *AI suggested crop:* top ${rec?.cropTopPct ?? 0}% / bottom ${rec?.cropBottomPct ?? 0}%\n\n` +
      `⏳ _Auto-starts in 60s with the settings below. Any tap resets the timer._`
    );
  }

  /**
   * Show the settings review message and park the pipeline until the user acts
   * or the 60s timer fires. Resolves "proceed" (process with context.reviewSettings),
   * "cancel", or "restart" (a text prompt asked for regeneration).
   */
  private async holdForSettingsReview(
    context: PipelineContext,
  ): Promise<"proceed" | "cancel" | "restart"> {
    // Re-entry from the failure-path manual review: settings were already chosen.
    if (context.settingsReviewDone) return "proceed";

    const id = context.id;
    const { chatId, messageId } = context.telegramMeta;

    if (!context.reviewSettings) {
      context.reviewSettings = {
        ...(context.aiRecommendedSettings ?? {
          voiceover: !!context.metadata?.voiceoverScript,
          originalAudio: !!context.hasOriginalAudio,
          music: !context.hasOriginalAudio,
          captions: false,
          cropTopPct: 0,
          cropBottomPct: 0,
          sticker: false,
        }),
      };
    }

    // First-frame preview with the crop grid so the user can judge the crop
    // buttons against the actual content (labels sit on the grid lines).
    const previewSource = context.isVideo
      ? path.join(context.tempDir, "frame_0.jpg")
      : context.originalImagePath;
    const previewImagePath = await buildGridPreview(
      previewSource,
      path.join(context.tempDir, "settings_preview.png"),
    );

    const reviewMessageId = await this.telegram.sendSettingsReview(
      chatId,
      this.buildSettingsReviewText(context),
      id,
      context.reviewSettings,
      messageId,
      previewImagePath ?? undefined,
    );
    (context as any).settingsReviewMessageId = reviewMessageId;

    this.db.updateJob(id, {
      status: "settings_review",
      currentStep: "Waiting for settings confirmation (60s)",
      context,
    });

    pipelineLogger.info(
      `Holding pipeline ${id} for 60s settings review...`,
      "DirectUploader",
    );

    return new Promise((resolve) => {
      this.pendingSettingsReviews.set(id, {
        context,
        resolve,
        timer: setTimeout(() => {
          pipelineLogger.info(
            `Settings review timeout for ${id} — proceeding with current settings.`,
            "DirectUploader",
          );
          this.onSettingsAction("go", id);
        }, 60000),
        reviewMessageId,
        chatId,
        messageId,
      });
    });
  }

  /** Handles st_* button taps (and the 60s timeout, which fires "go"). */
  private onSettingsAction(code: string, id: string): void {
    const entry = this.pendingSettingsReviews.get(id);
    if (!entry) return;
    const settings = entry.context.reviewSettings!;

    if (code === "go") {
      clearTimeout(entry.timer);
      this.pendingSettingsReviews.delete(id);
      this.telegram
        .removeInlineButtons(entry.chatId, entry.reviewMessageId)
        .catch(() => {});
      this.telegram
        .sendMessage(
          entry.chatId,
          `▶️ *Processing with selected settings…*`,
          entry.reviewMessageId,
        )
        .catch(() => {});
      entry.resolve("proceed");
      return;
    }

    if (code === "can") {
      clearTimeout(entry.timer);
      this.pendingSettingsReviews.delete(id);
      this.telegram
        .removeInlineButtons(entry.chatId, entry.reviewMessageId)
        .catch(() => {});
      this.telegram
        .sendMessage(
          entry.chatId,
          `❌ *Generation cancelled by user.*`,
          entry.reviewMessageId,
        )
        .catch(() => {});
      this.db.updateJob(id, {
        status: "failed",
        currentStep: "Generation cancelled by user during settings review",
        context: entry.context,
      });
      entry.resolve("cancel");
      return;
    }

    if (code === "vo") settings.voiceover = !settings.voiceover;
    else if (code === "oa") settings.originalAudio = !settings.originalAudio;
    else if (code === "mu") settings.music = !settings.music;
    else if (code === "cc") settings.captions = !settings.captions;
    else if (code === "sk") settings.sticker = !settings.sticker;
    else if (/^ct(0|5|10|15|20|25)$/.test(code)) {
      settings.cropTopPct = parseInt(code.slice(2), 10);
    } else if (/^cb(0|5|10|15|20|25)$/.test(code)) {
      settings.cropBottomPct = parseInt(code.slice(2), 10);
    } else {
      return; // unknown code
    }

    // Every adjustment resets the 60s auto-start timer
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      pipelineLogger.info(
        `Settings review timeout for ${id} — proceeding with current settings.`,
        "DirectUploader",
      );
      this.onSettingsAction("go", id);
    }, 60000);

    this.telegram
      .updateSettingsReview(
        entry.chatId,
        entry.reviewMessageId,
        this.buildSettingsReviewText(entry.context),
        id,
        settings,
      )
      .catch(() => {});
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
        // Update stored metadata (regeneration succeeded — clear fallback flag)
        pending.context.metadataIsFallback = false;
        pending.metadata = metadata;

        const caption =
          `📋 *Review your Short* _(updated)_\n\n` +
          `*Title:* ${metadata.title}\n\n` +
          `*Description:* ${metadata.description.slice(0, 200)}…\n\n` +
          (pending.musicCaptionLine || "") +
          `⏳ _Auto-publishes in 2 minutes if no action taken._`;

        await this.telegram.updateReviewCaption(
          pending.chatId,
          pending.reviewMessageId,
          caption,
          id,
        );
      })
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        pipelineLogger.error(`Regenerate failed for ${id}`, err, "DirectUploader");
        await this.telegram.sendMessage(
          pending.chatId,
          `❌ *Metadata regeneration failed* (FreeLLMAPI, model: auto)\n` +
            `\`${msg.replace(/`/g, "'").slice(0, 200)}\`\n\n` +
            `_The previous title/description is unchanged. Tap 🔄 Regenerate to try again._`,
          pending.reviewMessageId,
        );
      });
  }

  /**
   * Caption line describing the track just mixed in by MusicService and its
   * AcoustID copyright-risk score, e.g.
   * "🎵 *Music:* energy-boost.mp3 — ©️ risk 1/10"
   */
  private async buildMusicCaptionLine(specificTrack?: string): Promise<string> {
    const track = specificTrack || this.music.lastSelectedTrack;
    if (!track) return "";
    const risk = await getCopyrightRisk(track);
    return `🎵 *Music:* ${escapeMarkdown(path.basename(track))} — ${escapeMarkdown(formatRisk(risk))}\n\n`;
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
        .map((r) => `• *${escapeMarkdown(r.channelName)}* (Deleted)`)
        .join("\n");
      const failedLines = failedDeletions
        .map(
          (r) =>
            `• *${escapeMarkdown(r.channelName)}* (Failed to delete - ID: \`${escapeMarkdown(r.videoId)}\`)`,
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

    if (isVideo && context.originalVideoPath && fs.existsSync(context.originalVideoPath)) {
      try {
        await this.optimizeAndTrimVideo(context.originalVideoPath);
      } catch (optErr) {
        pipelineLogger.warn(
          `Failed to optimize and trim video: ${optErr instanceof Error ? optErr.message : optErr}`,
          "DirectUploader"
        );
      }
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


      let keyframePaths: string[] = [];
      const f0 = path.join(tempDir, "frame_0.jpg");
      const f25 = path.join(tempDir, "frame_25.jpg");
      const f50 = path.join(tempDir, "frame_50.jpg");
      const f75 = path.join(tempDir, "frame_75.jpg");

      // If video, extract 4 keyframes at 0% (t=0.5s floor), 25%, 50%, and 75% of video duration in parallel.
      if (isVideo && context.originalVideoPath) {
        context.status = "analyzing";
        if (fs.existsSync(f0) && fs.existsSync(f25) && fs.existsSync(f50) && fs.existsSync(f75)) {
          keyframePaths = [f0, f25, f50, f75];
          if (!fs.existsSync(originalImagePath)) {
            fs.copyFileSync(f0, originalImagePath);
          }
          pipelineLogger.info("Reusing existing keyframes from tempDir.", "DirectUploader");
          try {
            await TranscriptionService.transcribe(context);
          } catch (txErr) {
            pipelineLogger.warn(
              `Transcription failed on keyframe reuse path: ${txErr instanceof Error ? txErr.message : txErr}`,
              "DirectUploader"
            );
            context.transcript = null;
          }
        } else {
          try {
            // Determine duration using ffprobe
            let duration = 0;
            const ffprobeCmd = `"${config.binaries.ffprobe}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${context.originalVideoPath}"`;
            const stdout = execSync(ffprobeCmd).toString().trim();
            duration = parseFloat(stdout);
            if (isNaN(duration) || duration <= 0) {
              throw new Error("Invalid duration parsed: " + stdout);
            }

            const t0 = Math.max(0.5, 0.0 * duration);
            const t25 = 0.25 * duration;
            const t50 = 0.5 * duration;
            const t75 = 0.75 * duration;

            const extractFrame = (ss: number, outPath: string): Promise<void> => {
              const cmd = `"${config.binaries.ffmpeg || "ffmpeg"}" -y -ss ${ss.toFixed(3)} -i "${context.originalVideoPath}" -vframes 1 -q:v 2 "${outPath}"`;
              return new Promise((resolve, reject) => {
                exec(cmd, (err) => {
                  if (err) reject(err);
                  else resolve();
                });
              });
            };

            await Promise.all([
              extractFrame(t0, f0),
              extractFrame(t25, f25),
              extractFrame(t50, f50),
              extractFrame(t75, f75),
              TranscriptionService.transcribe(context).catch((txErr) => {
                pipelineLogger.warn(
                  `Transcription failed in parallel: ${txErr instanceof Error ? txErr.message : txErr}`,
                  "DirectUploader"
                );
                context.transcript = null;
              })
            ]);

            keyframePaths = [f0, f25, f50, f75];
            // Copy frame_0.jpg to originalImagePath so downstream code has a valid image to analyze/edit
            fs.copyFileSync(f0, originalImagePath);
            pipelineLogger.info("Successfully extracted 4 keyframes in parallel.", "DirectUploader");
          } catch (err) {
            pipelineLogger.warn(
              `Keyframe extraction failed: ${err instanceof Error ? err.message : err}. Falling back to original.jpg at 1.0s.`,
              "DirectUploader"
            );
            // Fall back to original.jpg at 1.0s
            const extractCmd = `"${config.binaries.ffmpeg || "ffmpeg"}" -y -ss 00:00:01 -i "${context.originalVideoPath}" -vframes 1 -q:v 2 "${originalImagePath}"`;
            await new Promise<void>((resolve, reject) => {
              exec(extractCmd, (err) => {
                if (err) {
                  const fallbackCmd = `"${config.binaries.ffmpeg || "ffmpeg"}" -y -ss 00:00:00 -i "${context.originalVideoPath}" -vframes 1 -q:v 2 "${originalImagePath}"`;
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
        }
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
      try {
        if (!context.metadata || !context.brandingDetection) {
          const visionInput = keyframePaths.length > 0 ? keyframePaths : originalImagePath;
          await this.runUnifiedAiVision(visionInput, context);
        }
      } finally {
        const audioWavPath = path.join(tempDir, "audio.wav");
        if (fs.existsSync(audioWavPath)) {
          try {
            fs.unlinkSync(audioWavPath);
            pipelineLogger.info("Cleaned up audio.wav after AI call.", "DirectUploader");
          } catch (cleanupErr) {
            pipelineLogger.warn(
              `Failed to clean up audio.wav: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`,
              "DirectUploader"
            );
          }
        }
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

      // Override with caption-provided metadata only if there's no active user prompt adjustment.
      // Skip for Instagram/TikTok reels: their captionMetadata is the ORIGINAL post caption,
      // which is only extra context for the AI prompt — not a verbatim title/description.
      if (context.captionMetadata && !context.userPrompt && !context.instagramSource) {
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
            this.profile.handle.replace("@", ""),
          ],
        };
        pipelineLogger.checkpoint(
          "Caption metadata override loaded",
          true,
          `"${context.metadata.title}"`,
        );
      }

      // ── PRE-PROCESSING SETTINGS REVIEW GATE ──────────────────────────────
      // AI has analyzed the media; let the user confirm/override the processing
      // settings (or let the 60s timer proceed with the AI recommendation).
      const gateDecision = await this.holdForSettingsReview(context);
      if (gateDecision === "cancel") {
        return;
      }
      if (gateDecision === "restart") {
        // handleUserTextPrompt re-runs the pipeline with the new prompt
        return;
      }
      context.settingsReviewDone = true;
      context.useVoiceover = !!(
        context.reviewSettings?.voiceover && context.metadata?.voiceoverScript
      );

      // Kick off TTS in parallel with the video render (the image branch
      // generates it synchronously because it needs the duration up front).
      let ttsPromise: Promise<number> | undefined;
      if (context.useVoiceover && isVideo) {
        pipelineLogger.info(
          "Kicking off TTS generation asynchronously...",
          "DirectUploader",
        );
        ttsPromise = this.tts.generateVoiceover(
          context.metadata!.voiceoverScript!,
          path.join(tempDir, "voiceover.mp3"),
          this.profile.key,
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

        // 2a — Cover other branding zones (logo, watermark, handle, profile_name, other) on the static image
        // with a brand badge (black bg + yellow handle text) instead of blurring (excluding original_captions)
        const otherZones = context.brandingDetection?.zones.filter(
          (z) =>
            z.type !== "main_post_content" &&
            (z.type as string) !== "original_captions",
        );
        if (otherZones && otherZones.length > 0) {
          try {
            pipelineLogger.info(
              `Covering ${otherZones.length} branding zones with ${this.profile.brandName} badge on static image...`,
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

                // Small padding so the badge fully hides the watermark underneath
                const pad = Math.max(4, Math.round(h * 0.15));
                const safeX = Math.max(0, Math.min(meta.width - 10, x - pad));
                const safeY = Math.max(0, Math.min(meta.height - 10, y - pad));
                const safeW = Math.max(
                  40,
                  Math.min(meta.width - safeX, w + pad * 2),
                );
                const safeH = Math.max(
                  20,
                  Math.min(meta.height - safeY, h + pad * 2),
                );

                // Badge: dark rounded pill with yellow border + channel handle text
                const label = this.profile.handle;
                // Scale font to fit both the zone height and width (~0.62em avg glyph width)
                const fontSize = Math.floor(
                  Math.min(safeH * 0.6, (safeW * 0.85) / (label.length * 0.62)),
                );
                const rx = Math.min(safeH / 2, 14);
                const textY = Math.round(safeH / 2 + fontSize * 0.35);
                const badgeSvg = `<svg width="${safeW}" height="${safeH}" viewBox="0 0 ${safeW} ${safeH}" xmlns="http://www.w3.org/2000/svg">
                  <rect x="1" y="1" width="${safeW - 2}" height="${safeH - 2}" rx="${rx}" fill="#0B0B0B" fill-opacity="0.95" stroke="#FFB800" stroke-width="1.5" stroke-opacity="0.85"/>
                  <text x="${safeW / 2}" y="${textY}" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif" font-size="${fontSize}" font-weight="800" fill="#FFB800" text-anchor="middle" letter-spacing="0.5">${label}</text>
                </svg>`;

                const badgeBuf = await sharp(Buffer.from(badgeSvg))
                  .png()
                  .toBuffer();

                composites.push({
                  input: badgeBuf,
                  left: safeX,
                  top: safeY,
                });
              }

              if (composites.length > 0) {
                const brandedTemp = path.join(tempDir, "original_branded.jpg");
                await sharp(originalImagePath)
                  .composite(composites)
                  .toFile(brandedTemp);

                fs.copyFileSync(brandedTemp, originalImagePath);
                try {
                  fs.unlinkSync(brandedTemp);
                } catch {}
                pipelineLogger.checkpoint(
                  "Static image branding zones covered with brand badge",
                  true,
                );
              }
            }
          } catch (err) {
            pipelineLogger.error(
              "Failed to cover static image branding zones",
              err,
              "DirectUploader",
            );
          }
        }

        // 2b — Blur outer areas of main_post_content if detected by the AI vision model (useful for screenshots of posts)
        const mainContentZone = context.brandingDetection?.zones.find(
          (z) => z.type === "main_post_content",
        );
        const p = (context.userPrompt || "").toLowerCase();
        const wantsFocus = p.includes("crop") || p.includes("focus") || p.includes("blur") || p.includes("remove chrome");

        if (mainContentZone && wantsFocus) {
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
        let finalDuration = config.rendering.videoDurationSeconds;
        let voiceoverPath: string | undefined = undefined;

        if (context.useVoiceover && context.metadata?.voiceoverScript) {
          if (context.ttsDuration && (context as any).voiceoverPath) {
            // TTS was already generated on a previous run of this job
            finalDuration = context.ttsDuration;
            voiceoverPath = (context as any).voiceoverPath;
          } else {
            // Image jobs need the audio duration before rendering, so generate synchronously
            try {
              const tempVoiceoverPath = path.join(tempDir, "voiceover.mp3");
              finalDuration = await this.tts.generateVoiceover(context.metadata.voiceoverScript, tempVoiceoverPath, this.profile.key);
              voiceoverPath = tempVoiceoverPath;
              (context as any).voiceoverPath = voiceoverPath;
              context.ttsDuration = finalDuration;
            } catch (err) {
              pipelineLogger.error("Failed to generate voiceover synchronously, proceeding without it", err, "DirectUploader");
            }
          }
        }

        await this.renderer.renderImageToVideo(
          originalImagePath,
          rawVideoPath,
          {
            durationSeconds: finalDuration,
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
          const viralPatterns = this.viralAnalyzer.getViralPatterns(
            this.theme.noHistoryHint,
          );
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

      // Await the TTS kicked off in parallel with the render
      if (ttsPromise) {
        pipelineLogger.info(
          `Awaiting parallel TTS generation for job ${id}...`,
          "DirectUploader",
        );
        try {
          const duration = await ttsPromise;
          context.ttsDuration = duration;
          (context as any).voiceoverPath = path.join(tempDir, "voiceover.mp3");
        } catch (err) {
          pipelineLogger.error(
            "Background TTS generation failed",
            err,
            "DirectUploader",
          );
        }
      }

      // ── COMPILE + AUTO-PUBLISH ─────────────────────────────────────────────
      await this.compileAndPublish(context);
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

  /**
   * Compile the final video according to context.reviewSettings, then publish
   * automatically. On any compile/mix error, fall back to the manual review
   * flow (existing Publish/Cancel/Regenerate buttons) if a playable video exists.
   */
  private async compileAndPublish(context: PipelineContext): Promise<void> {
    const id = context.id;
    const tempDir = context.tempDir;
    const metadata = context.metadata!;
    const rawVideoPath = path.join(tempDir, "video_raw.mp4");
    const chatId = context.telegramMeta.chatId;
    const messageId = context.telegramMeta.messageId;
    const settings = context.reviewSettings!;

    try {
      this.db.updateJob(id, {
        status: "adding_music",
        currentStep: "Compiling video and mixing audio",
        context,
      });

      // Music selection honours the settings-review toggle
      if (settings.music) {
        context.selectedMusicTrack = this.music.selectLocalTrack(
          config.paths.musicDir,
          context.metadata?.mood,
        );
      } else {
        context.selectedMusicTrack = undefined;
      }

      const voiceoverPath = (context as any).voiceoverPath;
      const useVoice = !!(
        context.useVoiceover &&
        voiceoverPath &&
        fs.existsSync(voiceoverPath)
      );
      const musicTrack =
        context.selectedMusicTrack && fs.existsSync(context.selectedMusicTrack)
          ? context.selectedMusicTrack
          : undefined;

      // 0 — Overlay the mood-matched reaction sticker (video-only pass, same
      // -c:v copy constraint as captions below — must happen before any
      // audio-mix step that copies the video stream unfiltered).
      let mixInputPath = rawVideoPath;
      if (settings.sticker) {
        const stickeredPath = await this.overlayReactionSticker(context, mixInputPath);
        if (stickeredPath) mixInputPath = stickeredPath;
      }

      // 1 — Burn captions in a dedicated video-filter pass (the audio mixes all
      // use -c:v copy and cannot carry a filter). The voiceover+no-music hook
      // branch burns its own subtitles, so skip pre-burning for that case.
      const captionsInHookBranch = useVoice && !musicTrack;
      if (settings.captions && !captionsInHookBranch) {
        const captionedPath = await this.burnCaptions(context, mixInputPath, useVoice);
        if (captionedPath) mixInputPath = captionedPath;
      }

      // 2 — Strip the original audio first when the user turned it OFF
      let baseVideoPath = mixInputPath;
      if (!settings.originalAudio) {
        const mutedPath = path.join(tempDir, "video_muted.mp4");
        await new Promise<void>((resolve, reject) => {
          const muteCmd = `${config.binaries.ffmpeg} -y -i "${mixInputPath}" -an -c:v copy "${mutedPath}"`;
          exec(muteCmd, (error) => (error ? reject(error) : resolve()));
        });
        baseVideoPath = mutedPath;
      }

      // 3 — Audio mix matrix (voiceover / original audio / music)
      const finalVideoPath = path.join(tempDir, "video_final.mp4");
      if (musicTrack) {
        pipelineLogger.info(
          `Mixing background music${useVoice ? " + voiceover" : ""}: ${musicTrack}`,
          "DirectUploader",
        );
        await this.music.addBackgroundMusic(
          baseVideoPath,
          config.paths.musicDir,
          finalVideoPath,
          context.metadata?.mood,
          true, // forceReplace
          undefined,
          musicTrack,
          useVoice ? voiceoverPath : undefined,
        );
      } else if (useVoice) {
        await this.renderVoiceoverHook(
          context,
          baseVideoPath,
          voiceoverPath,
          finalVideoPath,
          settings.captions,
        );
      } else {
        fs.copyFileSync(baseVideoPath, finalVideoPath);
      }

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

      // 5 — Auto-publish
      pipelineLogger.checkpoint(
        "Compilation complete — auto-publishing",
        true,
        id,
      );
      const pendingUpload: PendingUpload = {
        id,
        chatId,
        messageId,
        reviewMessageId:
          (context as any).settingsReviewMessageId ?? messageId,
        metadata,
        finalVideoPath,
        outputFilePath,
        outputFileName,
        originalImagePath: context.originalImagePath,
        context,
        lastMusicTrack: context.selectedMusicTrack,
      };
      this.pending.set(id, pendingUpload);
      await this.uploadAndReport(pendingUpload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pipelineLogger.error(
        `Compile/auto-publish failed for ${id} — falling back to manual review`,
        err,
        "DirectUploader",
      );

      const fallbackCandidates = [
        path.join(tempDir, "video_final.mp4"),
        rawVideoPath,
      ];
      const playable = fallbackCandidates.find((p) => fs.existsSync(p));
      if (playable) {
        try {
          await this.sendForManualReview(
            context,
            playable,
            `⚠️ *Auto-publish aborted:* \`${escapeMarkdown(msg.slice(0, 200))}\` — review manually.\n\n`,
          );
          return;
        } catch (reviewErr) {
          pipelineLogger.error(
            "Manual-review fallback failed",
            reviewErr,
            "DirectUploader",
          );
        }
      }

      await this.telegram.sendMessage(
        chatId,
        `❌ *Video compilation failed:* \`${msg.slice(0, 300)}\``,
        messageId,
      );
      this.db.updateJob(id, {
        status: "failed",
        currentStep: "Video compilation failed",
        error: msg,
        context,
      });
      this.resolveJob(id);
    }
  }

  /**
   * Overlay the mood-matched reaction sticker (a pre-recorded, background-removed
   * clip stored at assets/stickers/<mood>.mov with a real alpha channel) in the
   * bottom-left corner — opposite the watermark badge, which sits bottom-right.
   * The sticker's own audio is intentionally not mixed in (video-only overlay);
   * `eof_action=pass` means it plays once and disappears rather than freezing
   * on its last frame for the rest of the video. Returns the composited path,
   * or null when no sticker asset exists yet for this mood.
   */
  private async overlayReactionSticker(
    context: PipelineContext,
    inputPath: string,
  ): Promise<string | null> {
    const mood = normalizeMood(context.metadata?.mood);
    const stickerPath = path.join(config.paths.assetsDir, "stickers", `${mood}.mov`);
    if (!fs.existsSync(stickerPath)) {
      pipelineLogger.info(
        `Reaction sticker requested but none available for mood "${mood}" — skipping.`,
        "DirectUploader",
      );
      return null;
    }

    const outPath = path.join(context.tempDir, "video_stickered.mp4");
    const cmd = `${config.binaries.ffmpeg} -y -i "${inputPath}" -i "${stickerPath}" -filter_complex "[0:v][1:v]overlay=40:H-h-40:eof_action=pass[out]" -map "[out]" -map 0:a? -c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p -c:a copy "${outPath}"`;
    try {
      await new Promise<void>((resolve, reject) => {
        exec(cmd, (error) => (error ? reject(error) : resolve()));
      });
      pipelineLogger.info(`Overlaid "${mood}" reaction sticker.`, "DirectUploader");
      return outPath;
    } catch (err) {
      pipelineLogger.warn(
        `Reaction sticker overlay failed, continuing without it: ${err instanceof Error ? err.message : err}`,
        "DirectUploader",
      );
      return null;
    }
  }

  /**
   * Burn timed subtitles onto the video in a standalone pass. Caption text comes
   * from the voiceover script (estimated timings) when a voiceover is in use,
   * otherwise from the Whisper transcript (real word timings). Returns the
   * captioned file path, or null when no caption source is available.
   */
  private async burnCaptions(
    context: PipelineContext,
    inputPath: string,
    useVoice: boolean,
  ): Promise<string | null> {
    const tempDir = context.tempDir;
    try {
      let wordTimings: Array<{ word: string; start: number; end: number }> = [];
      if (useVoice && context.metadata?.voiceoverScript) {
        wordTimings = estimateWordTimings(
          context.metadata.voiceoverScript,
          context.ttsDuration || 10,
        );
      } else if (context.transcript?.words?.length) {
        wordTimings = context.transcript.words;
      } else if (context.transcript?.text) {
        let duration = 15;
        try {
          const stdout = execSync(
            `"${config.binaries.ffprobe}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
          )
            .toString()
            .trim();
          const parsed = parseFloat(stdout);
          if (!isNaN(parsed) && parsed > 0) duration = parsed;
        } catch {}
        wordTimings = estimateWordTimings(context.transcript.text, duration);
      }

      if (!wordTimings.length) {
        pipelineLogger.info(
          "Captions requested but no transcript or voiceover script available — skipping captions.",
          "DirectUploader",
        );
        return null;
      }

      const assPath = path.join(tempDir, "captions.ass");
      generateASSFile(groupWordsIntoLines(wordTimings), assPath);

      const escapedAssPath = assPath
        .replace(/\\/g, "/")
        .replace(/:/g, "\\:")
        .replace(/'/g, "'\\\\''");
      const outPath = path.join(tempDir, "video_raw_captioned.mp4");
      const cmd = `${config.binaries.ffmpeg} -y -i "${inputPath}" -vf "subtitles='${escapedAssPath}'" -c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p -c:a copy "${outPath}"`;
      await new Promise<void>((resolve, reject) => {
        exec(cmd, (error) => (error ? reject(error) : resolve()));
      });
      pipelineLogger.info("Burned timed captions onto video.", "DirectUploader");
      return outPath;
    } catch (err) {
      pipelineLogger.warn(
        `Caption burn failed, continuing without captions: ${err instanceof Error ? err.message : err}`,
        "DirectUploader",
      );
      return null;
    }
  }

  /**
   * Voiceover without background music: render a hook segment (voiceover mixed
   * over the input audio, optional burned subtitles) and concatenate it with
   * the full video — preserving the pre-existing hook+part2 structure.
   */
  private async renderVoiceoverHook(
    context: PipelineContext,
    inputPath: string,
    voiceoverPath: string,
    outputPath: string,
    includeCaptions: boolean,
  ): Promise<void> {
    const tempDir = context.tempDir;
    await new Promise<void>((resolve) => {
      const hookVideoPath = path.join(tempDir, "hook_video.mp4");

      // Determine if input video has an audio stream
      let hasAudio = false;
      try {
        const ffprobeCheck = execSync(
          `"${config.binaries.ffprobe}" -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${inputPath}"`,
        )
          .toString()
          .trim();
        hasAudio = ffprobeCheck === "audio";
      } catch (probeErr) {
        pipelineLogger.warn(
          "Failed to check video audio stream via ffprobe, assuming false",
          "DirectUploader",
        );
      }

      let hookCmd = "";
      const script = context.metadata?.voiceoverScript;
      if (script && includeCaptions) {
        try {
          const assPath = path.join(tempDir, "subtitles.ass");
          const duration = context.ttsDuration || 10;
          const wordTimings = estimateWordTimings(script, duration);
          const lines = groupWordsIntoLines(wordTimings);
          generateASSFile(lines, assPath);

          const escapedAssPath = assPath
            .replace(/\\/g, "/")
            .replace(/:/g, "\\:")
            .replace(/'/g, "'\\\\''");

          const fps = config.rendering.fps || 30;

          let filterComplex = "";
          if (hasAudio) {
            filterComplex = `[0:v]subtitles='${escapedAssPath}'[vout];[0:a]volume=0.18[a0];[1:a]volume=5.5[a1];[a0][a1]amix=inputs=2:duration=shortest[aout]`;
          } else {
            filterComplex = `[0:v]subtitles='${escapedAssPath}'[vout];[1:a]volume=5.5[aout]`;
          }

          hookCmd = `${config.binaries.ffmpeg} -y -i "${inputPath}" -i "${voiceoverPath}" -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p -r ${fps} -c:a aac -ar 44100 -ac 2 -shortest "${hookVideoPath}"`;
          pipelineLogger.info(
            `Rendering hook video with word-by-word subtitles (hasAudio=${hasAudio})...`,
            "DirectUploader",
          );
        } catch (subErr) {
          pipelineLogger.error(
            "Failed to generate ASS subtitles, falling back to plain hook mix",
            subErr,
            "DirectUploader",
          );
        }
      }

      if (!hookCmd) {
        let filterComplex = "";
        if (hasAudio) {
          filterComplex = `[0:a]volume=0.18[a0];[1:a]volume=5.5[a1];[a0][a1]amix=inputs=2:duration=shortest[aout]`;
        } else {
          filterComplex = `[1:a]volume=5.5[aout]`;
        }
        hookCmd = `${config.binaries.ffmpeg} -y -i "${inputPath}" -i "${voiceoverPath}" -filter_complex "${filterComplex}" -map 0:v:0 -map "[aout]" -c:v copy -c:a aac -ar 44100 -ac 2 -shortest "${hookVideoPath}"`;
      }

      exec(hookCmd, (error) => {
        if (error) {
          pipelineLogger.error(
            "Failed to generate hook video",
            error,
            "DirectUploader",
          );
          fs.copyFileSync(inputPath, outputPath);
          return resolve();
        }

        // Create part2 from the input with the exact same audio format
        const part2VideoPath = path.join(tempDir, "part2_video.mp4");
        const part2Cmd = `${config.binaries.ffmpeg} -y -i "${inputPath}" -c:v copy -c:a aac -ar 44100 -ac 2 "${part2VideoPath}"`;

        exec(part2Cmd, (part2Error) => {
          if (part2Error) {
            pipelineLogger.error(
              "Failed to prepare part 2 video",
              part2Error,
              "DirectUploader",
            );
            fs.copyFileSync(inputPath, outputPath);
            return resolve();
          }

          // Now concatenate the hook and the prepared part2 video
          const concatTxtPath = path.join(tempDir, "concat.txt");
          fs.writeFileSync(
            concatTxtPath,
            `file 'hook_video.mp4'\nfile 'part2_video.mp4'\n`,
          );

          const concatCmd = `${config.binaries.ffmpeg} -y -f concat -safe 0 -i "${concatTxtPath}" -c:v copy -c:a aac -movflags +faststart "${outputPath}"`;
          exec(concatCmd, (concatError) => {
            if (concatError) {
              pipelineLogger.error(
                "Failed to concatenate hook and full video",
                concatError,
                "DirectUploader",
              );
              fs.copyFileSync(inputPath, outputPath);
            }
            resolve();
          });
        });
      });
    });
  }

  /**
   * Failure path: send the video for manual review with the existing
   * Publish/Cancel/Regenerate buttons instead of auto-publishing.
   */
  private async sendForManualReview(
    context: PipelineContext,
    finalVideoPath: string,
    bannerLine: string,
  ): Promise<void> {
    const id = context.id;
    const tempDir = context.tempDir;
    const metadata = context.metadata!;
    const chatId = context.telegramMeta.chatId;
    const messageId = context.telegramMeta.messageId;

    fs.mkdirSync(config.paths.outputDir, { recursive: true });
    const safeTitle = metadata.title
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 60);
    const outputFileName = `${safeTitle}_${id}.mp4`;
    const outputFilePath = path.join(config.paths.outputDir, outputFileName);
    fs.copyFileSync(finalVideoPath, outputFilePath);

    // Telegram has a 50MB limit. Compress if > 45MB to be safe.
    let reviewVideoPath = finalVideoPath;
    const stats = fs.statSync(finalVideoPath);
    if (stats.size > 45 * 1024 * 1024) {
      pipelineLogger.info(
        "Video exceeds 45MB. Compressing for Telegram...",
        "DirectUploader",
      );
      reviewVideoPath = path.join(tempDir, "video_compressed.mp4");
      await new Promise<void>((resolve, reject) => {
        const ffmpegCmd = `${config.binaries.ffmpeg} -y -i "${finalVideoPath}" -vcodec libx264 -crf 28 -preset fast -c:a copy -movflags +faststart "${reviewVideoPath}"`;
        exec(ffmpegCmd, (error) => (error ? reject(error) : resolve()));
      });
    }

    const musicCaptionLine = await this.buildMusicCaptionLine(
      context.selectedMusicTrack,
    );
    const fallbackWarningLine = context.metadataIsFallback
      ? `❌ *AI metadata FAILED — generic template in use. Tap 🔄 Regenerate!*\n\n`
      : "";
    const caption =
      bannerLine +
      `📋 *Review your Short*\n\n` +
      fallbackWarningLine +
      `*Title:* ${escapeMarkdown(metadata.title)}\n\n` +
      `*Description:* ${escapeMarkdown(metadata.description.slice(0, 200))}…\n\n` +
      musicCaptionLine +
      `⏳ _Waiting for review action..._`;

    const reviewMessageId = await this.telegram.sendVideoForReview(
      chatId,
      reviewVideoPath,
      caption,
      id,
      messageId,
    );

    this.pending.set(id, {
      id,
      chatId,
      messageId,
      reviewMessageId,
      metadata,
      finalVideoPath,
      outputFilePath,
      outputFileName,
      originalImagePath: context.originalImagePath,
      context,
      lastMusicTrack: context.selectedMusicTrack,
      musicCaptionLine,
    });

    this.db.updateJob(id, {
      status: "final_review",
      currentStep: "Auto-publish aborted. Waiting for manual publish review.",
      context,
    });

    pipelineLogger.checkpoint(
      "Manual review sent to Telegram",
      true,
      `${id} — waiting for user publish/cancel`,
    );

    this.resolveJob(id);
  }

  private async handleUserTextPrompt(
    chatId: number,
    promptText: string,
    messageId: number,
  ): Promise<boolean> {
    // Find if there is a pending review or pending settings review in this chat
    let pendingId: string | null = null;
    let pendingUpload: any = null;
    let isSettingsReview = false;

    for (const [id, val] of this.pending.entries()) {
      if (val.chatId === chatId) {
        pendingId = id;
        pendingUpload = val;
        break;
      }
    }

    if (!pendingId || !pendingUpload) {
      for (const [id, val] of this.pendingSettingsReviews.entries()) {
        if (val.chatId === chatId) {
          pendingId = id;
          pendingUpload = val;
          isSettingsReview = true;
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

    // "crop top 10%"-style text must land in reviewSettings — calculateVideoCrop
    // prefers reviewSettings over the userPrompt regex once settings exist.
    if (context.reviewSettings) {
      const p = promptText.toLowerCase();
      const topMatch = p.match(
        /(?:crop\s+top\s+(\d+)\s*%|crop\s+(\d+)\s*%\s*from\s+top|crop\s+(\d+)\s*%\s*top)/,
      );
      if (topMatch) {
        const percent = parseInt(topMatch[1] || topMatch[2] || topMatch[3], 10);
        if (!isNaN(percent)) context.reviewSettings.cropTopPct = Math.min(100, percent);
      }
      const bottomMatch = p.match(
        /(?:crop\s+bottom\s+(\d+)\s*%|crop\s+(\d+)\s*%\s*from\s+bottom|crop\s+(\d+)\s*%\s*bottom)/,
      );
      if (bottomMatch) {
        const percent = parseInt(
          bottomMatch[1] || bottomMatch[2] || bottomMatch[3],
          10,
        );
        if (!isNaN(percent)) context.reviewSettings.cropBottomPct = Math.min(100, percent);
      }
    }

    // Delete old intermediate files to prevent caching
    try {
      for (const name of [
        "video_raw.mp4",
        "video_raw_captioned.mp4",
        "video_muted.mp4",
        "video_final.mp4",
      ]) {
        const p = path.join(context.tempDir, name);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch (_) {}

    // 5. Clean from pending map. For a parked settings review, release the gate
    // with "restart" so executePipeline returns and the re-run below takes over
    // (settingsReviewDone is still false, so the gate re-shows after re-analysis).
    if (isSettingsReview) {
      this.pendingSettingsReviews.delete(pendingId);
      pendingUpload.resolve("restart");
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

  private async handleUserAudioUpload(
    chatId: number,
    fileId: string,
    fileName: string,
    messageId: number,
  ): Promise<boolean> {
    // 1. Find if there is a pending review in this chat
    let pendingId: string | null = null;
    let pendingUpload: any = null;

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
      `User audio upload received for active generation ${pendingId}: "${fileName}"`,
      "DirectUploader",
    );

    // 2. Cancel the current auto-publish timer if it exists
    if (pendingUpload.timer) {
      clearTimeout(pendingUpload.timer);
    }

    // 3. Remove inline buttons from the old review message
    await this.telegram
      .removeInlineButtons(chatId, pendingUpload.reviewMessageId)
      .catch(() => {});

    // 4. Notify user that we are downloading and applying the new music track
    await this.telegram.sendMessage(
      chatId,
      `🎵 *Custom audio track received:* \`"${fileName}"\`\n\nDownloading and mixing with your Short...`,
      messageId,
    );

    const context = pendingUpload.context;
    const extension = path.extname(fileName) || ".mp3";
    const customMusicPath = path.join(context.tempDir, `custom_music${extension}`);

    try {
      // 5. Download the file
      await this.telegram.downloadFile(fileId, customMusicPath);
      context.selectedMusicTrack = customMusicPath;

      // 6. Regenerate the final video using the new custom music track!
      await this.regenerateAudioMix(pendingUpload);
      
      // 7. Resend the review message with the new audio mix
      await this.resendReviewVideo(pendingUpload);
      return true;
    } catch (err: any) {
      pipelineLogger.error(`Failed to handle user audio upload for ${pendingId}`, err, "DirectUploader");
      await this.telegram.sendMessage(
        chatId,
        `❌ *Failed to apply custom music:* ${err.message || err}`,
        messageId
      );
      return true;
    }
  }

  private async regenerateAudioMix(pendingUpload: any): Promise<void> {
    const { context } = pendingUpload;
    const tempDir = context.tempDir;
    // Prefer the caption-burned raw so a music replacement keeps subtitles
    const rawCaptionedPath = path.join(tempDir, "video_raw_captioned.mp4");
    const rawVideoPath = fs.existsSync(rawCaptionedPath)
      ? rawCaptionedPath
      : path.join(tempDir, "video_raw.mp4");
    const finalNoVoicePath = path.join(tempDir, "video_final_no_voice.mp4");
    const finalVoicePath = path.join(tempDir, "video_final_voice.mp4");
    const voiceoverPath = (context as any).voiceoverPath;

    pipelineLogger.info(`Regenerating audio mix for ${context.id}`, "DirectUploader");

    // 1. Re-mix finalNoVoicePath
    await this.music.addBackgroundMusic(
      rawVideoPath,
      config.paths.musicDir,
      finalNoVoicePath,
      context.metadata?.mood,
      true, // forceReplace
      undefined,
      context.selectedMusicTrack
    );

    // 2. Re-mix finalVoicePath
    if (voiceoverPath && fs.existsSync(voiceoverPath)) {
      await this.music.addBackgroundMusic(
        rawVideoPath,
        config.paths.musicDir,
        finalVoicePath,
        context.metadata?.mood,
        true, // forceReplace
        undefined,
        context.selectedMusicTrack,
        voiceoverPath
      );
    } else {
      fs.copyFileSync(finalNoVoicePath, finalVoicePath);
    }

    // 3. Update the finalized output file
    const finalVideoPath = context.useVoiceover && fs.existsSync(finalVoicePath) 
      ? finalVoicePath 
      : finalNoVoicePath;

    const safeTitle = context.metadata!.title
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 60);
    const outputFileName = `${safeTitle}_${context.id}.mp4`;
    const outputFilePath = path.join(config.paths.outputDir, outputFileName);
    fs.copyFileSync(finalVideoPath, outputFilePath);

    // 4. Update the pendingUpload object
    pendingUpload.finalVideoPath = finalVideoPath;
    pendingUpload.outputFilePath = outputFilePath;
    pendingUpload.outputFileName = outputFileName;
    pendingUpload.lastMusicTrack = context.selectedMusicTrack;
    pendingUpload.musicCaptionLine = await this.buildMusicCaptionLine(context.selectedMusicTrack);
  }

  private async resendReviewVideo(pendingUpload: any): Promise<void> {
    const { id, chatId, context, finalVideoPath, metadata } = pendingUpload;
    let reviewVideoPath = finalVideoPath;
    const stats = fs.statSync(finalVideoPath);
    if (stats.size > 45 * 1024 * 1024) {
      pipelineLogger.info("Video exceeds 45MB. Compressing for Telegram...", "DirectUploader");
      reviewVideoPath = path.join(context.tempDir, "video_compressed.mp4");
      await new Promise<void>((resolve, reject) => {
        const ffmpegCmd = `${config.binaries.ffmpeg} -y -i "${finalVideoPath}" -vcodec libx264 -crf 28 -preset fast -c:a copy -movflags +faststart "${reviewVideoPath}"`;
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

    const statusText = context.useVoiceover ? "🔊 Voiceover: **ON**" : "🔇 Voiceover: **OFF**";
    const fallbackWarningLine = context.metadataIsFallback
      ? `❌ *AI metadata FAILED — generic template in use. Tap 🔄 Regenerate!*\n\n`
      : "";
    const caption =
      `📋 *Review your Short*\n\n` +
      fallbackWarningLine +
      `*Title:* ${escapeMarkdown(metadata.title)}\n\n` +
      `*Description:* ${escapeMarkdown(metadata.description.slice(0, 200))}…\n\n` +
      statusText + `\n\n` +
      (pendingUpload.musicCaptionLine || "") +
      `⏳ _Waiting for review action..._`;

    const newMsgId = await this.telegram.editReviewVideo(
      chatId,
      pendingUpload.reviewMessageId,
      reviewVideoPath,
      caption,
      id
    );
    pendingUpload.reviewMessageId = newMsgId;
    this.db.updateJob(id, { context });
  }

  private resolveJob(id: string): void {
    const resolveFn = this.jobResolvers.get(id);
    if (resolveFn) {
      resolveFn();
      this.jobResolvers.delete(id);
    }
  }
}
