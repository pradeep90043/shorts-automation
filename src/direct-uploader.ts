import fs from "fs";
import { applyCreditLine, normalizeCreatorHandle } from "./utils/creatorCredit";
import path from "path";
import sharp from "sharp";
import { execSync } from "child_process";
import { exec } from "./utils/timedExec";
import { config, ChannelProfile } from "./config";
import { VideoRenderer, calculateVideoCrop } from "./renderer";
import { OcrService } from "./ocr";
import { MusicService, normalizeMood, ambientBedPath } from "./music";
import { YouTubeService, UploadResult } from "./youtube";
import { InstagramPublisher, InstagramUploadResult } from "./instagram/publisher";
import { FacebookPublisher, FacebookUploadResult } from "./facebook/publisher";
import { NotifyService, escapeMarkdown } from "./notify";
import { PipelineContext, VideoMetadata } from "./types";
import { pipelineLogger } from "./utils/logger";
import { howItWorksLines, renderHowItWorksClip } from "./my-video/howItWorksClip";
import { dropUnsupportedFigures, insightEnabledFor, insightIntro, insightLang, insightRuleFor, insightTitle, looksEnglish } from "./my-video/insightClip";
import { makeAsk } from "./longvideo-auto/llm";
import { toDevanagari } from "./audio/clonedVoice";
import { FreeLlmApiClient } from "./ai/freellmapi";
import { GeminiClient } from "./ai/gemini";
import { parseAiJson, extractJsonArrayField } from "./utils/json";
import { creatorZoneStore } from "./utils/creatorZones";
import { getFileHash } from "./utils/cache";
import { JobDatabase } from "./utils/db";
import { getStoredChannelConfig, StoredInstagramAccount, StoredYoutubeChannel } from "./utils/channelConfigStore";
import { getCopyrightRisk, formatRisk } from "./audio/copyrightCheck";
import { identifyAudio } from "./audio/shazam";
import { clearBackgroundMusic } from "./audio/audioClearance";
import { ReelHistoryStore } from "./utils/reelHistoryStore";

import { ViralAnalyzer } from "./utils/viral-analyzer";
import { JobQueue } from "./utils/queue";
import { ImageAnalyzer } from "./image-analysis";
import { TTSService } from "./audio/tts";
import { prepareScoreAudio } from "./audio/verdictNumber";
import { clonedVoiceEnabled, spokenText, startClonedLines } from "./audio/clonedVoice";
import { buildClonedCtaAudio, buildClonedVerdictAudio, STORIYUM_CTA_PARTS } from "./audio/clonedVerdict";
import { concatAudio } from "./audio/retime";
import { alignScriptToSpan, estimateWordTimings, groupWordsIntoLines, generateASSFile } from "./audio/subtitles";
import { TranscriptionService } from "./audio/transcription";
import { PexelsService } from "./video/pexelsService";
import { MultiSceneGenerator } from "./video/multiSceneGenerator";
import { renderShortCloud } from "./renderer/cloudShortRenderer";

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
      | "profile_picture"
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

/**
 * True only for reels a person injected from the dashboard, which wait for explicit
 * publish approval. Must NOT key off channelPinned: the Telegram ingestion path sets
 * that on every Instagram reel, including the channel watcher's auto-publish ones,
 * which silently disabled their auto-publish timer.
 */
export function isManualInjectContext(context: { channel?: string; id?: string }): boolean {
  return context.channel === "manual_inject" || !!context.id?.includes("inject");
}

export class DirectUploader {
  public static instances: DirectUploader[] = [];
  private freellmapi: FreeLlmApiClient | null = null;
  private gemini: GeminiClient = new GeminiClient();
  private renderer: VideoRenderer;
  private music: MusicService;
  private youtube: YouTubeService;
  private instagram: InstagramPublisher;
  private facebook: FacebookPublisher;
  private notify: NotifyService;
  private db: JobDatabase;
  public profile: ChannelProfile;
  private tts: TTSService;

  private get theme() {
    return this.profile.theme;
  }
  private get voiceoverPromptLanguage(): string {
    return this.profile.key.toLowerCase() === "codeorcap"
      ? "natural, professional English"
      : "Hinglish (a conversational mix of Hindi and English, written in English alphabet)";
  }

  /**
   * The voiceover script's spoken length must match the ACTUAL video
   * duration — otherwise the narration (and the captions timed off it)
   * runs out partway through and the rest of the video plays in silence.
   * When the real duration isn't known yet (e.g. image-only jobs), falls
   * back to the previous fixed ~10-15s/20-30-word guidance.
   */
  private buildVoiceoverLengthInstruction(context?: PipelineContext): string {
    const duration = context?.videoDurationSeconds;
    if (!duration || duration <= 0) {
      return "Write a short, highly engaging script containing no more than 20-25 words. CRITICAL: The script is a voiceover spoken to the audience. You MUST NEVER mention frame numbers (e.g., 'frame 1', 'frame 2'), 'slide', 'image', 'picture', or refer to the visual layout stages. Narrate the story or explain the code naturally as a single continuous flow of speech.";
    }
    // CodeOrCap: the English voice reads ~2.4 words/s (measured), and the narration must run through the WHOLE video. The
    // old 1.7 words/s "safe" rate with an "or fewer" cap made the script read ~70% of the video, then silence. The voiceover is
    // also fitted to the exact video length after synthesis (see generateFittedVoiceover), so this only has to be close.
    const english = this.profile.key.toLowerCase() === "codeorcap";
    // Any channel with the cloned voice also fills the whole video (its audio is time-fitted afterwards, see generateFittedVoiceover):
    // with the cautious rate below, Prompt Gag's 54 s reel got 30 s of narration and then silence.
    const cloned = clonedVoiceEnabled(this.profile.key);
    const fillWholeVideo = english || cloned;
    // The cloned English voice (src/audio/clonedVoice.ts) reads ~3.2 words/s at natural speed (measured), the Edge voice ~2.4;
    // the cloned Hinglish/Hindi voice ~2.7 words/s (311 characters in 20.1 s, measured on Prompt Gag).
    const wordsPerSecond = cloned ? (english ? 3.0 : 2.6) : english ? 2.3 : 1.7; // other Edge channels keep the cautious rate
    const targetWords = Math.max(10, Math.min(fillWholeVideo ? (cloned ? 300 : 220) : 150, Math.round((duration - (fillWholeVideo ? 0.6 : 1.5)) * wordsPerSecond)));
    const lengthRule = fillWholeVideo
      ? `Write a highly engaging, natural-sounding script of about ${targetWords} words (never fewer than ${Math.round(targetWords * 0.9)}). ` +
        `It MUST keep the narration going through the WHOLE ${Math.round(duration)}-second video and finish in its last second or so, ` +
        `with no early stop and no long silence at the end, ending on a complete sentence. `
      : `Write a highly engaging, natural-sounding script of exactly or fewer than ${targetWords} words. ` +
        `It MUST finish speaking about 1.5 to 2 seconds before the end of the ${Math.round(duration)}-second video ` +
        `so that the voice is never cut off in the middle of a sentence. It should be concise and well-paced. `;
    return (
      lengthRule +
      `CRITICAL: The script is a voiceover spoken to the audience. You MUST NEVER mention frame numbers (e.g. 'frame 1', 'frame 2', 'first frame'), 'slide', 'image', 'picture', or refer to the visual layout stages. Narrate the story or explain the code naturally as a single continuous flow of speech.`
    );
  }
  private viralAnalyzer = new ViralAnalyzer();
  private analyzer = new ImageAnalyzer();
  private pexels = new PexelsService();
  private queue = new JobQueue(1);
  public pending = new Map<string, PendingUpload>();
  public pendingSettingsReviews = new Map<
    string,
    {
      context: PipelineContext;
      resolve: (decision: "proceed" | "cancel" | "restart") => void;
      timer: ReturnType<typeof setTimeout>;
      reviewMessageId: number;
      chatId: number;
      messageId: number;
      startTime: number;
    }
  >();
  private uploaded = new Map<
    string,
    { channelResults: UploadResult[]; chatId: number; successMessageId: number }
  >();
  private jobResolvers = new Map<string, () => void>();

  constructor(notify: NotifyService, profile?: ChannelProfile) {
    this.profile = profile || notify.profile;
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
    this.facebook = new FacebookPublisher(
      this.profile.brandName,
      this.profile.facebook,
    );
    // Each channel profile keeps its own job db file (legacy name for the default profile)
    this.db = new JobDatabase(
      this.profile.isDefault ? undefined : this.profile.key,
    );
    this.notify = notify;
    this.tts = new TTSService();
    DirectUploader.instances.push(this);

    // Review callbacks (kept for the notifier interface; the dashboard drives review)
    notify.registerReviewCallback((action, id) => {
      if (action === "publish") this.onPublish(id);
      else if (action === "cancel") this.onCancel(id);
      else if (action === "regenerate") this.onRegenerate(id, false);
      else if (action === "viral") this.onRegenerate(id, true);
      else if (action === "toggle_voiceover") this.onToggleVoiceover(id);
      else if (action === "replace_music") {
        const pending = this.pending.get(id);
        if (pending) {
          this.notify.sendMessage(
            pending.chatId,
            `🎵 *Please upload or send an audio file* (MP3, WAV, M4A, AAC, OGG) or record a voice note now to replace the background music for this Short.`,
            pending.reviewMessageId
          ).catch(() => {});
        }
      }
    });

    notify.registerRevokeCallback(async (id) => {
      await this.onRevoke(id);
    });

    notify.registerAudioUploadCallback(async (chatId, fileId, fileName, messageId) => {
      return this.handleUserAudioUpload(chatId, fileId, fileName, messageId);
    });

    notify.registerSettingsReviewCallback((code, id) => {
      this.onSettingsAction(code, id);
    });

    notify.registerTextPromptCallback(async (chatId, text, messageId) => {
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
      this.applyCreatorZoneCache(context);
      return;
    }

    // Declared outside the try block (not just inside it) so the catch
    // block below can still recover branding zones from whatever the AI
    // returned, even when the rest of the response failed to parse.
    let raw = "";
    try {
      context.metadataIsFallback = false;
      const imagePaths = Array.isArray(imagePath) ? imagePath : [imagePath];
      const results = await Promise.all(
        imagePaths.map((imgPath) => this.getSmallBase64Image(imgPath))
      );
      const base64s = results.map((r) => r.base64);
      const mimeTypes = results.map((r) => r.mimeType);

      let prompt = `You are a computer vision assistant and growth strategist for ${this.theme.channelDescriptor} called "${this.profile.brandName}".

These 6 frames represent the visual progression of the video at 0%, 20%, 40%, 60%, 80%, and 95% of its duration. Describe what is happening at each stage and write a voiceover script that tracks this progression.

Analyze this video frame/image and perform two tasks:

TASK 1: Brand/Watermark/Content Detection
Detect the exact coordinates of any branding, watermarks, profile pictures, usernames/handles, logos, or app overlays of other creators. Also, if this image shows a full Instagram page/embed layout, detect the boundaries of the main content media box. Detect the exact bounding box of any original captions or meme text written on the image. Locate them and return their bounding boxes in normalized coordinates relative to the image size (value between 0.0 and 1.0).
Search for, tagging each with the exact matching "type" value from the schema below:
- type "profile_picture": the small circle image of the original creator's face/avatar, usually top-left or bottom-left
- type "handle": the original creator's @username/profile name text, usually right next to their profile picture
- type "profile_name": the original creator's display name text (distinct from their @handle), if shown separately
- type "watermark" / "logo": platform or app watermarks/logos (Instagram logo, TikTok watermark, other channel's logo)
- type "main_post_content" (e.g. if the image contains a full post layout, comments, or web view headers, detect the bounding box of the central post image/media box itself, excluding headers, comments, likes, and footer chrome)
- type "original_captions" (e.g. the main meme text/caption written on the top or center of the frame in white/black outlines)
Every trace of the original creator's identity — their profile picture, handle, and display name — MUST each get their own brandingZones entry so they can be fully covered; do not skip any of them or merge them into one box.

If no such elements are present, return an empty array for brandingZones.

TASK 2: YouTube Shorts Metadata & Content Analysis
You are an expert YouTube SEO strategist for ${this.theme.channelDescriptor} called "${this.profile.brandName}".
${this.theme.analysisRules}
${this.theme.titleRules}
${this.theme.descriptionRules(this.profile.brandName)}
KEYWORDS: ${this.theme.keywordsRule}
THUMBNAIL: Max 5 words, highly clickable, curiosity driven.
FILENAME: SEO-friendly filename (e.g., short-video-2026.mp4).
VOICEOVER: ${this.buildVoiceoverLengthInstruction(context)} in ${this.voiceoverPromptLanguage} that describes the content. It should sound very natural, hook the viewer immediately, and explain what is happening or read the meme text in an entertaining way.
HOW_IT_WORKS: ${this.profile.key.toLowerCase() === "codeorcap" ? "A detailed, clear, and educational explanation (approx 2-3 sentences, 30-50 words) explaining how the code snippet, concept, or trick works step-by-step to add original educational value." : insightRuleFor(this.profile.key)} NEVER return hashtags or generic labels.
${this.theme.niche === "infoonspot" || this.profile.key.toLowerCase() === "infoonspot" ? `
INFOONSPOT BROADCAST TEMPLATE FIELDS:
- coverHeadline: A punchy 1-2 line UPPERCASE hook headline (max 6-8 words total, e.g. "NEW AI CREATES FULL 3D WORLDS IN SECONDS") to fill the top [BREAKING] headline banner.
- infoKeyPoint: A punchy key takeaway / bullet point (max 6-10 words total, e.g. "100% FREE & OPEN-SOURCE FOR CREATORS") to fill the bottom [KEY POINT] cyber box.
- infoLocation: The location or geographical tag (e.g. "SAN FRANCISCO", "CALIFORNIA", "WORLDWIDE", "TOKYO"). Use "WORLDWIDE" if not location-specific.
- coverCategory: EXACTLY ONE of AI, TECH, WEBSITES, MONEY, CAREER, TOOLS, UPDATE, EXPLAINED.
- coverEmoji: one reaction emoji that fits (⚡ 💻 🤖 🤯 👀 🚨 💡 🔥).` : ""}

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
- originalAudio: true when the original audio carries the content (speech, dialogue, a story being told, meaningful sound) and should be kept. False when audio is just generic/absent and should be REPLACED ENTIRELY by background music (this is a single either/or choice — original audio and background music are never both on).
- voiceover: true when the video has no meaningful audio narrative and would benefit from an AI-narrated script (e.g. silent memes, stories told via on-screen text). False when the original speech IS the content. Voiceover layers on top of whichever audio bed (original or music) is chosen above.
- captions: true when there is speech to subtitle or a voiceover script will be narrated. False for pure visual/music content.
- cropTopPct / cropBottomPct: percentage of the frame height to crop away (MUST be one of 0, 5, 10, 15, 20, 25, 30, 35). Recommend cropping only to remove creator banners, usernames, app chrome, or captions baked near the very top/bottom edges (use the brandingZones you found). 0 when nothing needs removing.
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
    "voiceoverScript": string,
    "howItWorks": string,
    "diagramWorkflow": string,
    "diagramTitle": string,
    "coverCategory": string,
    "coverEmoji": string,
    "coverHeadline": string
  },
  "brandingZones": [
    {
      "type": "logo" | "watermark" | "handle" | "profile_name" | "profile_picture" | "main_post_content" | "original_captions",
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
          howItWorks: (data as any).howItWorks,
          diagramWorkflow: (data as any).diagramWorkflow,
          diagramTitle: (data as any).diagramTitle,
          coverCategory: (data as any).coverCategory,
          coverEmoji: (data as any).coverEmoji,
          coverHeadline: (data as any).coverHeadline,
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

      // InfoOnSpot template fields guarantee
      if (this.theme.niche === "infoonspot" || this.profile.key.toLowerCase() === "infoonspot") {
        if (!context.metadata.coverHeadline) {
          const rawTitle = (context.metadata.title || context.ocr?.text || "VIRAL TECH UPDATE")
            .replace(/[^\w\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          context.metadata.coverHeadline = rawTitle.toUpperCase();
        }
        if (!context.metadata.infoKeyPoint) {
          context.metadata.infoKeyPoint = (context.metadata.howItWorks || context.metadata.verdict || context.metadata.title || "100% FACT CHECKED").toUpperCase();
        }
        if (!context.metadata.infoLocation) {
          context.metadata.infoLocation = "WORLDWIDE";
        }
        if (!context.metadata.infoDate) {
          context.metadata.infoDate = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
        }
        if (!context.metadata.coverCategory) {
          context.metadata.coverCategory = "TECH";
        }
        if (!context.metadata.coverEmoji) {
          context.metadata.coverEmoji = "⚡";
        }
      }

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

      if (!context.brandingDetection) {
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
            const chatId = context.sourceMeta?.chatId;
            const messageId = context.sourceMeta?.messageId;
            if (chatId) {
              this.notify
                .sendMessage(
                  chatId,
                  `⚠️ *AI Quality Check Warning:*\n` +
                    `• *Readability:* ${data.qualityScore.readability}/100\n` +
                    `• *Watermark Risk:* ${data.qualityScore.watermarkRisk}/100\n` +
                    // Not wrapped in _..._ : an escaped underscore (from an
                    // AI-mentioned @handle) living inside an active italic
                    // entity breaks Telegram's legacy Markdown parser entirely
                    // (verified: "Can't find end of the entity..."). Every
                    // other dynamic value in this file is embedded plain,
                    // after a bold label, with no wrapping emphasis — match
                    // that convention here too.
                    `• *Recommendation:* ${escapeMarkdown(data.qualityScore.recommendation)}`,
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
      } else {
        pipelineLogger.info(
          "Retaining existing brandingDetection, safe areas, quality scores, and recommendations in context",
          "DirectUploader",
        );
      }

      pipelineLogger.checkpoint(
        "Unified AI vision completed",
        true,
        `Metadata: "${data.metadata.title}", Branding zones: ${context.brandingDetection?.zones?.length || 0}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pipelineLogger.error("Unified AI vision failed", err, "DirectUploader");

      const chatId = context.sourceMeta?.chatId;
      const messageId = context.sourceMeta?.messageId;
      if (chatId) {
        if (/quota|limit|429|resource_exhausted/i.test(msg)) {
          this.notify
            .sendMessage(
              chatId,
              `⚠️ *AI Vision Quota Error:* Your FreeLLMAPI key has exceeded its quota.\n\n` +
                `*Details:* \`Free tier daily request limit exceeded.\`\n\n` +
                `_Fallback metadata will be used and watermark/profile blurring will be skipped._`,
              messageId,
            )
            .catch(() => {});
        } else {
          this.notify
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
      // The metadata/description text is what usually breaks JSON parsing
      // (unescaped quotes in Hinglish scripts, stray code fences) — the
      // branding zones are simple, well-formed objects, so recover them
      // straight out of the raw response instead of losing the source
      // creator's watermark/handle detection along with the broken JSON.
      const recoveredZones = raw
        ? extractJsonArrayField<UnifiedVisionResponse["brandingZones"][number]>(
            raw,
            "brandingZones",
          )
        : null;
      if (recoveredZones && recoveredZones.length > 0) {
        context.brandingDetection = {
          detected: true,
          zones: recoveredZones.map((item, index) => ({
            id: `ai-branding-${index}`,
            type: item.type,
            boundingBox: item.box,
            confidence: 0.9,
            description: item.description,
          })),
        };
        pipelineLogger.info(
          `Recovered ${recoveredZones.length} branding zone(s) from an otherwise malformed AI response`,
          "DirectUploader",
        );
      } else {
        context.brandingDetection = { detected: false, zones: [] };
      }
      this.applyRecommendedSettings(context, undefined);
    }

    this.applyCreatorZoneCache(context);
  }

  /**
   * Repost accounts stamp their own watermark/handle/profile-picture overlay
   * in the same fixed position on every reel they post. Once we've found it
   * for a given creator, reuse that known position on their later reels
   * instead of trusting fresh AI detection every time — this also covers us
   * if a later call to the same creator's content has a vision miss.
   */
  private applyCreatorZoneCache(context: PipelineContext): void {
    const username = context.sourceCreatorUsername;
    if (!username) return;

    const cached = creatorZoneStore.getZones(username);
    if (cached && cached.length > 0) {
      context.brandingDetection = { detected: true, zones: cached };
      pipelineLogger.info(
        `Applied ${cached.length} cached branding zone(s) for known creator @${username}`,
        "DirectUploader",
      );
      return;
    }

    const freshZones = context.brandingDetection?.zones || [];
    if (freshZones.length > 0) {
      creatorZoneStore.saveZones(username, freshZones);
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
      captions?: boolean;
      cropTopPct?: number;
      cropBottomPct?: number;
      creatorTextDetected?: boolean;
      reason?: string;
    },
  ): void {
    const snapCrop = (value: unknown): number => {
      const n = typeof value === "number" && isFinite(value) ? value : 0;
      const clamped = Math.min(35, Math.max(0, n));
      return Math.round(clamped / 5) * 5;
    };

    let calculatedCropTop = rec?.cropTopPct !== undefined ? snapCrop(rec.cropTopPct) : 0;
    let calculatedCropBottom = rec?.cropBottomPct !== undefined ? snapCrop(rec.cropBottomPct) : 0;

    // Auto-adjust crop to cleanly cut out any creator branding/handles at the edges
    const zones = context.brandingDetection?.zones || [];
    const edgeTypes = ["logo", "watermark", "handle", "profile_name", "profile_picture"];
    for (const z of zones) {
      if (z.type === "main_post_content" || z.type === "original_captions") continue;
      if (!edgeTypes.includes(z.type as string)) continue;

      const box = z.boundingBox;
      // Top edge branding zone (within top 35%)
      if (box.y + box.height <= 0.35) {
        const neededPct = Math.ceil((box.y + box.height) * 20) * 5; // Snap to next multiple of 5
        if (neededPct > calculatedCropTop) {
          calculatedCropTop = Math.min(35, neededPct);
          pipelineLogger.info(
            `Auto-adjusting cropTopPct from ${snapCrop(rec?.cropTopPct)}% to ${calculatedCropTop}% to crop out top edge branding: ${z.type} (${z.description || ""})`,
            "DirectUploader"
          );
        }
      }
      // Bottom edge branding zone (within bottom 35%)
      if (box.y >= 0.65) {
        const neededPct = Math.ceil((1.0 - box.y) * 20) * 5; // Snap to next multiple of 5
        if (neededPct > calculatedCropBottom) {
          calculatedCropBottom = Math.min(35, neededPct);
          pipelineLogger.info(
            `Auto-adjusting cropBottomPct from ${snapCrop(rec?.cropBottomPct)}% to ${calculatedCropBottom}% to crop out bottom edge branding: ${z.type} (${z.description || ""})`,
            "DirectUploader"
          );
        }
      }
    }

    context.aiRecommendedSettings = {
      voiceover: rec?.voiceover ?? true,
      originalAudio: rec?.originalAudio ?? false,
      captions: rec?.captions ?? true,
      cropTopPct: calculatedCropTop,
      cropBottomPct: calculatedCropBottom,
      sticker: true, // always ON by default for all profiles
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
        ? `You are a viral YouTube Shorts growth hacker for ${this.theme.channelDescriptor} called "${this.profile.brandName}". ${contentContext} Generate the most scroll-stopping, curiosity-gap, high-CTR metadata possible based on the text.\n${this.theme.titleRules}\n${this.theme.descriptionRules(this.profile.brandName)}\n${this.buildVoiceoverLengthInstruction(context)} in ${this.voiceoverPromptLanguage} describing the content. Additionally, generate a 'howItWorks' field containing a detailed, clear, and educational explanation (approx 2-3 sentences, 30-50 words) explaining how the code snippet or trick works step-by-step to add original educational value. Also, generate a 'diagramTitle' field (a 2-4 word diagram title) and a 'diagramWorkflow' field containing a valid, simple Mermaid.js flowchart (graph TD/LR) with 3-5 nodes explaining the process/timeline/workflow to add original educational value. Use double quotes around node labels.\nReturn ONLY raw JSON: {"metadata":{"title":"...","description":"...","tags":["..."],"mood":"other","factCheckScore":10,"verdict":"Accurate","voiceoverScript":"...","howItWorks":"...","diagramWorkflow":"...","diagramTitle":"..."}}`
        : `You are a YouTube Shorts strategist for ${this.theme.channelDescriptor} called "${this.profile.brandName}". ${contentContext} Generate SEO-optimised metadata based on the text.\n${this.theme.titleRules}\n${this.theme.descriptionRules(this.profile.brandName)}\n${this.buildVoiceoverLengthInstruction(context)} in ${this.voiceoverPromptLanguage} describing the content. Additionally, generate a 'howItWorks' field containing a detailed, clear, and educational explanation (approx 2-3 sentences, 30-50 words) explaining how the code snippet or trick works step-by-step to add original educational value. Also, generate a 'diagramTitle' field (a 2-4 word diagram title) and a 'diagramWorkflow' field containing a valid, simple Mermaid.js flowchart (graph TD/LR) with 3-5 nodes explaining the process/timeline/workflow to add original educational value. Use double quotes around node labels.\nReturn ONLY raw JSON: {"metadata":{"title":"...","description":"...","tags":["..."],"mood":"other","factCheckScore":10,"verdict":"Accurate","voiceoverScript":"...","howItWorks":"...","diagramWorkflow":"...","diagramTitle":"..."}}`;
      
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
      const chatId = context?.sourceMeta?.chatId;
      if (chatId) {
        this.notify
          .sendMessage(
            chatId,
            `❌ *AI metadata generation failed* (FreeLLMAPI, model: auto)\n` +
              `\`${msg.replace(/`/g, "'").slice(0, 200)}\`\n\n` +
              `_Using a generic template title/description instead. Tap 🔄 Regenerate on the review message to retry AI generation._`,
            context?.sourceMeta?.messageId,
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
- voiceoverScript: ${this.buildVoiceoverLengthInstruction(context)} in ${this.voiceoverPromptLanguage} that describes the content. It should sound very natural, hook the viewer immediately, and explain what is happening or read the meme text in an entertaining way.
- howItWorks: ${insightRuleFor(this.profile.key)}
- diagramTitle: A brief 2-4 word title for the diagram (e.g. "Execution Flow", "State Lifecycle", "Timeline", "Fact Check", "How it works").
- diagramWorkflow: A valid, simple Mermaid.js flowchart (graph TD or graph LR) explaining the logic, execution, process, timeline, or steps of the topic (3-5 nodes max). Use double quotes around node labels (e.g. A[\"Start\"] --> B[\"Check condition\"]). Node IDs must be simple alphanumeric characters. Keep it clean and valid.
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

    if (this.theme.niche === "infoonspot" || this.profile.key.toLowerCase() === "infoonspot") {
      prompt += `\n\nINFOONSPOT BROADCAST TEMPLATE: produce the dynamic template fields based on the reel content:
- coverHeadline: 1-2 SHORT UPPERCASE lines (max 6-8 words total). Punchy hook for the top [BREAKING] banner. e.g. "NEW AI CREATES FULL 3D WORLDS IN SECONDS".
- infoKeyPoint: 1 SHORT UPPERCASE line (max 6-10 words total). Key takeaway/fact for bottom [KEY POINT] cyber box. e.g. "100% FREE FOR INDIE CREATORS".
- infoLocation: Location tag (e.g. "SAN FRANCISCO", "CALIFORNIA", "WORLDWIDE"). Use "WORLDWIDE" if not location-specific.
- coverCategory: EXACTLY ONE of AI, TECH, MONEY, SOCIAL, TRENDING, EXPLAINED, UPDATE.
- coverEmoji: one reaction emoji that fits (😱 🤯 👀 🚨 ⚡ 🔥).`;
    }

    prompt += `\nReturn ONLY a raw JSON object — no markdown, no explanation:
{"title":"...","description":"...","tags":["...","..."],"mood":"funny" | "sad" | "other", "factCheckScore": 10, "verdict": "...", "voiceoverScript": "...", "howItWorks": "...", "diagramWorkflow": "...", "diagramTitle": "...", "coverCategory":"...", "coverEmoji":"...", "coverHeadline":"...", "infoKeyPoint":"...", "infoLocation":"..."}`;

    for (let attempt = 0; attempt < AI_MAX_ATTEMPTS; attempt++) {
      try {
        let raw = "";
        if (this.freellmapi) {
          pipelineLogger.info(
            `Attempting metadata generation via FreeLLMAPI (Attempt ${attempt + 1}/${AI_MAX_ATTEMPTS})...`,
            "DirectUploader",
          );
          try {
            raw = await this.freellmapi.generateVision(prompt, base64, mimeType);
          } catch (freeErr: any) {
            pipelineLogger.warn(
              `FreeLLMAPI vision failed (${freeErr?.message || freeErr}) — trying Gemini Vision...`,
              "DirectUploader",
            );
            if (this.gemini.enabled) {
              raw = await this.gemini.generateVision(prompt, base64, mimeType);
            } else {
              throw freeErr;
            }
          }
        } else if (this.gemini.enabled) {
          pipelineLogger.info(
            `Attempting metadata generation via Gemini Vision (Attempt ${attempt + 1}/${AI_MAX_ATTEMPTS})...`,
            "DirectUploader",
          );
          raw = await this.gemini.generateVision(prompt, base64, mimeType);
        }

        if (!raw) {
          throw new Error("AI vision failed to respond.");
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
      coverCategory: this.theme.fallback.coverCategory,
      coverEmoji: this.theme.fallback.coverEmoji,
      coverHeadline: this.theme.fallback.coverHeadline,
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
- MOOD: Determine emotional tone: "funny", "serious", "emotional", "motivational", "technical", "horror", "romantic", "sad", or "other".
- howItWorks: ${insightRuleFor(this.profile.key)}
- diagramTitle: A brief 2-4 word title for the diagram (e.g. "Execution Flow", "State Lifecycle", "Timeline", "Fact Check", "How it works").
- diagramWorkflow: A valid, simple Mermaid.js flowchart (graph TD or graph LR) explaining the logic, execution, process, timeline, or steps of the topic (3-5 nodes max). Use double quotes around node labels (e.g. A[\"Start\"] --> B[\"Check condition\"]). Node IDs must be simple alphanumeric characters. Keep it clean and valid.
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

    if (this.theme.niche === "infoonspot" || this.profile.key.toLowerCase() === "infoonspot") {
      prompt += `\n\nINFOONSPOT BROADCAST TEMPLATE: produce the dynamic template fields based on the reel content:
- coverHeadline: 1-2 SHORT UPPERCASE lines (max 6-8 words total). Punchy hook for the top [BREAKING] banner. e.g. "NEW AI CREATES FULL 3D WORLDS IN SECONDS".
- infoKeyPoint: 1 SHORT UPPERCASE line (max 6-10 words total). Key takeaway/fact for bottom [KEY POINT] cyber box. e.g. "100% FREE FOR INDIE CREATORS".
- infoLocation: Location tag (e.g. "SAN FRANCISCO", "CALIFORNIA", "WORLDWIDE"). Use "WORLDWIDE" if not location-specific.
- coverCategory: EXACTLY ONE of AI, TECH, MONEY, SOCIAL, TRENDING, EXPLAINED, UPDATE.
- coverEmoji: one reaction emoji that fits (😱 🤯 👀 🚨 ⚡ 🔥).`;
    }

    prompt += `\nReturn ONLY raw JSON — no markdown:
{"title":"...","description":"...","primaryKeyword":"...","secondaryKeywords":["..."],"tags":["..."],"hashtags":["..."],"thumbnailText":"...","filename":"...","mood":"funny" | "sad" | "other","factCheckScore":10,"verdict":"...","howItWorks":"...","diagramWorkflow":"...","diagramTitle":"...","coverCategory":"...","coverEmoji":"...","coverHeadline":"...", "infoKeyPoint":"...", "infoLocation":"..."}`;

    for (let attempt = 0; attempt < AI_MAX_ATTEMPTS; attempt++) {
      try {
        let raw = "";
        if (this.freellmapi) {
          pipelineLogger.info(
            `Attempting metadata generation via FreeLLMAPI (Attempt ${attempt + 1}/${AI_MAX_ATTEMPTS})...`,
            "DirectUploader",
          );
          try {
            raw = await this.freellmapi.generateVision(prompt, base64, mimeType);
          } catch (freeErr: any) {
            pipelineLogger.warn(
              `FreeLLMAPI viral vision failed (${freeErr?.message || freeErr}) — trying Gemini Vision...`,
              "DirectUploader",
            );
            if (this.gemini.enabled) {
              raw = await this.gemini.generateVision(prompt, base64, mimeType);
            } else {
              throw freeErr;
            }
          }
        } else if (this.gemini.enabled) {
          pipelineLogger.info(
            `Attempting metadata generation via Gemini Vision (Attempt ${attempt + 1}/${AI_MAX_ATTEMPTS})...`,
            "DirectUploader",
          );
          raw = await this.gemini.generateVision(prompt, base64, mimeType);
        }

        if (!raw) {
          throw new Error("AI vision failed to respond.");
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
      pipelineLogger.info(`Video exceeds 59s. Trimming and optimizing with stream copy (faststart)...`, "DirectUploader");
      // Fast stream copy (instant, 0 CPU overhead, starts on frame 0 IDR keyframe)
      const fastTrimCmd = `${config.binaries.ffmpeg} -y -i "${videoPath}" -t 59.0 -c copy -movflags +faststart "${tempOutPath}"`;
      try {
        await new Promise<void>((resolve, reject) => {
          exec(fastTrimCmd, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } catch (copyErr) {
        pipelineLogger.warn(
          `Stream copy trim failed, falling back to superfast re-encode: ${copyErr instanceof Error ? copyErr.message : copyErr}`,
          "DirectUploader"
        );
        const reencodeCmd = `${config.binaries.ffmpeg} -y -i "${videoPath}" -t 59.0 -c:v libx264 -preset superfast -crf 23 -c:a aac -movflags +faststart "${tempOutPath}"`;
        await new Promise<void>((resolve, reject) => {
          exec(reencodeCmd, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
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

  private getRenderer(_context: PipelineContext): VideoRenderer {
    return this.renderer;
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

    // Source-creator credit: verified handle (or a neutral line), never an AI guess/placeholder.
    metadata.description = applyCreditLine(
      metadata.description,
      normalizeCreatorHandle(pending.context.sourceCreatorUsername),
    );
    // Persist what is actually published so the dashboard doesn't keep showing the AI draft.
    pending.context.metadata = metadata;
    this.db.updateJob(id, { metadata });

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
    await this.notify.removeInlineButtons(chatId, reviewMessageId);

    // Refresh credentials dynamically from DB in case new channels/accounts were added on dashboard
    try {
      const stored = await getStoredChannelConfig(this.profile.key);
      if (stored) {
        if (stored.youtubeChannels && stored.youtubeChannels.length > 0) {
          const ytList = stored.youtubeChannels.filter((c: StoredYoutubeChannel) => c.refreshToken);
          if (ytList.length > 0) {
            this.profile.youtube.channels = ytList;
            this.youtube = new YouTubeService({
              clientId: stored.youtubeClientId || process.env.YOUTUBE_CLIENT_ID || "",
              clientSecret: stored.youtubeClientSecret || process.env.YOUTUBE_CLIENT_SECRET || "",
              redirectUri: stored.youtubeRedirectUri || process.env.YOUTUBE_REDIRECT_URI || "http://localhost:3000/oauth2callback",
              channels: ytList,
            });
          }
        }
        if (stored.instagramAccounts && stored.instagramAccounts.length > 0) {
          const igList = stored.instagramAccounts.filter((a: StoredInstagramAccount) => a.accessToken && a.igUserId);
          if (igList.length > 0) {
            this.profile.instagram.accounts = igList;
            this.instagram = new InstagramPublisher(igList);
          }
        }
      }
    } catch (e: any) {
      pipelineLogger.warn(`[onPublish] Could not refresh channel configs from DB: ${e.message}`, "DirectUploader");
    }

    await this.notify.sendMessage(
      chatId,
      `🚀 *Uploading to ${this.profile.youtube.channels.length} YouTube channel(s), ${this.profile.instagram.accounts.length} Instagram account(s), and Facebook Page…*`,
      messageId,
    );

    try {
      const results: UploadResult[] = await this.youtube.uploadToAllChannels(
        finalVideoPath,
        metadata,
        { brandKey: this.profile.key },
      );

      const instaResults: InstagramUploadResult[] = await this.instagram.uploadToAllAccounts(
        finalVideoPath,
        metadata,
        { brandKey: this.profile.key },
      );

      const fbResult: FacebookUploadResult | null = await this.facebook.uploadReel(
        finalVideoPath,
        metadata,
      );

      const channelLines = results
        .map((r) => `• *YouTube (${escapeMarkdown(r.channelName)}):* ${escapeMarkdown(r.url)}`)
        .join("\n");

      const instaLines = instaResults
        .map((r) => `• *Instagram (${escapeMarkdown(r.accountName)}):* ${escapeMarkdown(r.url)}`)
        .join("\n");

      const fbLines = fbResult
        ? `• *Facebook (${escapeMarkdown(fbResult.pageName)}):* ${escapeMarkdown(fbResult.url)}`
        : "";

      // Per-channel failures return null and are filtered out — surface them
      // instead of implying every platform succeeded.
      const expectedYt = this.profile.youtube.channels.length;
      const expectedIg = this.profile.instagram.accounts.length;
      const expectedFb = this.profile.facebook ? 1 : 0;
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
      if (expectedFb > 0 && !fbResult) {
        failLines.push(
          `⚠️ *Facebook upload FAILED* — check logs`,
        );
      }
      const failBlock = failLines.length ? failLines.join("\n") + "\n\n" : "";
      const headline =
        failLines.length === 0
          ? `✅ *Uploaded successfully!*`
          : `⚠️ *Upload partially failed*`;

      const { shortcode, channel } = pending.context;
      const sourceLine = shortcode
        ? `*Source:* [instagram.com/reel/${escapeMarkdown(shortcode)}](https://www.instagram.com/reel/${shortcode}/)` +
          (channel ? ` \\(@${escapeMarkdown(channel)}\\)` : "")
        : "";

      const successText =
        `${headline}\n\n` +
        failBlock +
        `*Title:* ${escapeMarkdown(metadata.title)}\n\n` +
        (channelLines ? `${channelLines}\n` : "") +
        (instaLines ? `${instaLines}\n` : "") +
        (fbLines ? `${fbLines}\n` : "") +
        (sourceLine ? `\n${sourceLine}\n` : "") +
        `\n*ID:* ${escapeMarkdown(id)}`;

      const successMessageId = await this.notify.sendSuccessMessageWithRevoke(
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
        instagramUrl: instaResults[0]?.url,
        facebookUrl: fbResult?.url,
        youtubeVideoId: results[0]?.videoId,
        instagramMediaId: instaResults[0]?.mediaId,
        facebookVideoId: fbResult?.videoId,
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

      // Automatically generate and publish companion 5-minute deep-dive YouTube video.
      // Opt-in: it spawns a second heavy render + headless Chromium in the
      // background, which starves the main pipeline on small hosts (it was
      // failing every time with navigation timeouts). Enable with
      // AUTO_LONG_VIDEO_ENABLED=true once the box has headroom.
      if (process.env.AUTO_LONG_VIDEO_ENABLED === "true") {
        this.triggerCompanionLongVideo(id, metadata, pending.context, chatId).catch((companionErr) => {
          pipelineLogger.warn(`[CompanionLongVideo] Background error: ${companionErr.message}`, "DirectUploader");
        });
      }

      // Instead of deleting the review video, keep it for manual download.
      // Also send the final video with title and description so the user can retrieve metadata.
      try {
        const compressedVideoPath = path.join(path.dirname(finalVideoPath), "video_compressed.mp4");
        const videoToSend = fs.existsSync(compressedVideoPath) ? compressedVideoPath : finalVideoPath;

        const messageId = await this.notify.sendRawVideo(
          chatId,
          videoToSend,
          `*Title:* ${escapeMarkdown(metadata.title)}`,
        );

        let fullDescription = `*Description:*\n${escapeMarkdown(metadata.description)}`;
        
        if (metadata.factCheckScore !== undefined) {
          fullDescription += `\n\n*Fact Check Score:* ${metadata.factCheckScore}/10`;
        }
        if (metadata.verdict) {
          fullDescription += `\n*Verdict:* ${metadata.verdict}`;
        }
        if (fullDescription.length > 4000) {
          fullDescription = fullDescription.substring(0, 4000) + '...';
        }
        
        await this.notify.sendMessage(
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
      await this.notify.sendMessage(
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

  /**
   * Automatically generates and publishes a companion 5-minute deep-dive YouTube video (16:9 Landscape)
   * based on the Short's topic, transcript, and technical concepts.
   */
  private async triggerCompanionLongVideo(
    _id: string,
    metadata: VideoMetadata,
    _context: PipelineContext,
    chatId: number,
  ): Promise<void> {
    const topic = metadata.title || this.theme.niche;
    const niche = this.theme.niche;
    pipelineLogger.info(
      `[AutoLongVideo] Spawning 5-minute companion video generator for Short "${topic}"`,
      "DirectUploader",
    );

    try {
      const generator = new MultiSceneGenerator();
      const result = await generator.generateFacelessShort({
        topic: `Comprehensive in-depth guide to: ${topic}. Full educational breakdown, key mechanisms, code architecture, and practical best practices.`,
        channelKey: this.profile.key,
        brandName: this.profile.brandName,
        handle: this.profile.handle,
        niche,
        aspectRatio: "16:9",
        durationTarget: "5min",
      });

      if (!result.success || !result.videoPath) {
        throw new Error("5-minute companion video rendering failed");
      }

      pipelineLogger.info(
        `[AutoLongVideo] 5-minute video rendered: ${result.videoPath} (${result.duration.toFixed(1)}s). Publishing to YouTube…`,
        "DirectUploader",
      );

      const ytResults = await this.youtube.uploadToAllChannels(result.videoPath, {
        title: result.metadata.title || `${metadata.title} | Full In-Depth Guide`,
        description: `${result.metadata.description}\n\n🎬 Full deep-dive companion video for our Short on ${topic}.\n\nSubscribe to ${this.profile.brandName} (${this.profile.handle}) for daily engineering insights!`,
        tags: [...(result.metadata.tags || []), "guide", "tutorial", "deep dive"],
      }, { isLong: true, brandKey: this.profile.key });

      const firstUrl = ytResults.find((r) => r && r.url)?.url;
      if (firstUrl) {
        pipelineLogger.checkpoint(
          "Companion 5-Minute YouTube Video Published",
          true,
          firstUrl,
        );

        if (chatId) {
          await this.notify.sendMessage(
            chatId,
            `🎬 *Companion 5-Minute Long Video Published on YouTube!*\n\n*Topic:* ${escapeMarkdown(metadata.title)}\n*Watch Full Video:* ${escapeMarkdown(firstUrl)}`,
          );
        }
      }
    } catch (err: any) {
      pipelineLogger.warn(
        `[AutoLongVideo] Failed to generate/publish companion 5-min video: ${err.message}`,
        "DirectUploader",
      );
    }
  }

  // ── Review button handlers ─────────────────────────────────────────────────

  public onPublish(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.uploadAndReport(pending).catch((err) =>
      pipelineLogger.error(`Upload error for ${id}`, err, "DirectUploader"),
    );
  }

  public onCancel(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(id);
    this.notify.removeInlineButtons(pending.chatId, pending.reviewMessageId);
    this.notify.sendMessage(
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
        await this.notify
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
      if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          pipelineLogger.info(
            `Review timeout for ${id} — auto-publishing.`,
            "DirectUploader",
          );
          this.onPublish(id);
        }, 60000);
      }
    }

    // Update context in DB
    this.db.updateJob(id, { context: job.context });
    
    // Update the message to indicate status
    const statusText = job.context.useVoiceover ? "🔊 Voiceover: **ON**" : "🔇 Voiceover: **OFF**";
    const fallbackWarningLine = job.context.metadataIsFallback
      ? `❌ *AI metadata FAILED — generic template in use. Tap 🔄 Regenerate!*\n\n`
      : "";
    const explanationLine = metadata.howItWorks
      ? `💡 *How It Works:* ${escapeMarkdown(metadata.howItWorks)}\n\n`
      : "";
    const hasTimer = !!(pending && pending.timer);
    const timerText = hasTimer
      ? `⏳ _Auto-publishes in 1 minute if no action taken._`
      : `⏳ _Waiting for review action..._`;
    const caption =
      `📋 *Review your Short*\n\n` +
      fallbackWarningLine +
      `*Title:* ${escapeMarkdown(metadata.title)}\n\n` +
      `*Description:* ${escapeMarkdown(metadata.description.slice(0, 200))}…\n\n` +
      explanationLine +
      statusText + `\n\n` +
      timerText;

    if (job.context.sourceMeta.messageId) {
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

      await this.notify.editReviewVideo(
        job.context.sourceMeta.chatId,
        job.context.sourceMeta.messageId,
        reviewVideoPath,
        caption,
        id
      );
    }
  }

  // ── Pre-processing settings review gate ────────────────────────────────────

  private buildSettingsReviewText(context: PipelineContext): string {
    const rec = context.aiRecommendedSettings;
    // Normalized so the displayed mood always matches whichever mood button
    // is marked "•" in the keyboard below — an unrecognized raw AI string
    // would otherwise show one mood in the text and a different one selected.
    const mood = normalizeMood(context.metadata?.mood);
    const captionSource = context.transcript?.words?.length
      ? "Whisper transcript"
      : context.metadata?.voiceoverScript
        ? "Voiceover script"
        : "None available";
    
    let audioStatusText = context.hasOriginalAudio ? "Yes" : "No";
    if (context.originalAudioCopyright?.matched) {
      audioStatusText += ` ⚠️ *Copyrighted:* "${escapeMarkdown(context.originalAudioCopyright.title || "")}" by ${escapeMarkdown(context.originalAudioCopyright.artist || "Unknown")} (Auto-switched to background music)`;
    }

    return (
      `🛠 *Review Processing Settings*\n\n` +
      `🎭 *Mood:* ${escapeMarkdown(mood)} _(tap a mood below to change — rewrites the storyline to match)_\n` +
      `✍️ *Creator text detected:* ${context.creatorTextDetected ? "Yes" : "No"}\n` +
      `🔊 *Original audio present:* ${audioStatusText}\n` +
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

    if (!context.reviewSettings) {
      context.reviewSettings = {
        voiceover: true,
        originalAudio: false,
        captions: true,
        cropTopPct: 0,
        cropBottomPct: 0,
        sticker: true,
        ...(context.aiRecommendedSettings ?? {}),
      };
    }

    // There is no chat to confirm settings in: continue straight away with the channel and AI-recommended settings.
    return "proceed";
  }

  /** Handles st_* button taps (and the 60s timeout, which fires "go"). */
  public onSettingsAction(code: string, id: string): void {
    const entry = this.pendingSettingsReviews.get(id);
    if (!entry) return;
    const settings = entry.context.reviewSettings!;

    if (code === "go") {
      clearTimeout(entry.timer);
      this.pendingSettingsReviews.delete(id);
      this.notify
        .removeInlineButtons(entry.chatId, entry.reviewMessageId)
        .catch(() => {});
      this.notify
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
      this.notify
        .removeInlineButtons(entry.chatId, entry.reviewMessageId)
        .catch(() => {});
      this.notify
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

    if (code.startsWith("md")) {
      const requestedMood = normalizeMood(code.slice(2));
      const currentMood = normalizeMood(entry.context.metadata?.mood);
      if (requestedMood === currentMood) return; // already this mood — nothing to do

      clearTimeout(entry.timer);
      this.pendingSettingsReviews.delete(id);
      this.notify
        .removeInlineButtons(entry.chatId, entry.reviewMessageId)
        .catch(() => {});
      this.notify
        .sendMessage(
          entry.chatId,
          `🔄 *Changing mood to ${requestedMood}…*\n\nRewriting the title, description, and voiceover script to match — this can take up to a minute.`,
          entry.reviewMessageId,
        )
        .catch(() => {});

      const context = entry.context;
      context.previousMetadata = context.metadata;
      context.userPrompt = `Change the mood/tone of this Short to "${requestedMood}". Set metadata.mood to exactly "${requestedMood}" and rewrite the title, description, and voiceoverScript so they authentically match this mood, while staying relevant to the original content.`;
      context.moodPinned = requestedMood;
      context.metadata = undefined;
      context.brandingDetection = undefined;

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

      entry.resolve("restart");
      this.resolveJob(id);
      this.run(context).catch((err) => {
        pipelineLogger.error(
          `Mood-change regeneration failed for ${id}`,
          err,
          "DirectUploader",
        );
      });
      return;
    }

    if (code === "vo") settings.voiceover = !settings.voiceover;
    else if (code === "oa") settings.originalAudio = !settings.originalAudio;
    else if (code === "cc") settings.captions = !settings.captions;
    else if (code === "sk") settings.sticker = !settings.sticker;
    else if (/^ct(0|5|10|15|20|25|30|35)$/.test(code)) {
      settings.cropTopPct = parseInt(code.slice(2), 10);
    } else if (/^cb(0|5|10|15|20|25|30|35)$/.test(code)) {
      settings.cropBottomPct = parseInt(code.slice(2), 10);
    } else {
      return; // unknown code
    }

    // Every adjustment resets the 60s auto-start timer
    clearTimeout(entry.timer);
    entry.startTime = Date.now();
    entry.timer = setTimeout(() => {
      pipelineLogger.info(
        `Settings review timeout for ${id} — proceeding with current settings.`,
        "DirectUploader",
      );
      this.onSettingsAction("go", id);
    }, 60000);

    this.notify
      .updateSettingsReview(
        entry.chatId,
        entry.reviewMessageId,
        this.buildSettingsReviewText(entry.context),
        id,
        settings,
        normalizeMood(entry.context.metadata?.mood),
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

        const explanationLine = metadata.howItWorks
          ? `💡 *How It Works:* ${escapeMarkdown(metadata.howItWorks)}\n\n`
          : "";
        if (pending.timer) {
          clearTimeout(pending.timer);
          pending.timer = setTimeout(() => {
            pipelineLogger.info(
              `Review timeout for ${id} — auto-publishing.`,
              "DirectUploader",
            );
            this.onPublish(id);
          }, 60000);
        }
        const hasTimer = !!pending.timer;
        const timerText = hasTimer
          ? `⏳ _Auto-publishes in 1 minute if no action taken._`
          : `⏳ _Waiting for review action..._`;
        const caption =
          `📋 *Review your Short* _(updated)_\n\n` +
          `*Title:* ${escapeMarkdown(metadata.title)}\n\n` +
          `*Description:* ${escapeMarkdown(metadata.description.slice(0, 200))}…\n\n` +
          explanationLine +
          (pending.musicCaptionLine || "") +
          timerText;

        await this.notify.updateReviewCaption(
          pending.chatId,
          pending.reviewMessageId,
          caption,
          id,
        );
      })
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        pipelineLogger.error(`Regenerate failed for ${id}`, err, "DirectUploader");
        await this.notify.sendMessage(
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
    if (!track || path.resolve(track) === path.resolve(ambientBedPath())) return "";
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
    await this.notify.removeInlineButtons(chatId, successMessageId);

    // Notify user we are starting revocation
    await this.notify.sendMessage(
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
      await this.notify.sendMessage(
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

      await this.notify.sendMessage(chatId, errorText, successMessageId);
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
    const { id, tempDir, originalImagePath, sourceMeta } = context;
    const { chatId, messageId } = sourceMeta;
    const isVideo = Boolean(
      context.isVideo === true &&
      context.originalVideoPath &&
      fs.existsSync(context.originalVideoPath) &&
      (() => {
        try { return fs.statSync(context.originalVideoPath).size > 0; } catch { return false; }
      })(),
    );
    const mediaLabel = isVideo ? "video" : "image";

    const pristineImagePath = path.join(tempDir, "pristine_original.jpg");
    const pristineVideoPath = path.join(tempDir, "pristine_video.mp4");

    const copyWithRetry = async (src: string, dest: string) => {
      for (let i = 0; i < 10; i++) {
        try {
          fs.copyFileSync(src, dest);
          return;
        } catch (err) {
          if (i === 9) throw err;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    };

    // 1. On first run, create backup of original video
    if (isVideo && context.originalVideoPath) {
      if (
        !fs.existsSync(pristineVideoPath) &&
        fs.existsSync(context.originalVideoPath)
      ) {
        await copyWithRetry(context.originalVideoPath, pristineVideoPath);
      }
    }

    // 2. Before we start processing, restore original pristine files (prevent "editing on edited")
    if (isVideo && fs.existsSync(pristineVideoPath) && context.originalVideoPath) {
      await copyWithRetry(pristineVideoPath, context.originalVideoPath);
    }
    if (fs.existsSync(pristineImagePath)) {
      await copyWithRetry(pristineImagePath, originalImagePath);
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
      // ── Duplicate Content Check ──────────────────────────────────────────
      // If this reel was already picked or published for ANY profile, refuse to process it again.
      if (context.shortcode && !context.userPrompt) {
        // A dashboard injection is an explicit choice of profile, so the same reel may go to
        // another channel; only block it when it was already published for THIS profile.
        const isAlreadyPublished = isManualInjectContext(context)
          ? await ReelHistoryStore.isPublishedForProfile(
              context.shortcode,
              this.profile.isDefault ? "default" : this.profile.key,
            )
          : await ReelHistoryStore.isPublishedAnywhere(context.shortcode);
        if (isAlreadyPublished) {
          pipelineLogger.warn(
            `[DirectUploader] Shortcode "${context.shortcode}" has already been published in the past — blocking duplicate re-upload!`,
            "DirectUploader"
          );
          await this.notify.sendMessage(
            chatId,
            `⚠️ *Duplicate Content Detected!*\n\nReel \`#${context.shortcode}\` has already been published. Skipping to avoid duplicate content on social channels.`,
            messageId,
          );
          this.db.createJob(id, {
            status: "failed",
            currentStep: "Blocked duplicate content",
            error: `Shortcode ${context.shortcode} was already published`,
            context,
          });
          this.resolveJob(id);
          return;
        }
      }

      this.db.createJob(id, {
        status: "pending",
        currentStep: "Ingestion and setup completed",
        source: `chat_${chatId}_msg_${messageId}`,
        mediaType: isVideo ? "video" : "image",
        context,
      });

      await this.notify.sendMessage(
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
      const f20 = path.join(tempDir, "frame_20.jpg");
      const f40 = path.join(tempDir, "frame_40.jpg");
      const f60 = path.join(tempDir, "frame_60.jpg");
      const f80 = path.join(tempDir, "frame_80.jpg");
      const f95 = path.join(tempDir, "frame_95.jpg");

      // If video, extract 6 keyframes at 0% (t=0.5s floor), 20%, 40%, 60%, 80%, and 95% of video duration in parallel.
      if (isVideo && context.originalVideoPath && fs.existsSync(context.originalVideoPath)) {
        context.status = "analyzing";
        if (
          fs.existsSync(f0) &&
          fs.existsSync(f20) &&
          fs.existsSync(f40) &&
          fs.existsSync(f60) &&
          fs.existsSync(f80) &&
          fs.existsSync(f95)
        ) {
          keyframePaths = [f0, f20, f40, f60, f80, f95];
          if (!fs.existsSync(originalImagePath)) {
            fs.copyFileSync(f0, originalImagePath);
          }
          pipelineLogger.info("Reusing existing keyframes from tempDir.", "DirectUploader");
          try {
            const stdout = execSync(
              `"${config.binaries.ffprobe}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${context.originalVideoPath}"`,
            ).toString().trim();
            const parsed = parseFloat(stdout);
            if (!isNaN(parsed) && parsed > 0) context.videoDurationSeconds = parsed;
          } catch (durErr) {
            pipelineLogger.warn("Failed to probe video duration on keyframe reuse path", "DirectUploader");
          }
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
            context.videoDurationSeconds = duration;

            const t0 = Math.max(0.5, 0.0 * duration);
            const t20 = 0.20 * duration;
            const t40 = 0.40 * duration;
            const t60 = 0.60 * duration;
            const t80 = 0.80 * duration;
            const t95 = 0.95 * duration;

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
              extractFrame(t20, f20),
              extractFrame(t40, f40),
              extractFrame(t60, f60),
              extractFrame(t80, f80),
              extractFrame(t95, f95),
              TranscriptionService.transcribe(context).catch((txErr) => {
                pipelineLogger.warn(
                  `Transcription failed in parallel: ${txErr instanceof Error ? txErr.message : txErr}`,
                  "DirectUploader"
                );
                context.transcript = null;
              })
            ]);

            keyframePaths = [f0, f20, f40, f60, f80, f95];
            // Copy frame_0.jpg to originalImagePath so downstream code has a valid image to analyze/edit
            fs.copyFileSync(f0, originalImagePath);
            pipelineLogger.info("Successfully extracted 6 keyframes in parallel.", "DirectUploader");
          } catch (err) {
            pipelineLogger.warn(
              `Keyframe extraction failed: ${err instanceof Error ? err.message : err}. Falling back to original.jpg at 1.0s.`,
              "DirectUploader"
            );
            // Fall back to original.jpg at 1.0s if video exists
            if (context.originalVideoPath && fs.existsSync(context.originalVideoPath)) {
              const extractCmd = `"${config.binaries.ffmpeg || "ffmpeg"}" -y -ss 00:00:01 -i "${context.originalVideoPath}" -vframes 1 -q:v 2 "${originalImagePath}"`;
              await new Promise<void>((resolve) => {
                exec(extractCmd, (err) => {
                  if (err) {
                    const fallbackCmd = `"${config.binaries.ffmpeg || "ffmpeg"}" -y -ss 00:00:00 -i "${context.originalVideoPath}" -vframes 1 -q:v 2 "${originalImagePath}"`;
                    exec(fallbackCmd, () => resolve());
                  } else {
                    resolve();
                  }
                });
              });
            }
          }
        }
      }

      // Back up pristine original image as soon as it is extracted/loaded
      if (fs.existsSync(originalImagePath) && !fs.existsSync(pristineImagePath)) {
        await copyWithRetry(originalImagePath, pristineImagePath);
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

      // A mood explicitly picked via the settings-review mood grid always wins
      // over whatever the AI classified this regeneration as — regardless of
      // which path produced context.metadata (unified vision, Gemini fallback,
      // text-only fallback, or the hardcoded template).
      if (context.moodPinned && context.metadata) {
        context.metadata.mood = context.moodPinned;
        context.moodPinned = undefined;
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

      // ── Mood-Based Channel Recognition & Auto-Routing ────────────────────
      // Applies ONLY to unpinned manual Telegram uploads on the default catch-all bot.
      // Dedicated channels and automated watcher reels must NEVER be re-routed.
      const isDefaultBot = this.profile.isDefault && (this.profile.key.toLowerCase() === "codeorcap" || this.profile.key.toLowerCase() === "default");
      const shouldAutoRoute = isDefaultBot && !context.channelPinned && !context.instagramSource;

      if (shouldAutoRoute) {
        const mood = normalizeMood(context.metadata?.mood);
        const rawText = `${context.captionMetadata?.title || ""} ${context.captionMetadata?.description || ""} ${(context.metadata?.tags || []).join(" ")}`.toLowerCase();

        let targetChannelKey = "codeorcap";
        if (
          mood === "funny" ||
          rawText.includes("#meme") ||
          rawText.includes("#funny") ||
          rawText.includes("#comedy") ||
          rawText.includes("#joke") ||
          rawText.includes("#prank")
        ) {
          targetChannelKey = "prompt_gag";
        } else if (
          mood === "emotional" ||
          mood === "sad" ||
          mood === "romantic" ||
          mood === "horror" ||
          rawText.includes("#story") ||
          rawText.includes("#kahani") ||
          rawText.includes("#moralstories") ||
          rawText.includes("#storytime") ||
          rawText.includes("#hindikahani")
        ) {
          targetChannelKey = "storiyum";
        } else if (
          rawText.includes("#explained") ||
          rawText.includes("#didyouknow") ||
          rawText.includes("#facts") ||
          rawText.includes("#knowledge") ||
          rawText.includes("#infoshorts") ||
          rawText.includes("#infoonspot") ||
          rawText.includes("#sidehustle") ||
          rawText.includes("#finance") ||
          rawText.includes("#money") ||
          rawText.includes("how it works") ||
          rawText.includes("explained in 60s")
        ) {
          targetChannelKey = "infoonspot";
        } else {
          targetChannelKey = "codeorcap";
        }

        const currentKey = this.profile.key.toLowerCase();
        if (currentKey !== targetChannelKey) {
          const targetUploader = DirectUploader.instances.find(
            (inst) => inst.profile.key.toLowerCase() === targetChannelKey,
          );

          if (targetUploader) {
            pipelineLogger.info(
              `[Auto-Routing] Detected mood "${mood}" → Redirecting job ${id} from ${this.profile.brandName} to ${targetUploader.profile.brandName}`,
              "DirectUploader",
            );

          const adminChatId =
            context.sourceMeta?.chatId || this.profile.watch.adminChatId || 0;
          if (adminChatId) {
            await this.notify
              .sendMessage(
                adminChatId,
                `🎯 *Auto-Recognized Channel:* *${targetUploader.profile.brandName}*\n` +
                  `• *Detected Mood:* \`${mood}\`\n` +
                  `• *Target Profile:* \`${targetUploader.profile.handle}\`\n\n` +
                  `Routing reel for specialized ${targetUploader.profile.brandName} video processing...`,
              )
              .catch((e) =>
                pipelineLogger.error(
                  "Failed to send routing message",
                  e,
                  "DirectUploader",
                ),
              );
          }

          const targetContext: PipelineContext = {
            ...context,
            status: "received",
            metadata: undefined,
            moodPinned: mood,
            channelPinned: true, // prevent routing loop
            channelProfileKey: targetChannelKey,
          };

          targetUploader.run(targetContext).catch((err) => {
            pipelineLogger.error(
              `Redirected job ${id} failed on ${targetUploader.profile.brandName} uploader`,
              err,
              "DirectUploader",
            );
          });

          this.db.updateJob(id, {
            status: "failed",
            currentStep: `Auto-routed to ${targetUploader.profile.brandName} based on mood "${mood}"`,
            context,
          });
          this.resolveJob(id);
          return;
        }
      }
    }

      // ── PRE-PROCESSING SETTINGS REVIEW GATE ──────────────────────────────
      // AI has analyzed the media; let the user confirm/override the processing
      // settings (or let the 60s timer proceed with the AI recommendation).
      const isPromptGag = this.profile.key.toLowerCase() === "prompt_gag";

      // ── Audio Copyright Check (Shazam) ──────────────────────────────────
      // If the video has an audio stream, identify commercial copyright tracks.
      // If copyrighted audio is detected, automatically switch off originalAudio and replace with background music.
      if (isVideo && context.originalVideoPath && context.hasOriginalAudio) {
        try {
          const shazamRes = await identifyAudio(context.originalVideoPath);
          context.originalAudioCopyright = shazamRes;
          if (shazamRes.matched) {
            pipelineLogger.warn(
              `[DirectUploader] Shazam detected copyrighted audio: "${shazamRes.title}" by ${shazamRes.artist || "Unknown"}. Automatically replacing original audio with royalty-free background music to avoid copyright strikes!`,
              "DirectUploader"
            );
            if (!context.reviewSettings) {
              context.reviewSettings = {
                voiceover: true,
                originalAudio: false, // Force off copyrighted original audio
                captions: true,
                sticker: true,
              };
            } else {
              context.reviewSettings.originalAudio = false; // Force off copyrighted original audio
            }
            if (context.aiRecommendedSettings) {
              context.aiRecommendedSettings.originalAudio = false;
            }
          }
        } catch (shazamErr) {
          pipelineLogger.warn(
            `[DirectUploader] Shazam check failed: ${shazamErr instanceof Error ? shazamErr.message : shazamErr}`,
            "DirectUploader"
          );
        }
      }

      // Apply preset overrides for PromptGag (finance explainer): the cloned voice explains the market move, captions on, the reel's own
      // audio off, no reaction sticker (the old humor preset laughed over every reel)
      if (isPromptGag) {
        pipelineLogger.info(
          "PromptGag profile detected — applying preset overrides: voiceover ON, captions ON, original audio OFF, sticker OFF",
          "DirectUploader"
        );
        if (!context.reviewSettings) {
          context.reviewSettings = {
            voiceover: true,
            originalAudio: false,
            captions: true,
            cropTopPct: 0,
            cropBottomPct: 0,
            sticker: false,
          };
        } else {
          context.reviewSettings.voiceover = true;
          context.reviewSettings.originalAudio = false;
          context.reviewSettings.captions = true;
          context.reviewSettings.sticker = false;
        }

        if (context.aiRecommendedSettings) {
          context.aiRecommendedSettings.voiceover = true;
          context.aiRecommendedSettings.originalAudio = false;
          context.aiRecommendedSettings.captions = true;
          context.aiRecommendedSettings.sticker = false;
        }
      }

      // Apply preset overrides for InfoOnSpot: real video with original audio, bottom hook, no voiceover, no burned subtitles
      const isInfoOnSpot = this.profile.key.toLowerCase() === "infoonspot";
      if (isInfoOnSpot) {
        pipelineLogger.info(
          "InfoOnSpot profile detected — applying preset overrides: original audio ON, voiceover OFF, captions OFF, bottom hook ON",
          "DirectUploader"
        );
        const keepOriginalAudio = !context.originalAudioCopyright?.matched;
        if (!context.reviewSettings) {
          context.reviewSettings = {
            voiceover: false,
            originalAudio: keepOriginalAudio,
            captions: false,
            cropTopPct: 0,
            cropBottomPct: 0,
            sticker: true,
          };
        } else {
          context.reviewSettings.voiceover = false;
          context.reviewSettings.originalAudio = keepOriginalAudio;
          context.reviewSettings.captions = false;
          context.reviewSettings.sticker = true;
        }

        if (context.aiRecommendedSettings) {
          context.aiRecommendedSettings.voiceover = false;
          context.aiRecommendedSettings.originalAudio = keepOriginalAudio;
          context.aiRecommendedSettings.captions = false;
          context.aiRecommendedSettings.sticker = true;
        }
      }
      // If reviewSettings has undefined crop values, inherit them from AI recommendations
      if (context.reviewSettings && context.aiRecommendedSettings) {
        if (context.reviewSettings.cropTopPct === undefined || (context.reviewSettings.cropTopPct as any) === null) {
          context.reviewSettings.cropTopPct = context.aiRecommendedSettings.cropTopPct;
        }
        if (context.reviewSettings.cropBottomPct === undefined || (context.reviewSettings.cropBottomPct as any) === null) {
          context.reviewSettings.cropBottomPct = context.aiRecommendedSettings.cropBottomPct;
        }
      }

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
      await this.refineInsight(context);

      let ttsPromise: Promise<number> | undefined;
      if (context.useVoiceover && isVideo) {
        pipelineLogger.info(
          "Kicking off TTS generation asynchronously...",
          "DirectUploader",
        );
        const voiceoverFile = path.join(tempDir, "voiceover.mp3");
        const reelSeconds = context.videoDurationSeconds;
        // CodeOrCap, one cloned voice for the whole Short: the claim narration and the how-it-works lines are spoken in ONE cloud
        // run that starts now, while the reel is rendered. If it fails or is late, the Edge voice is used as before.
        if (clonedVoiceEnabled(this.profile.key) && context.metadata?.voiceoverScript) {
          const claim = context.metadata.voiceoverScript;
          const hiw = insightEnabledFor(this.profile.key, this.profile.watch?.outroVersion) ? howItWorksLines(this.deriveTranscriptionWorkflow(context).explanation, insightIntro(this.profile.key)) : [];
          context.clonedHowItWorksLines = hiw;
          context.clonedVoice = startClonedLines(`short-${context.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || Date.now()}`, [
            { name: "claim", text: spokenText(claim) },
            ...hiw.map((text, i) => ({ name: `hiw_${i}`, text: spokenText(text) })),
          ], this.profile.key);
          this.tts.registerCloned(this.profile.key, claim, context.clonedVoice.then((set) => set?.file("claim") ?? null));
        }
        // CodeOrCap: fit the voice to the reel so the narration runs to the end instead of stopping early.
        ttsPromise =
          (this.profile.key.toLowerCase() === "codeorcap" || clonedVoiceEnabled(this.profile.key)) && reelSeconds && reelSeconds > 0
            ? this.tts.generateFittedVoiceover(context.metadata!.voiceoverScript!, voiceoverFile, reelSeconds - 0.3, this.profile.key)
            : this.tts.generateVoiceover(context.metadata!.voiceoverScript!, voiceoverFile, this.profile.key);
      }

      // 2 — Render/Process video
      context.status = "rendering_video";
      const rawVideoPath = path.join(tempDir, "video_raw.mp4");
      if (isVideo && context.originalVideoPath) {
        // Pass AI-detected branding zones (profile_picture, handle, profile_name, etc.)
        // directly to the renderer so they get blurred/covered on the video frames.
        // DO NOT clear context.brandingDetection.zones here — the renderer uses them.
        const renderer = this.getRenderer(context);
        await renderer.processVideo(
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

        const renderer = this.getRenderer(context);
        await renderer.renderImageToVideo(
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
      await this.notify.sendMessage(
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
    const chatId = context.sourceMeta.chatId;
    const messageId = context.sourceMeta.messageId;
    const settings = context.reviewSettings!;

    try {
      this.db.updateJob(id, {
        status: "adding_music",
        currentStep: "Compiling video and mixing audio",
        context,
      });

      // Original audio and background music are a single mutually-exclusive
      // toggle now: music plays exactly when original audio is off.
      if (!settings.originalAudio) {
        context.selectedMusicTrack = config.rendering.backgroundMusicEnabled
          ? this.music.selectLocalTrack(config.paths.musicDir, context.metadata?.mood)
          : ambientBedPath();
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

      let finalVideoPath = path.join(tempDir, "video_final.mp4");

      // ── CLOUD RENDER VIA GITHUB ACTIONS (4 vCPU, 7GB RAM) ────────────────────
      let cloudDone = false;
      if (process.env.CLOUD_RENDER_SHORTS !== "false") {
        try {
          // the runner burns captions only when captions.ass is in the bundle
          if (settings.captions) {
            const captionsPath = await this.writeCaptionsAss(context, context.originalVideoPath || path.join(tempDir, "video_raw.mp4"), useVoice);
            if (captionsPath) pipelineLogger.info("Captions prepared for the cloud render", "DirectUploader");
          }
          const cloudOut = await renderShortCloud(context, (detail) => {
            this.db.updateJob(id, { currentStep: detail });
          });
          if (cloudOut && fs.existsSync(cloudOut)) {
            finalVideoPath = cloudOut;
            cloudDone = true;
            pipelineLogger.checkpoint("✓ Short video successfully rendered via GitHub Actions Cloud runner", true, id);
          }
        } catch (cloudErr) {
          pipelineLogger.warn(
            `[DirectUploader] Cloud render error, using local FFmpeg fallback: ${cloudErr instanceof Error ? cloudErr.message : cloudErr}`,
            "DirectUploader"
          );
        }
      }

      // ── LOCAL ENCODING FALLBACK (If cloud render was skipped or failed) ────────
      if (!cloudDone) {
        if ((context as any)._bypassedRawVideo) {
          pipelineLogger.warn(
            "[DirectUploader] Cloud render was not completed — executing local raw video encoding fallback...",
            "DirectUploader",
          );
          const renderer = this.getRenderer(context);
          const origCloudEnv = process.env.CLOUD_RENDER_SHORTS;
          process.env.CLOUD_RENDER_SHORTS = "false";
          try {
            await renderer.processVideo(
              context.originalVideoPath!,
              rawVideoPath,
              context,
              {
                durationSeconds: config.rendering.videoDurationSeconds,
                fps: config.rendering.fps,
                effect: "none",
              },
            );
          } finally {
            process.env.CLOUD_RENDER_SHORTS = origCloudEnv;
            (context as any)._bypassedRawVideo = false;
          }
        }

        // 0 — Overlay the mood-matched reaction sticker (video-only pass, same
        // -c:v copy constraint as captions below — must happen before any
        // audio-mix step that copies the video stream unfiltered).
        let mixInputPath = rawVideoPath;
        if (settings.sticker) {
          const stickeredPath = await this.overlayReactionSticker(context, mixInputPath);
          if (stickeredPath && fs.existsSync(stickeredPath)) mixInputPath = stickeredPath;
        }

        // 1 — Burn captions in a dedicated video-filter pass (the audio mixes all
        // use -c:v copy and cannot carry a filter). The voiceover+no-music hook
        // branch burns its own subtitles, so skip pre-burning for that case.
        const captionsInHookBranch = useVoice && !musicTrack;
        if (settings.captions && !captionsInHookBranch) {
          const captionedPath = await this.burnCaptions(context, mixInputPath, useVoice);
          if (captionedPath && fs.existsSync(captionedPath)) mixInputPath = captionedPath;
        }

        // 2 — Strip the original audio first when the user turned it OFF
        let baseVideoPath = mixInputPath;
        if (!settings.originalAudio) {
          const mutedPath = path.join(tempDir, "video_muted.mp4");
          await new Promise<void>((resolve, reject) => {
            const muteCmd = `${config.binaries.ffmpeg} -y -i "${mixInputPath}" -an -c:v copy "${mutedPath}"`;
            exec(muteCmd, (error) => (error ? reject(error) : resolve()));
          });
          if (fs.existsSync(mutedPath)) {
            baseVideoPath = mutedPath;
          }
        }

        // 3 — Audio mix matrix (voiceover / original audio / music)
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
      }

      // 3.4 — Audio clearance: if the mixed audio still contains recognisable music, strip it
      // (keeps voiceover / isolated speech only) so a Content ID claim can't block the video.
      try {
        const cleared = await clearBackgroundMusic(
          finalVideoPath,
          path.join(tempDir, "video_final_cleared.mp4"),
          { voiceoverPath: useVoice ? voiceoverPath : undefined, tempDir, isolateSpeech: settings.originalAudio && !useVoice },
        );
        if (cleared.removed) {
          finalVideoPath = cleared.outputPath;
          pipelineLogger.warn(`Background music removed before publish (${cleared.match})`, "DirectUploader");
        }
      } catch (clearErr) {
        pipelineLogger.warn(
          `Audio clearance failed: ${clearErr instanceof Error ? clearErr.message : clearErr}`,
          "DirectUploader",
        );
      }

      // 3.5 — Append verdict / CTA sequence (CodeOrCap + Storiyum). Prompt Gag has no end-card: only the V2 clip follows the reel.
      const _pk = this.profile.key.toLowerCase();
      if (_pk === "codeorcap" || _pk === "storiyum" || _pk === "prompt_gag") {
        const withVerdictPath = path.join(tempDir, "video_with_verdict.mp4");
        const appended = await this.appendVerdictSequence(context, finalVideoPath, withVerdictPath);
        if (appended) finalVideoPath = withVerdictPath;
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

      // 5 — Manual Review with Auto-publish timeout
      pipelineLogger.checkpoint(
        "Compilation complete — sending for manual review with 60s auto-publish timeout",
        true,
        id,
      );
      await this.sendForManualReview(context, finalVideoPath, "");
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

      await this.notify.sendMessage(
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
   * The sticker's own audio is intentionally not mixed in (video-only overlay).
   *
   * Playback shape: the sticker's first play is the FULL ~10s clip (a "wind-up"
   * from a neutral pose into the reaction). Every play after that only repeats
   * the TAIL half — the 5s-10s "sustained reaction" segment — so the reaction
   * doesn't jar the viewer by resetting to the neutral pose every ~10s. This is
   * built by concatenating [full clip, once] + [5s-10s tail, looped forever]
   * into a single sticker stream, then `shortest=1` on the outer overlay caps
   * the result at the base video's own length, so it neither freezes nor
   * disappears no matter how long the video runs.
   *
   * ffmpeg's `-stream_loop` does not loop correctly when combined with an
   * `-ss/-t` trim on the same input, so the 5s-10s tail is first extracted
   * into its own standalone temp file (a fast, frame-accurate `-c copy` cut —
   * ProRes 4444 is all-intra, so every frame is a keyframe) and that separate
   * file is the one that gets `-stream_loop -1`'d.
   *
   * Returns the composited path, or null when no sticker asset exists yet for
   * this mood.
   */
  private async overlayReactionSticker(
    context: PipelineContext,
    inputPath: string,
  ): Promise<string | null> {
    const mood = normalizeMood(context.metadata?.mood);
    const stickerDir = path.join(
      config.paths.assetsDir,
      "stickers",
      this.profile.key.toLowerCase(),
    );

    let stickerPath = "";
    const isPromptGag = this.profile.key.toLowerCase() === "prompt_gag";

    if (isPromptGag) {
      if (fs.existsSync(stickerDir)) {
        const files = fs.readdirSync(stickerDir).filter((f) => f.endsWith(".mp4") || f.endsWith(".mov"));
        if (files.length > 0) {
          // Select one random laughing sticker for each video compile!
          const randomFile = files[Math.floor(Math.random() * files.length)];
          stickerPath = path.join(stickerDir, randomFile);
        }
      }
    } else {
      stickerPath = path.join(stickerDir, `${mood}.mov`);
    }

    if (!stickerPath || !fs.existsSync(stickerPath)) {
      pipelineLogger.info(
        `Reaction sticker requested but none available for mood "${mood}" in profile "${this.profile.key}" — skipping.`,
        "DirectUploader",
      );
      return null;
    }

    const outPath = path.join(context.tempDir, "video_stickered.mp4");

    if (isPromptGag) {
      try {
        // Loop the entire green screen sticker, crop the bottom 120px to remove watermarks,
        // scale it to width 360 (matching CodeOrCap size), and chromakey out the background (0x00FF00 green)
        const stickerInputs = `-stream_loop -1 -i "${stickerPath}"`;
        const stickerFilter =
          `[1:v]crop=in_w:in_h-120:0:0,scale=360:-1,chromakey=0x00FF00:0.3:0.1[sticker];` +
          `[0:v][sticker]overlay=40:H-h-40:shortest=1[out]`;

        const cmd = `${config.binaries.ffmpeg} -y -i "${inputPath}" ${stickerInputs} -filter_complex "${stickerFilter}" -map "[out]" -map 0:a? -c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p -c:a copy "${outPath}"`;
        await new Promise<void>((resolve, reject) => {
          exec(cmd, (error) => (error ? reject(error) : resolve()));
        });
        pipelineLogger.info(
          `Overlaid keyed "${path.basename(stickerPath)}" green screen sticker (looped).`,
          "DirectUploader",
        );
        return outPath;
      } catch (err) {
        pipelineLogger.warn(
          `Reaction sticker overlay failed, continuing without it: ${err instanceof Error ? err.message : err}`,
          "DirectUploader",
        );
        return null;
      }
    }

    const stickerTailPath = path.join(context.tempDir, "sticker_tail.mov");
    const tailStart = 5;
    const tailLength = 5;

    try {
      // Pre-cut the "sustained reaction" tail (5s-10s) into its own file so it
      // can be `-stream_loop`'d cleanly (see doc comment above for why).
      const trimCmd = `${config.binaries.ffmpeg} -y -ss ${tailStart} -t ${tailLength} -i "${stickerPath}" -c copy -an "${stickerTailPath}"`;
      await new Promise<void>((resolve, reject) => {
        exec(trimCmd, (error) => (error ? reject(error) : resolve()));
      });

      // Input 1 = the full sticker, played once. Input 2 = the pre-cut tail,
      // looped indefinitely. concat stitches them into one continuous sticker
      // stream: [0-10s full][10-15s tail][15-20s tail][20-25s tail]...
      const stickerInputs = `-i "${stickerPath}" -stream_loop -1 -i "${stickerTailPath}"`;
      const stickerFilter =
        `[1:v]setpts=PTS-STARTPTS[full];` +
        `[2:v]setpts=PTS-STARTPTS[tail];` +
        `[full][tail]concat=n=2:v=1:a=0[stickerloop];` +
        `[0:v][stickerloop]overlay=40:H-h-40:shortest=1[out]`;
      const cmd = `${config.binaries.ffmpeg} -y -i "${inputPath}" ${stickerInputs} -filter_complex "${stickerFilter}" -map "[out]" -map 0:a? -c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p -c:a copy "${outPath}"`;
      await new Promise<void>((resolve, reject) => {
        exec(cmd, (error) => (error ? reject(error) : resolve()));
      });
      pipelineLogger.info(
        `Overlaid "${mood}" reaction sticker (full wind-up once, looping tail thereafter).`,
        "DirectUploader",
      );
      return outPath;
    } catch (err) {
      pipelineLogger.warn(
        `Reaction sticker overlay failed, continuing without it: ${err instanceof Error ? err.message : err}`,
        "DirectUploader",
      );
      return null;
    } finally {
      if (fs.existsSync(stickerTailPath)) {
        fs.unlinkSync(stickerTailPath);
      }
    }
  }

  private async getVoiceoverTranscript(
    context: PipelineContext,
  ): Promise<Array<{ word: string; start: number; end: number }> | null> {
    if ((context as any).ttsTranscript?.words?.length) {
      return (context as any).ttsTranscript.words;
    }
    const voiceoverPath = (context as any).voiceoverPath;
    if (voiceoverPath && fs.existsSync(voiceoverPath)) {
      pipelineLogger.info(
        "Transcribing generated voiceover for precise word-level timing...",
        "DirectUploader",
      );
      try {
        // Hindi voice (every channel but CodeOrCap): tell Whisper, so the captions come back in Devanagari, not Roman Hinglish
        const ttsTranscript = await TranscriptionService.transcribeFile(
          voiceoverPath,
          context.tempDir,
          this.profile.key.toLowerCase() === "codeorcap" ? undefined : { language: "hi" },
        );
        if (ttsTranscript && ttsTranscript.words && ttsTranscript.words.length > 0) {
          (context as any).ttsTranscript = ttsTranscript;
          return ttsTranscript.words;
        }
      } catch (err) {
        pipelineLogger.warn(
          `Failed to transcribe generated voiceover: ${err instanceof Error ? err.message : err}`,
          "DirectUploader",
        );
      }
    }
    return null;
  }

  /**
   * The caption file (captions.ass) for a Short: text from the generated voiceover (word timings from Whisper, told the voice is Hindi
   * so the words come back in Devanagari) or, without a voiceover, from the reel's own transcript. Used by the local burn below and
   * by the cloud render, which only burns captions when this file is in its bundle. Returns null when there is nothing to caption.
   */
  private async writeCaptionsAss(
    context: PipelineContext,
    inputPath: string,
    useVoice: boolean,
  ): Promise<string | null> {
    const tempDir = context.tempDir;
    try {
      let wordTimings: Array<{ word: string; start: number; end: number }> = [];
      if (useVoice && context.metadata?.voiceoverScript) {
        const ttsTimings = await this.getVoiceoverTranscript(context);
        if (ttsTimings) {
          wordTimings = ttsTimings;
          // Hindi channels: caption the script that was actually spoken (Devanagari), timed by where the voice was heard
          try {
            const set = context.clonedVoice ? await context.clonedVoice : null;
            const spoken = set?.spokenText("claim");
            if (spoken && /[\u0900-\u097F]/.test(spoken) && ttsTimings.length) {
              const aligned = alignScriptToSpan(spoken, ttsTimings[0].start, ttsTimings[ttsTimings.length - 1].end);
              if (aligned.length) wordTimings = aligned;
            }
          } catch {
            /* keep Whisper's words */
          }
        } else {
          wordTimings = estimateWordTimings(
            context.metadata.voiceoverScript,
            context.ttsDuration || 10,
          );
        }
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
      return assPath;
    } catch (err) {
      pipelineLogger.warn(`Caption file could not be made: ${err instanceof Error ? err.message : err}`, "DirectUploader");
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
      const assPath = await this.writeCaptionsAss(context, inputPath, useVoice);
      if (!assPath) return null;

      const escapedAssPath = assPath
        .replace(/\\/g, "/")
        .replace(/:/g, "\\:")
        .replace(/'/g, "'\\\\''");
      const outPath = path.join(tempDir, "video_raw_captioned.mp4");
      const cmd = `${config.binaries.ffmpeg} -nostdin -hide_banner -loglevel error -y -i "${inputPath}" -vf "subtitles='${escapedAssPath}'" -c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p -c:a copy -movflags +faststart "${outPath}"`;
      await new Promise<void>((resolve, reject) => {
        exec(cmd, { maxBuffer: 64 * 1024 * 1024 }, (error) => (error ? reject(error) : resolve()));
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
  /**
   * Mix the voiceover over the original video's audio for its FULL duration
   * (voiceover ON, music OFF). Previously this built a separate "hook"
   * segment truncated to the voiceover's length and concatenated it with an
   * untrimmed copy of the whole video — which duplicated the opening seconds
   * and, worse, silenced the original audio for the rest of the video once
   * the voiceover's short duration was hit by a `-shortest`/`duration=shortest`
   * combo. Now it's a single-pass sidechain duck, matching the same pattern
   * used for music: the voice is padded with silence to the video's full
   * length before it's split (so the sidechain key never runs dry early —
   * that was what silenced the bed audio entirely, not just stopped ducking
   * it), and the original audio sits at its natural volume so it plays at
   * full presence once the voice ends, not a permanently-attenuated level.
   */
  private async renderVoiceoverHook(
    context: PipelineContext,
    inputPath: string,
    voiceoverPath: string,
    outputPath: string,
    includeCaptions: boolean,
  ): Promise<void> {
    const tempDir = context.tempDir;

    let duration = context.ttsDuration || 10;
    try {
      const stdout = execSync(
        `"${config.binaries.ffprobe}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
      )
        .toString()
        .trim();
      const parsed = parseFloat(stdout);
      if (!isNaN(parsed) && parsed > 0) duration = parsed;
    } catch (probeErr) {
      pipelineLogger.warn(
        "Failed to probe video duration for voiceover mix, using TTS duration as fallback",
        "DirectUploader",
      );
    }

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

    let subtitlesFilter = "";
    const script = context.metadata?.voiceoverScript;
    if (script && includeCaptions) {
      try {
        const assPath = path.join(tempDir, "subtitles.ass");
        const ttsTimings = await this.getVoiceoverTranscript(context);
        const wordTimings = ttsTimings || estimateWordTimings(script, context.ttsDuration || 10);
        const lines = groupWordsIntoLines(wordTimings);
        generateASSFile(lines, assPath);
        const escapedAssPath = assPath
          .replace(/\\/g, "/")
          .replace(/:/g, "\\:")
          .replace(/'/g, "'\\\\''");
        subtitlesFilter = `subtitles='${escapedAssPath}'`;
      } catch (subErr) {
        pipelineLogger.error(
          "Failed to generate ASS subtitles, continuing without captions",
          subErr,
          "DirectUploader",
        );
      }
    }

    const fps = config.rendering.fps || 30;
    const videoFilter = subtitlesFilter ? `[0:v]${subtitlesFilter}[vout];` : "";
    const videoMap = subtitlesFilter ? `-map "[vout]"` : `-map 0:v:0`;
    const videoCodec = subtitlesFilter
      ? `-c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p -r ${fps}`
      : `-c:v copy`;

    const audioFilter = hasAudio
      ? `[1:a]apad=whole_dur=${duration}[vopad];` +
        `[vopad]asplit=2[vokey][vomix];` +
        `[0:a]volume=1.0[bg];` +
        `[bg][vokey]sidechaincompress=threshold=0.05:ratio=15:attack=10:release=300[bg_ducked];` +
        `[vomix]volume=2.0[vo];` +
        `[vo][bg_ducked]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,atrim=0:${duration}[aout]`
      : `[1:a]apad=whole_dur=${duration},volume=2.0,atrim=0:${duration}[aout]`;

    const cmd = `${config.binaries.ffmpeg} -y -i "${inputPath}" -i "${voiceoverPath}" -filter_complex "${videoFilter}${audioFilter}" ${videoMap} -map "[aout]" ${videoCodec} -c:a aac -ar 44100 -ac 2 "${outputPath}"`;

    pipelineLogger.info(
      `Mixing voiceover over original audio for full video duration (hasAudio=${hasAudio}, duration=${duration.toFixed(1)}s)...`,
      "DirectUploader",
    );

    await new Promise<void>((resolve, reject) => {
      exec(cmd, (error) => (error ? reject(error) : resolve()));
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
    const chatId = context.sourceMeta.chatId;
    const messageId = context.sourceMeta.messageId;

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
    const explanationLine = metadata.howItWorks
      ? `💡 *How It Works:* ${escapeMarkdown(metadata.howItWorks)}\n\n`
      : "";
    const isCompileFailure = bannerLine && bannerLine.includes("Auto-publish aborted");
    const timerText = isCompileFailure
      ? `⏳ _Waiting for review action..._`
      : `⏳ _Auto-publishes in 1 minute if no action taken._`;
    const caption =
      bannerLine +
      `📋 *Review your Short*\n\n` +
      fallbackWarningLine +
      `*Title:* ${escapeMarkdown(metadata.title)}\n\n` +
      `*Description:* ${escapeMarkdown(metadata.description.slice(0, 200))}…\n\n` +
      explanationLine +
      musicCaptionLine +
      timerText;

    let reviewMessageId = 0;
    if (chatId && chatId > 0) {
      try {
        reviewMessageId = await this.notify.sendVideoForReview(
          chatId,
          reviewVideoPath,
          caption,
          id,
          messageId,
        );
      } catch (err) {
        pipelineLogger.warn(
          `Failed to send video review for ${id}: ${err instanceof Error ? err.message : err}`,
          "DirectUploader",
        );
      }
    } else {
      pipelineLogger.info(
        `[DirectUploader] Automated headless pipeline for ${id} (no admin chatId) — skipping Telegram review, auto-publishing.`,
        "DirectUploader",
      );
    }

    const pendingUpload: PendingUpload = {
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
    };

    const isManualInject = isManualInjectContext(context);

    if (!isCompileFailure) {
      if (isManualInject) {
        pipelineLogger.info(
          `[DirectUploader] Manual injected reel (${id}) — awaiting explicit user publish approval. Auto-publish timer DISABLED.`,
          "DirectUploader",
        );
      } else {
        const delayMs = chatId && chatId > 0 ? 60000 : 2000;
        pendingUpload.timer = setTimeout(() => {
          pipelineLogger.info(
            `Review timeout for ${id} — auto-publishing.`,
            "DirectUploader",
          );
          this.onPublish(id);
        }, delayMs);
      }
    }

    this.pending.set(id, pendingUpload);

    this.db.updateJob(id, {
      status: "final_review",
      currentStep: isCompileFailure || isManualInject
        ? "Waiting for manual publish approval."
        : "Waiting for manual publish review (60s timer)",
      context,
    });

    pipelineLogger.checkpoint(
      isCompileFailure
        ? "Manual review sent to Telegram"
        : "Manual review sent to Telegram with 60s auto-publish timer",
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
    await this.notify
      .removeInlineButtons(chatId, pendingUpload.reviewMessageId)
      .catch(() => {});

    // 3. Notify user that we are re-processing
    await this.notify.sendMessage(
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
    await this.notify
      .removeInlineButtons(chatId, pendingUpload.reviewMessageId)
      .catch(() => {});

    // 4. Notify user that we are downloading and applying the new music track
    await this.notify.sendMessage(
      chatId,
      `🎵 *Custom audio track received:* \`"${fileName}"\`\n\nDownloading and mixing with your Short...`,
      messageId,
    );

    const context = pendingUpload.context;
    const extension = path.extname(fileName) || ".mp3";
    const customMusicPath = path.join(context.tempDir, `custom_music${extension}`);

    try {
      // 5. Download the file
      await this.notify.downloadFile(fileId, customMusicPath);
      context.selectedMusicTrack = customMusicPath;

      // 6. Regenerate the final video using the new custom music track!
      await this.regenerateAudioMix(pendingUpload);
      
      // 7. Resend the review message with the new audio mix
      await this.resendReviewVideo(pendingUpload);
      return true;
    } catch (err: any) {
      pipelineLogger.error(`Failed to handle user audio upload for ${pendingId}`, err, "DirectUploader");
      await this.notify.sendMessage(
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

    if (pendingUpload.timer) {
      clearTimeout(pendingUpload.timer);
      pendingUpload.timer = setTimeout(() => {
        pipelineLogger.info(
          `Review timeout for ${id} — auto-publishing.`,
          "DirectUploader",
        );
        this.onPublish(id);
      }, 60000);
    }
    const hasTimer = !!pendingUpload.timer;
    const timerText = hasTimer
      ? `⏳ _Auto-publishes in 1 minute if no action taken._`
      : `⏳ _Waiting for review action..._`;

    const statusText = context.useVoiceover ? "🔊 Voiceover: **ON**" : "🔇 Voiceover: **OFF**";
    const fallbackWarningLine = context.metadataIsFallback
      ? `❌ *AI metadata FAILED — generic template in use. Tap 🔄 Regenerate!*\n\n`
      : "";
    const explanationLine = metadata.howItWorks
      ? `💡 *How It Works:* ${escapeMarkdown(metadata.howItWorks)}\n\n`
      : "";
    const caption =
      `📋 *Review your Short*\n\n` +
      fallbackWarningLine +
      `*Title:* ${escapeMarkdown(metadata.title)}\n\n` +
      `*Description:* ${escapeMarkdown(metadata.description.slice(0, 200))}…\n\n` +
      explanationLine +
      statusText + `\n\n` +
      (pendingUpload.musicCaptionLine || "") +
      timerText;

    const newMsgId = await this.notify.editReviewVideo(
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

  private async getVideoDuration(videoPath: string): Promise<number> {
    return new Promise<number>((resolve) => {
      const cmd = `${config.binaries.ffprobe} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
      exec(cmd, (err, stdout) => {
        const parsed = parseFloat(stdout?.trim());
        resolve(!err && !isNaN(parsed) && parsed > 0 ? parsed : 30);
      });
    });
  }

  private async renderScorePng(score: number, outputPath: string): Promise<void> {
    const W = 620;
    const H = 200;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs>
        <linearGradient id="scoreBg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#141923" stop-opacity="0.95"/>
          <stop offset="100%" stop-color="#0a0d14" stop-opacity="0.95"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${H}" rx="28" ry="28" fill="url(#scoreBg)"/>
      <rect x="4" y="4" width="${W - 8}" height="${H - 8}" rx="24" ry="24"
            fill="none" stroke="#FFB800" stroke-width="5"/>
      <text x="${W / 2}" y="60"
            font-family="Arial, -apple-system, sans-serif"
            font-size="30" font-weight="900" letter-spacing="3"
            fill="#8b949e" text-anchor="middle">FACT CHECK SCORE</text>
      <text x="${W / 2}" y="158"
            font-family="Arial Black, Arial, -apple-system, sans-serif"
            font-size="96" font-weight="900"
            fill="#FFB800" text-anchor="middle">${score} <tspan font-size="52" fill="#e6edf3">/ 10</tspan></text>
    </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(outputPath);
  }

  private verdictCategory(verdict: string): { label: string; color: string } {
    const v = verdict.toLowerCase();
    if (v.includes("partially true") || v.includes("mostly true") || v.includes("largely true"))
      return { label: "PARTIALLY TRUE", color: "#FFD700" };
    if (v.includes("partially false") || v.includes("partially wrong") || v.includes("misleading") || v.includes("mostly false"))
      return { label: "PARTIALLY WRONG", color: "#FF8C00" };
    if (v.includes("false") || v.includes("wrong") || v.includes("incorrect") || v.includes("fake") || v.includes("myth"))
      return { label: "WRONG", color: "#FF4444" };
    if (v.includes("true") || v.includes("correct") || v.includes("accurate") || v.includes("verified") || v.includes("fact"))
      return { label: "TRUE", color: "#00CC66" };
    return { label: "UNVERIFIED", color: "#FFFFFF" };
  }

  /**
   * Appends a verdict / CTA sequence to the end of the compiled video.
   *
   * Supported profiles:
   *   codeorcap — verdict + score PNG, avatar bg (codeorcap_verdict_bg.mp4)
   *               Falls back to blurred-frame + animated sticker when asset is absent.
   *   storiyum  — CTA only (no score), avatar bg (storiyum_cta.mp4), cloned Storiyum voice.
   *               Skips silently when asset is absent.
   *
   * Avatar mode uses the clip's original audio; verdict category and score are shown
   * as drawtext overlays timed to the avatar's speech (Whisper transcript timestamps).
   */
  private async appendVerdictSequence(
    context: PipelineContext,
    mainVideoPath: string,
    outputPath: string,
  ): Promise<boolean> {
    const profileKey = this.profile.key.toLowerCase();

    const tempDir = context.tempDir;
    const stickerTailPath = path.join(tempDir, "verdict_sticker_tail.mov");
    // Intermediate TTS files — cleaned up in finally
    const ttsIntermediates = [
      path.join(tempDir, "vd_seg1.mp3"),
      path.join(tempDir, "vd_seg2.mp3"),
      path.join(tempDir, "vd_seg1_s.mp3"),
      path.join(tempDir, "vd_seg2_s.mp3"),
      path.join(tempDir, "vd_silence.mp3"),
      path.join(tempDir, "vd_concat.txt"),
      path.join(tempDir, "transition_tts.mp3"),
      path.join(tempDir, "transition_bg_frame.png"),
      path.join(tempDir, "transition_clip.mp4"),
      path.join(tempDir, "transition_text.txt"),
      path.join(tempDir, "pexels_broll.mp4"),
    ];

    // Per-profile config: avatar asset file + Whisper transcript timings
    const PROFILE_CFG = {
      codeorcap: {
        assetFile:    "codeorcap_verdict_bg.mp4",
        ttsKey:       "codeorcap",          // voice key for TTSService
        seg1Target:   3.46,                 // (fallback mode only)
        gapDuration:  0.60,
        seg2Target:   3.76,
        // codeorcap_verdict_bg.mp4, word timings (Whisper): "The verdict of this video is" 0.56–2.34s, then a ~0.6s pause,
        // "out of 10." 3.0–3.5s, "For more info, check the caption." 4.3–5.5s, "For tech reels, follow." 6.7–7.8s.
        // The spoken score goes into the pause.
        numberGapStart: 2.38,
        numberGapEnd:   2.98,
        scoreEnabled: true as const,
        scorePinStart: "2.35",              // score badge appears as the number is spoken
        scorePinEnd:   "7.80",              // stays visible through the entire verdict & outro
        scoreFadeOut:  "7.40",
      },
      storiyum: {
        assetFile:    "storiyum_cta.mp4",
        ttsKey:       "storiyum_cta",       // English female voice (NeerjaNeural)
        seg1Target:   1.44,                 // Whisper: 0.00–1.44s
        gapDuration:  0.88,                 // Whisper: 1.44–2.32s
        seg2Target:   0.82,                 // Whisper: 2.32–3.14s
        scoreEnabled: false as const,
      },
      // Prompt Gag (finance): no end-card: the Short is the reel, then the insight clip (V2)
      prompt_gag: {
        assetFile:    "",
        ttsKey:       "prompt_gag",
        seg1Target:   0,
        gapDuration:  0,
        seg2Target:   0,
        scoreEnabled: false as const,
        noEndCard:    true as const,
      },
    } as const;

    type ProfileKey = keyof typeof PROFILE_CFG;
    const cfg = (PROFILE_CFG as Record<string, typeof PROFILE_CFG[ProfileKey]>)[profileKey];
    if (!cfg) return false;
    const noEndCard = (cfg as { noEndCard?: boolean }).noEndCard === true;
    if (noEndCard && !insightEnabledFor(profileKey, this.profile.watch?.outroVersion)) return false;

    try {
      const customBgPath = path.join(config.paths.assetsDir, "verdict-clips", cfg.assetFile);
      const useAvatarBg  = fs.existsSync(customBgPath);

      // factCheckScore is stored on a 1–10 scale; clamp to that range
      const rawFCS = context.metadata?.factCheckScore ?? 7;
      const score  = Math.min(10, Math.max(1, Math.round(rawFCS)));

      // Cross-platform font path resolution for drawtext filters
      const fontCandidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/arial.ttf",
      ];
      let fontFile = "'Arial'";
      for (const fc of fontCandidates) {
        if (fs.existsSync(fc)) {
          fontFile = `'${fc}'`;
          break;
        }
      }

      const verdictClipPath = path.join(tempDir, "verdict_clip.mp4");

      if (!noEndCard) {
      // 1 — Resolve sticker (CodeOrCap fallback only — Storiyum skips if asset missing)
      let stickerPath = "";
      if (!useAvatarBg) {
        if (profileKey !== "codeorcap") {
          pipelineLogger.info(`CTA asset not found for "${profileKey}" — skipping.`, "DirectUploader");
          return false;
        }
        const mood = normalizeMood(context.metadata?.mood);
        stickerPath = path.join(config.paths.assetsDir, "stickers", profileKey, `${mood}.mov`);
        if (!fs.existsSync(stickerPath)) {
          pipelineLogger.info(
            `Verdict sequence: no sticker for mood "${mood}" and no avatar bg — skipping.`,
            "DirectUploader",
          );
          return false;
        }
      }

      // 2 — Audio/timing setup
      // Avatar mode uses the clip's own original audio (no TTS needed).
      // Fallback mode generates TTS.
      let ttsTempPath: string = "";
      let clipDuration: number;
      let scoreShowStart: string;
      let scoreShowEnd: string;
      let scoreFadeOutStart: string;

      if (useAvatarBg) {
        clipDuration      = await this.getVideoDuration(customBgPath);
        scoreShowStart    = cfg.scoreEnabled ? (cfg as any).scorePinStart : "-1";
        scoreShowEnd      = cfg.scoreEnabled ? (cfg as any).scorePinEnd   : "-1";
        scoreFadeOutStart = cfg.scoreEnabled ? (cfg as any).scoreFadeOut  : "-1";
      } else {
        // ── FALLBACK MODE: TTS, heuristic timing ─────────────────────────────────
        const verdict   = context.metadata?.verdict ?? "this video delivers quality content";
        const ttsScript =
          `The verdict of this video is: ${verdict}. ` +
          `Score: ${score} out of 10. ` +
          `For more info, check the caption. ` +
          `For tech reels, follow CodeOrCap.`;
        const singlePath = path.join(tempDir, "verdict_tts.mp3");
        let ttsDuration: number;
        try {
          ttsDuration = await this.tts.generateVoiceover(ttsScript, singlePath, profileKey);
        } catch (err) {
          pipelineLogger.warn(
            `Verdict TTS failed — skipping: ${err instanceof Error ? err.message : err}`,
            "DirectUploader",
          );
          return false;
        }
        ttsTempPath  = singlePath;
        clipDuration = ttsDuration + 1.0;

        const start = Math.max(1.5, ttsDuration * 0.40);
        const end   = Math.min(clipDuration - 0.5, start + 3.0);
        scoreShowStart    = start.toFixed(2);
        scoreShowEnd      = end.toFixed(2);
        scoreFadeOutStart = (end - 0.40).toFixed(2);
      }

      // 3 — Render score PNG (CodeOrCap only)
      const scorePngPath = path.join(tempDir, "verdict_score.png");
      if (cfg.scoreEnabled) await this.renderScorePng(score, scorePngPath);

      if (useAvatarBg) {
        let filterComplex: string;
        let mapArgs: string;
        let extraInputs = "";

        if (cfg.scoreEnabled) {
          // CodeOrCap: [0]=avatar clip  [1]=score PNG  [2]=spoken score
          // The recorded person says "…the verdict of this video is … out of 10" and leaves a ~0.6s pause for the number:
          // fill exactly that pause with the score as a short word at his level (see audio/verdictNumber.ts).
          const gapStart = (cfg as any).numberGapStart as number;
          const gapEnd = (cfg as any).numberGapEnd as number;
          // One voice: when the cloned verdict assets exist, the whole audio (phrases + score) is the cloned voice, each part fitted
          // to the moment his lips move (src/audio/clonedVerdict.ts); otherwise the recorded audio is kept and the score is placed in the pause.
          const clonedAudio =
            profileKey === "codeorcap" && clonedVoiceEnabled(profileKey)
              ? await buildClonedVerdictAudio(score, path.join(tempDir, "verdict_cloned.wav"), undefined, clipDuration)
              : null;
          const spoken = clonedAudio ? null : await prepareScoreAudio(score, tempDir, this.tts, gapEnd - gapStart, path.join(config.paths.assetsDir, "verdict-clips", "scores"));
          const numberTtsPath = clonedAudio ?? spoken?.path ?? "";
          const numberDelayMs = Math.round(gapStart * 1000);

          const { label: verdictLabel, color: verdictColor } = this.verdictCategory(
            context.metadata?.verdict ?? "",
          );
          const hasNumberTts = !!numberTtsPath && fs.existsSync(numberTtsPath);
          extraInputs = `-loop 1 -i "${scorePngPath}" ` + (hasNumberTts ? `-i "${numberTtsPath}" ` : "");
          filterComplex = [
            `[0:v]setpts=PTS-STARTPTS[bg]`,
            `[1:v]fade=in:st=${scoreShowStart}:d=0.4,fade=out:st=${scoreFadeOutStart}:d=0.4[scoreCard]`,
            `[bg][scoreCard]overlay=x=(W-overlay_w)/2:y=H*0.08:shortest=1:enable='between(t,${scoreShowStart},${scoreShowEnd})'[withScore]`,
            `[withScore]drawtext=fontfile=${fontFile}:text='${verdictLabel}':fontsize=90:fontcolor=${verdictColor}` +
              `:x=(w-tw)/2:y=h*0.80:shadowcolor=black:shadowx=5:shadowy=5` +
              `:box=1:boxcolor=black@0.65:boxborderw=20` +
              `:enable='between(t,0.3,${scoreShowEnd})'[out_v]`,
            ...(clonedAudio
              ? [`[2:a]acopy[out_a]`] // the cloned voice is the whole audio: the recorded one is dropped
              : hasNumberTts
              ? [
                  // his own audio is untouched (he is silent in the pause); the number is placed at the pause
                  `[2:a]adelay=${numberDelayMs}|${numberDelayMs}[num]`,
                  `[0:a][num]amix=inputs=2:duration=first:normalize=0[out_a]`,
                ]
              : [`[0:a]acopy[out_a]`]),
          ].join(";");
          mapArgs = `-map "[out_v]" -map "[out_a]"`;
        } else {
          // Storiyum: avatar clip video, no text overlays. The audio is the Storiyum cloned voice (the same voice as the narration)
          // placed where the lips move; the recorded audio is kept when the cloned phrases are missing or the cloud voice is off.
          const clonedCta =
            profileKey === "storiyum" && clonedVoiceEnabled(profileKey)
              ? await buildClonedCtaAudio(path.join(tempDir, "cta_cloned.wav"), STORIYUM_CTA_PARTS, undefined, clipDuration)
              : null;
          if (clonedCta) extraInputs = `-i "${clonedCta}" `;
          filterComplex = `[0:v]setpts=PTS-STARTPTS[out_v]`;
          mapArgs = clonedCta ? `-map "[out_v]" -map 1:a` : `-map "[out_v]" -map 0:a`;
        }

        await new Promise<void>((resolve, reject) => {
          exec(
            `${config.binaries.ffmpeg} -y ` +
            `-i "${customBgPath}" ` +
            extraInputs +
            `-filter_complex "${filterComplex}" ` +
            `${mapArgs} ` +
            `-c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p -r 30 ` +
            `-c:a aac -ar 44100 -ac 2 ` +
            `"${verdictClipPath}"`,
            (err) => (err ? reject(err) : resolve()),
          );
        });
      } else {
        // ── FALLBACK MODE ────────────────────────────────────────────────────────
        // Blur last frame of main video as background, animate sticker to centre.
        // Inputs: [0]=bg  [1]=sticker full  [2]=sticker tail (looped)  [3]=score PNG  [4]=TTS audio
        const mainDuration = await this.getVideoDuration(mainVideoPath);
        const frameTime = Math.max(0, mainDuration - 0.5).toFixed(2);
        const bgFramePath = path.join(tempDir, "verdict_bg_frame.png");
        await new Promise<void>((resolve, reject) => {
          const cmd = `${config.binaries.ffmpeg} -y -ss ${frameTime} -i "${mainVideoPath}" -vframes 1 "${bgFramePath}"`;
          exec(cmd, (err) => (err ? reject(err) : resolve()));
        });

        // Pre-cut sticker tail for looping (same technique as overlayReactionSticker)
        await new Promise<void>((resolve, reject) => {
          const cmd = `${config.binaries.ffmpeg} -y -ss 5 -t 5 -i "${stickerPath}" -c copy -an "${stickerTailPath}"`;
          exec(cmd, (err) => (err ? reject(err) : resolve()));
        });

        const bgInputArgs = `-loop 1 -t ${clipDuration.toFixed(2)} -i "${bgFramePath}"`;
        const filterComplex = [
          `[0:v]boxblur=20:20,colorlevels=romax=0.35:gomax=0.35:bomax=0.35[bg]`,
          `[1:v]setpts=PTS-STARTPTS[stickerFull]`,
          `[2:v]setpts=PTS-STARTPTS[stickerTail]`,
          `[stickerFull][stickerTail]concat=n=2:v=1:a=0[stickerLooped]`,
          `[stickerLooped]scale=550:-1[stickerScaled]`,
          `[bg][stickerScaled]overlay=` +
            `x='if(lt(t,1.5),40+(W/2-overlay_w/2-40)*(t/1.5),(W-overlay_w)/2)':` +
            `y='if(lt(t,1.5),(H-overlay_h-40)+((H-overlay_h)/2-(H-overlay_h-40))*(t/1.5),(H-overlay_h)/2)':` +
            `shortest=1[withSticker]`,
          `[3:v]fade=in:st=${scoreShowStart}:d=0.4,fade=out:st=${scoreFadeOutStart}:d=0.4[scoreCard]`,
          `[withSticker][scoreCard]overlay=x=(W-overlay_w)/2:y=H*0.08:enable='between(t,${scoreShowStart},${scoreShowEnd})'[out]`,
        ].join(";");

        const cmd =
          `${config.binaries.ffmpeg} -y ` +
          `${bgInputArgs} ` +
          `-i "${stickerPath}" ` +
          `-stream_loop -1 -i "${stickerTailPath}" ` +
          `-i "${scorePngPath}" ` +
          `-i "${ttsTempPath}" ` +
          `-filter_complex "${filterComplex}" ` +
          `-map "[out]" -map "4:a" ` +
          `-c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p ` +
          `-c:a aac -shortest ` +
          `"${verdictClipPath}"`;

        await new Promise<void>((resolve, reject) => {
          exec(cmd, (err) => (err ? reject(err) : resolve()));
        });
      }
      } // end of the verdict / CTA end-card (not for noEndCard channels)

      // 3.5 — Generate transition clip (if Outro Version is v2)
      const transitionClipPath = path.join(tempDir, "transition_clip.mp4");
      const transitionTtsPath = path.join(tempDir, "transition_tts.mp3");
      const transitionBgFramePath = path.join(tempDir, "transition_bg_frame.png");
      const transitionTextPath = path.join(tempDir, "transition_text.txt");
      const hasTransition = insightEnabledFor(profileKey, this.profile.watch?.outroVersion);

      if (hasTransition) {
        pipelineLogger.info(
          "Generating V2 transition clip explaining how it works (Pexels cinematic b-roll)...",
          "DirectUploader",
        );

        const workflowData = this.deriveTranscriptionWorkflow(context);
        const rawExplanation = workflowData.explanation;

        // One cloned voice: the lines the cloud run spoke for this clip, used only when they are exactly the lines the clip narrates now.
        let clonedHiwFiles: string[] | undefined;
        if (context.clonedVoice) {
          const set = await context.clonedVoice;
          const lines = howItWorksLines(rawExplanation, insightIntro(profileKey));
          const asked = context.clonedHowItWorksLines ?? [];
          const files = lines.map((_, i) => set?.file(`hiw_${i}`));
          if (set && lines.length === asked.length && lines.every((l, i) => l === asked[i]) && files.every(Boolean)) clonedHiwFiles = files as string[];
          else pipelineLogger.info("Cloned how-it-works narration is not usable for this clip: the clip uses its own voice", "DirectUploader");
        }

        // Preferred: build the clip with my-video (GitHub cloud render). Any problem -> the Pexels route below, as before.
        let myVideoDone = false;
        try {
          const myVideoClip = path.join(tempDir, "hiw_myvideo.mp4");
          const rendered = await renderHowItWorksClip(
            // the short's own diagram (not the generic placeholder deriveTranscriptionWorkflow invents when it is missing)
            { explanation: rawExplanation, intro: insightIntro(profileKey), title2: insightTitle(profileKey), language: insightLang(process.env, profileKey), title: context.metadata?.title, mermaid: context.metadata?.diagramWorkflow, diagramTitle: workflowData.diagramTitle, narrationFiles: clonedHiwFiles },
            myVideoClip,
          );
          if (rendered) {
            // normalise to the short's format (1080x1920, 30 fps, 44.1 kHz stereo, broadcast loudness) so the concat below accepts it
            await new Promise<void>((resolve, reject) => {
              const cmd =
                `${config.binaries.ffmpeg} -y -i "${myVideoClip}" ` +
                `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30" ` +
                `-af "aresample=44100,loudnorm=I=-16:TP=-1.5:LRA=11" -ar 44100 -ac 2 ` +
                `-c:v libx264 -preset superfast -crf 20 -pix_fmt yuv420p -c:a aac "${transitionClipPath}"`;
              exec(cmd, (err) => (err ? reject(err) : resolve()));
            });
            myVideoDone = fs.existsSync(transitionClipPath) && fs.statSync(transitionClipPath).size > 1000;
          }
        } catch (myVideoErr) {
          pipelineLogger.warn(
            `my-video transition clip unusable, falling back to Pexels: ${myVideoErr instanceof Error ? myVideoErr.message : myVideoErr}`,
            "DirectUploader",
          );
        }

        if (!myVideoDone) {
        const speechScript = `${insightIntro(profileKey)} ${rawExplanation}`;

        let ttsDuration = 3.5;
        try {
          ttsDuration = clonedHiwFiles
            ? await concatAudio(clonedHiwFiles, transitionTtsPath) // the same cloned voice, line by line
            : await this.tts.generateVoiceover(
                speechScript,
                transitionTtsPath,
                profileKey,
              );
        } catch (err) {
          pipelineLogger.warn(
            `Transition TTS failed: ${err instanceof Error ? err.message : err}. Using default duration.`,
            "DirectUploader",
          );
        }

        const transitionDuration = ttsDuration + 0.6;
        const pexelsBrollPath = path.join(tempDir, "pexels_broll.mp4");

        // 1. Fetch high-definition tech stock video b-roll from Pexels API (MoneyPrinterTurbo style)
        let brollReady = false;
        try {
          const brollResult = await this.pexels.fetchTechBroll(
            {
              title: context.metadata?.title,
              tags: context.metadata?.tags,
              howItWorks: rawExplanation,
            },
            transitionDuration,
            pexelsBrollPath,
          );
          if (
            brollResult &&
            fs.existsSync(pexelsBrollPath) &&
            fs.statSync(pexelsBrollPath).size > 1000
          ) {
            brollReady = true;
          }
        } catch (pexelsErr) {
          pipelineLogger.warn(
            `Pexels stock video fetch skipped: ${
              pexelsErr instanceof Error ? pexelsErr.message : pexelsErr
            }`,
            "DirectUploader",
          );
        }

        let compileCmd = "";

        if (brollReady) {
          // Mode 1: Clean, unblurred, pristine Pexels video clip with voiceover explanation
          const filterStr =
            `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30[v];` +
            `[1:a]volume=3.5[a]`;
          compileCmd =
            `${config.binaries.ffmpeg} -y ` +
            `-stream_loop -1 -i "${pexelsBrollPath}" ` +
            `-i "${transitionTtsPath}" ` +
            `-filter_complex "${filterStr}" ` +
            `-map "[v]" -map "[a]" ` +
            `-t ${transitionDuration.toFixed(2)} ` +
            `-c:v libx264 -preset superfast -crf 20 -pix_fmt yuv420p -r 30 ` +
            `-c:a aac -ar 44100 -ac 2 ` +
            `"${transitionClipPath}"`;
        } else {
          // Fallback: If Pexels broll was not available, capture last frame of main video
          const mainDuration = await this.getVideoDuration(mainVideoPath);
          const frameTime = Math.max(0, mainDuration - 0.5).toFixed(2);
          await new Promise<void>((resolve, reject) => {
            const cmd = `${config.binaries.ffmpeg} -y -ss ${frameTime} -i "${mainVideoPath}" -vframes 1 "${transitionBgFramePath}"`;
            exec(cmd, (err) => (err ? reject(err) : resolve()));
          });

          // Wrap text for the fallback drawtext filter
          const wrapText = (text: string, maxLineLength = 32): string => {
            const words = text.split(/\s+/);
            const lines: string[] = [];
            let currentLine = "";
            for (const word of words) {
              if ((currentLine + " " + word).trim().length <= maxLineLength) {
                currentLine = currentLine ? currentLine + " " + word : word;
              } else {
                if (currentLine) lines.push(currentLine);
                currentLine = word;
              }
            }
            if (currentLine) lines.push(currentLine);
            return lines.join("\n");
          };

          const introText = `${insightIntro(profileKey).replace(/[.。।]+$/, "")}:`;
          const wrappedExplanation = rawExplanation
            ? wrapText(rawExplanation, 32)
            : "";
          const screenText = wrappedExplanation
            ? `${introText}\n\n${wrappedExplanation}`
            : "Let us check\nhow is it working";
          fs.writeFileSync(transitionTextPath, screenText, "utf8");

          const escapedTextFilePath = transitionTextPath
            .replace(/\\/g, "/")
            .replace(/:/g, "\\:");
          const fontSize = rawExplanation ? 36 : 54;

          const filterStr = [
            `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,colorlevels=romax=0.45:gomax=0.45:bomax=0.45[bg]`,
            `[bg]drawtext=fontfile=${fontFile}:textfile='${escapedTextFilePath}':fontsize=${fontSize}:fontcolor=white:x=(w-tw)/2:y=(h-th)/2:shadowcolor=black:shadowx=4:shadowy=4:box=1:boxcolor=black@0.65:boxborderw=25[v]`,
            `[1:a]volume=3.5[a]`,
          ].join(";");

          compileCmd =
            `${config.binaries.ffmpeg} -y ` +
            `-loop 1 -i "${transitionBgFramePath}" ` +
            `-i "${transitionTtsPath}" ` +
            `-filter_complex "${filterStr}" ` +
            `-map "[v]" -map "[a]" ` +
            `-t ${transitionDuration.toFixed(2)} ` +
            `-c:v libx264 -preset superfast -crf 20 -pix_fmt yuv420p -r 30 ` +
            `-c:a aac -ar 44100 -ac 2 ` +
            `"${transitionClipPath}"`;
        }

        await new Promise<void>((resolve, reject) => {
          exec(compileCmd, (err) => (err ? reject(err) : resolve()));
        });
        } // end Pexels / last-frame fallback (only runs when the my-video clip was not available)
        pipelineLogger.info(
          `✓ Transition clip generated successfully (${myVideoDone ? "my-video" : "Pexels fallback"}).`,
          "DirectUploader",
        );
      }

      // 4 — Concat main video + optional transition + verdict clip
      // Normalize scale, fps, and audio on all inputs so concat never fails on resolution
      // or frame-rate/missing-audio mismatch.
      const hasAudio = await new Promise<boolean>((res) => {
        exec(
          `"${config.binaries.ffprobe}" -v error -select_streams a -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${mainVideoPath}"`,
          (err, stdout) => {
            res(!err && stdout.trim() === "audio");
          },
        );
      });

      let effectiveMainVideoPath = mainVideoPath;
      const mainWithAudioPath = path.join(context.tempDir, "video_main_with_audio.mp4");
      if (!hasAudio) {
        try {
          await new Promise<void>((resolve, reject) => {
            const muteAudioCmd = `${config.binaries.ffmpeg} -y -i "${mainVideoPath}" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v copy -c:a aac -shortest "${mainWithAudioPath}"`;
            exec(muteAudioCmd, (err) => (err ? reject(err) : resolve()));
          });
          if (fs.existsSync(mainWithAudioPath)) {
            effectiveMainVideoPath = mainWithAudioPath;
          }
        } catch (audioErr) {
          pipelineLogger.warn(
            `Failed to inject silent audio track into main video: ${audioErr instanceof Error ? audioErr.message : audioErr}`,
            "DirectUploader",
          );
        }
      }

      let concatFilter = "";
      let concatCmd = "";

      if (noEndCard) {
        // reel + insight clip only
        concatFilter =
          `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
          `pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v0];` +
          `[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
          `pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v1];` +
          `[0:a]aresample=44100[a0];[1:a]aresample=44100[a1];` +
          `[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`;
        concatCmd =
          `${config.binaries.ffmpeg} -y ` +
          `-i "${effectiveMainVideoPath}" ` +
          `-i "${transitionClipPath}" ` +
          `-filter_complex "${concatFilter}" ` +
          `-map "[v]" -map "[a]" ` +
          `-c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p ` +
          `-c:a aac ` +
          `"${outputPath}"`;
      } else if (hasTransition) {
        concatFilter =
          `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
          `pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v0];` +
          `[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
          `pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v1];` +
          `[2:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
          `pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v2];` +
          `[0:a]aresample=44100[a0];[1:a]aresample=44100[a1];[2:a]aresample=44100[a2];` +
          `[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]`;
        concatCmd =
          `${config.binaries.ffmpeg} -y ` +
          `-i "${effectiveMainVideoPath}" ` +
          `-i "${transitionClipPath}" ` +
          `-i "${verdictClipPath}" ` +
          `-filter_complex "${concatFilter}" ` +
          `-map "[v]" -map "[a]" ` +
          `-c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p ` +
          `-c:a aac ` +
          `"${outputPath}"`;
      } else {
        concatFilter =
          `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
          `pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v0];` +
          `[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
          `pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v1];` +
          `[0:a]aresample=44100[a0];[1:a]aresample=44100[a1];` +
          `[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`;
        concatCmd =
          `${config.binaries.ffmpeg} -y ` +
          `-i "${effectiveMainVideoPath}" ` +
          `-i "${verdictClipPath}" ` +
          `-filter_complex "${concatFilter}" ` +
          `-map "[v]" -map "[a]" ` +
          `-c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p ` +
          `-c:a aac ` +
          `"${outputPath}"`;
      }

      await new Promise<void>((resolve, reject) => {
        exec(concatCmd, (err, _stdout, stderr) => {
          if (err) {
            pipelineLogger.error(`Verdict concat failed: ${stderr || err.message}`, err, "DirectUploader");
            reject(err);
          } else {
            resolve();
          }
        });
      });

      pipelineLogger.checkpoint(
        `Verdict sequence appended (${useAvatarBg ? "avatar" : "fallback"} mode, score: ${score}/10)`,
        true,
        context.id,
      );
      return true;
    } catch (err) {
      pipelineLogger.warn(
        `Verdict sequence failed — continuing without it: ${err instanceof Error ? err.message : err}`,
        "DirectUploader",
      );
      return false;
    } finally {
      const mainWithAudioPath = path.join(context.tempDir, "video_main_with_audio.mp4");
      if (fs.existsSync(mainWithAudioPath)) fs.unlinkSync(mainWithAudioPath);
      if (fs.existsSync(stickerTailPath)) fs.unlinkSync(stickerTailPath);
      for (const f of ttsIntermediates) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
      for (const f of ["verdict_number.wav", "verdict_number_raw.mp3", "verdict_number_trim.wav"]) {
        const numberFile = path.join(context.tempDir, f);
        if (fs.existsSync(numberFile)) fs.unlinkSync(numberFile);
      }
    }
  }

  /**
   * Derives a structured explanation and a clean Mermaid flowchart from
   * reel transcription, caption, and AI metadata to power the V2 transition clip.
   */
  /**
   * Makes the V2 middle clip's text safe before anything is voiced or drawn: (1) a figure the reel does not contain is never
   * stated (the sentence is dropped), (2) on a Hindi channel English text is rewritten in Hinglish; when that fails or nothing
   * is left, the clip falls back to the reel's own words (deriveTranscriptionWorkflow). Runs once, before the voice and the clip.
   */
  private async refineInsight(context: PipelineContext): Promise<void> {
    const key = this.profile.key.toLowerCase();
    const meta = context.metadata;
    if (key === "codeorcap" || !meta?.howItWorks?.trim()) return;
    if (!insightEnabledFor(key, this.profile.watch?.outroVersion)) return;

    const source = [context.transcript?.text, context.captionMetadata?.description, context.ocr?.text, meta.title, meta.description]
      .filter(Boolean)
      .join("\n");
    const before = meta.howItWorks.trim();
    const figures = dropUnsupportedFigures(before, source);
    let text = figures.text;
    if (figures.dropped) {
      pipelineLogger.warn(`V2 clip: ${figures.dropped} sentence(s) with figures that are not in the reel were dropped`, "DirectUploader");
    }

    if (text && insightLang(process.env, key) === "hi" && looksEnglish(text)) {
      let rewritten = "";
      try {
        rewritten = await makeAsk({ timeoutMs: 60_000, hedgeMs: 15_000 })(
          `Rewrite this text in Hinglish (Hindi written in the English alphabet), the way an Indian creator speaks, in the same number of sentences. ` +
            `Keep the meaning. Do not add any fact, name, number or percentage that is not in the text. Return ONLY the rewritten text.\n\n${text}`,
        );
      } catch {
        /* fall back below */
      }
      rewritten = rewritten.replace(/^["'\s]+|["'\s]+$/g, "");
      if (rewritten && !looksEnglish(rewritten) && !dropUnsupportedFigures(rewritten, source).dropped) {
        pipelineLogger.info("V2 clip text was English: rewritten in Hinglish", "DirectUploader");
        text = rewritten;
      } else {
        pipelineLogger.warn("V2 clip text was English and could not be rewritten: the reel's own words are used", "DirectUploader");
        text = "";
      }
    }
    // Hindi channel: the clip's captions are the lines it narrates, so they are written in Devanagari (the voice reads Devanagari too)
    if (text && insightLang(process.env, key) === "hi" && !/[\u0900-\u097F]/.test(text)) {
      const sentences = text.split(/(?<=[.!?।])\s+/).filter(Boolean);
      const converted = await toDevanagari(sentences.map((t, i) => ({ name: `s${i}`, text: t })));
      if (converted) {
        text = converted.map((l) => l.text).join(" ");
        pipelineLogger.info("V2 clip text written in Devanagari", "DirectUploader");
      } else {
        pipelineLogger.warn("V2 clip text could not be converted to Devanagari: it stays in Hinglish", "DirectUploader");
      }
    }
    // the diagram title is shown on screen: Hindi too
    if (insightLang(process.env, key) === "hi" && meta.diagramTitle && !/[\u0900-\u097F]/.test(meta.diagramTitle)) {
      const t = await toDevanagari([{ name: "title", text: meta.diagramTitle }]);
      if (t) meta.diagramTitle = t[0].text;
    }
    meta.howItWorks = text; // "" -> deriveTranscriptionWorkflow uses the reel's transcript / caption
  }

  private deriveTranscriptionWorkflow(context: PipelineContext): {
    explanation: string;
    diagramTitle: string;
    mermaidCode: string;
  } {
    const rawExplanation = context.metadata?.howItWorks;
    const diagramTitle = context.metadata?.diagramTitle || "Execution Workflow";
    let mermaidCode = (context.metadata?.diagramWorkflow || "")
      .replace(/```(?:mermaid)?/gi, "")
      .trim();

    let explanation = rawExplanation?.trim() || "";

    if (!explanation) {
      // Derive explanation from transcription, caption or title
      // If using caption, strip out hashtags, URLs, mentions, and emojis to prevent reading raw hashtags
      let candidateText = context.transcript?.text || "";
      if (!candidateText && context.captionMetadata?.description) {
        candidateText = context.captionMetadata.description
          .replace(/#\w+/g, "") // strip hashtags
          .replace(/https?:\/\/\S+/g, "") // strip urls
          .replace(/@\w+/g, "") // strip mentions
          .replace(/[\n\r]+/g, " ")
          .trim();
      }
      if (!candidateText && context.metadata?.title) {
        candidateText = context.metadata.title;
      }
      if (!candidateText) {
        candidateText = "Code execution and logic flow.";
      }

      const cleanText = candidateText.replace(/[\n\r]+/g, " ").trim();
      explanation =
        cleanText.length > 20
          ? cleanText.slice(0, 160) + (cleanText.length > 160 ? "…" : "")
          : "1. Parses the incoming request and parameters. 2. Executes asynchronous handler logic. 3. Returns the output response.";
    }

    if (!mermaidCode || !mermaidCode.includes("graph")) {
      // Auto-generate a clean, valid 4-step flowchart
      const titleClean = (context.metadata?.title || "Operation")
        .replace(/["'<>]/g, "")
        .slice(0, 24);
      mermaidCode = `graph TD\n  A["📥 1. Receive Input: ${titleClean}"] --> B["⚡ 2. Execute Handler"]\n  B --> C["💾 3. State & Storage"]\n  C --> D["🚀 4. Output Response"]`;
    }

    return {
      explanation,
      diagramTitle,
      mermaidCode,
    };
  }
}
