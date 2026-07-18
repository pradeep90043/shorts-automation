export enum AssetKind {
  MemeImage = "MemeImage",
  MemeVideo = "MemeVideo",
  Reel = "Reel",
  Short = "Short",
  Screenshot = "Screenshot",
  Infographic = "Infographic"
}

export interface TelegramMetadata {
  messageId: number;
  chatId: number;
  userId?: number;
  username?: string;
  firstName?: string;
  timestamp: number;
  fileId: string;
}

export interface ImageAnalysisResult {
  width: number;
  height: number;
  aspectRatio: number;
  orientation: "portrait" | "landscape" | "square";
  hasWhiteMargins: boolean;
  hasBlackMargins: boolean;
  borderColors?: string[];
}

export interface BrandingZone {
  id: string;
  type:
    | "logo"
    | "watermark"
    | "handle"
    | "profile_name"
    | "other"
    | "main_post_content"
    | "original_captions";
  // Bounding box: normalized coordinates [0, 1] relative to image width and height
  boundingBox: {
    x: number; // Top-left X
    y: number; // Top-left Y
    width: number;
    height: number;
  };
  confidence: number;
  description?: string;
}

export interface BrandingDetectionResult {
  detected: boolean;
  zones: BrandingZone[];
}

export interface BrandingRemovalResult {
  success: boolean;
  methodUsed: "crop" | "inpainting" | "none";
  outputPath: string;
  preservationReason?: string; // If skipped, explain why
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrResult {
  text: string;
  confidence: number;
  words: string[];
  detailedWords?: OcrWord[];
}

export interface InfographicItem {
  number: number;
  title: string;
  description: string;
  icon?: string;
  tag?: string; // badge label e.g. "Free", "Open Source", "Popular"
  platform?: string; // e.g. "Web • macOS • Linux"
}

export interface InfographicContent {
  title: string;
  titleAccent: string;
  subtitle?: string;
  items: InfographicItem[];
  tipLeft?: string; // verdict / best-overall text
  tipRight?: string; // pro tip / recommendation text
}

export interface VideoMetadata {
  title: string;
  description: string;
  primaryKeyword?: string;
  secondaryKeywords?: string[];
  tags: string[];
  hashtags?: string[];
  thumbnailText?: string;
  filename?: string;
  mood?: string; // e.g. funny, serious, emotional, motivational, technical, horror, sad, other
  factCheckScore?: number;
  verdict?: string;
  voiceoverScript?: string;
}

export interface ReviewSettings {
  voiceover: boolean;
  originalAudio: boolean;
  music: boolean;
  captions: boolean;
  cropTopPct: number; // 0 | 5 | 10 | 15 | 20 | 25
  cropBottomPct: number; // 0 | 5 | 10 | 15 | 20 | 25
  sticker: boolean; // overlay a mood-matched reaction sticker (assets/stickers/<mood>.mov)
}

export interface RenderOptions {
  durationSeconds: number;
  fps: number;
  effect: "none" | "fade" | "zoom" | "slide";
}

export interface PipelineContext {
  id: string; // Unique Generation ID
  assetKind: AssetKind; // Type of asset
  tempDir: string;
  telegramMeta: TelegramMetadata;

  // Pipeline file paths & results
  originalImagePath: string;
  originalVideoPath?: string;
  isVideo?: boolean;
  isTelegram?: boolean; // true for media originating from Telegram
  analysis?: ImageAnalysisResult;
  brandingDetection?: BrandingDetectionResult;
  cleanedImagePath?: string;
  brandingRemoval?: BrandingRemovalResult;
  ocr?: OcrResult;
  layoutImagePath?: string;
  brandedImagePath?: string;
  metadata?: VideoMetadata;
  musicPath?: string;
  renderedVideoPath?: string;
  finalVideoPath?: string;

  // YouTube details
  youtubeUrl?: string;
  youtubeVideoId?: string;

  // Processing status
  status:
    | "received"
    | "analyzing"
    | "detecting_branding"
    | "removing_branding"
    | "ocr"
    | "generating_layout"
    | "branding"
    | "generating_metadata"
    | "rendering_video"
    | "adding_music"
    | "uploading"
    | "completed"
    | "failed"
    | "manual_review";
  error?: string;
  instagramSource?: boolean; // skip branding removal for Instagram-sourced frames
  instagramSourceType?: "image" | "image_with_music" | "video";
  captionMetadata?: { title: string; description: string }; // user-provided title+description from Telegram caption
  userPrompt?: string; // custom re-generation prompt instruction from the user
  metadataIsFallback?: boolean; // AI metadata failed — hardcoded template metadata in use
  previousMetadata?: VideoMetadata; // metadata before re-generation
  rephrasedCaption?: string; // AI rephrased caption
  mediaHash?: string; // SHA-256 fingerprint of media
  safeArea?: { x: number; y: number; width: number; height: number }; // AI detected safe area coordinates
  qualityScore?: {
    readability: number;
    watermarkRisk: number;
    isStandardMemeStyle: boolean;
    recommendation: string;
  }; // AI quality check scores
  safeAreaCandidates?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    score: number;
    reason: string;
  }>;
  existingBanner?: boolean;
  bannerBounds?: { x: number; y: number; width: number; height: number };
  protectedRegions?: Array<{
    type: string;
    box: { x: number; y: number; width: number; height: number };
    description: string;
  }>;
  recommendedPlacement?: "existing_banner" | "top" | "bottom" | "left" | "right";
  /**
   * AI-selected caption rendering style:
   * style1_outline  — white text + black stroke (plain/cartoon backgrounds)
   * style2_banner_replace — reuse existing meme banner exactly (covers old text)
   * style3_black_banner  — solid black rectangle (only on busy backgrounds)
   * style4_gradient — semi-transparent dark gradient (real video footage)
   */
  captionStyle?: "style1_outline" | "style2_banner_replace" | "style3_black_banner" | "style4_gradient";
  /** Background region classification for the caption placement area */
  backgroundType?: "plain" | "busy" | "existing_banner";
  captionVariants?: { A: string; B: string; C: string }; // Multiple rephrased variants
  useRephrasedCaption?: boolean; // track if a rephrased caption variant was chosen
  selectedMusicTrack?: string; // Pre-selected music track for first frame review
  useVoiceover?: boolean; // Whether to include AI voiceover (defaults to true if script exists)
  ttsAudioPath?: string; // Path to generated TTS audio
  ttsDuration?: number; // Duration of generated TTS audio
  transcript?: {
    text: string;
    words: Array<{ word: string; start: number; end: number }>;
  } | null;
  hasOriginalAudio?: boolean; // video has an audio stream (independent of Whisper availability)
  creatorTextDetected?: boolean; // AI found creator captions/text baked into the video
  aiRecommendedSettings?: ReviewSettings; // what the AI suggests
  reviewSettings?: ReviewSettings; // final settings (user overrides or AI defaults)
  settingsReviewDone?: boolean; // gate already passed — do not re-show on re-entry
}

export interface ITelegramService {
  start(): Promise<void>;
  downloadFile(fileId: string, destPath: string): Promise<void>;
  sendMessage(
    chatId: number,
    text: string,
    replyToMessageId?: number,
  ): Promise<void>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  sendSuccessMessageWithRevoke(
    chatId: number,
    text: string,
    id: string,
    replyToMessageId?: number,
  ): Promise<number>;
  sendSettingsReview(
    chatId: number,
    text: string,
    id: string,
    settings: ReviewSettings,
    replyToMessageId?: number,
    previewImagePath?: string,
  ): Promise<number>;
  updateSettingsReview(
    chatId: number,
    messageId: number,
    text: string,
    id: string,
    settings: ReviewSettings,
  ): Promise<void>;
  sendVideoForReview(
    chatId: number,
    videoPath: string,
    caption: string,
    id: string,
    replyToMessageId?: number,
  ): Promise<number>;
  updateReviewCaption(
    chatId: number,
    messageId: number,
    caption: string,
    id: string,
  ): Promise<void>;
  editReviewVideo(
    chatId: number,
    messageId: number,
    videoPath: string,
    caption: string,
    id: string,
  ): Promise<number>;
  removeInlineButtons(chatId: number, messageId: number): Promise<void>;
  registerReviewCallback(
    cb: (
      action: "publish" | "cancel" | "regenerate" | "viral" | "toggle_voiceover" | "replace_music",
      id: string,
    ) => void,
  ): void;
  registerRevokeCallback(cb: (id: string) => Promise<void>): void;
  registerTextPromptCallback(
    cb: (chatId: number, text: string, messageId: number) => Promise<boolean>,
  ): void;
  registerAudioUploadCallback(
    cb: (
      chatId: number,
      fileId: string,
      fileName: string,
      messageId: number,
    ) => Promise<boolean>,
  ): void;
  registerSettingsReviewCallback(cb: (code: string, id: string) => void): void;
}

export interface IImageAnalyzer {
  analyze(imagePath: string): Promise<ImageAnalysisResult>;
}

export interface IBrandingDetector {
  detect(
    imagePath: string,
    analysis: ImageAnalysisResult,
  ): Promise<BrandingDetectionResult>;
}

export interface IBrandingRemover {
  remove(
    imagePath: string,
    zones: BrandingZone[],
    analysis: ImageAnalysisResult,
  ): Promise<BrandingRemovalResult>;
}

export interface IOcrService {
  extractText(imagePath: string): Promise<OcrResult>;
}

export interface ILayoutGenerator {
  generate(
    imagePath: string,
    analysis: ImageAnalysisResult,
    outputPath: string,
    ocrText?: string,
  ): Promise<string>;
}

export interface IBrandingService {
  applyCodeOrCapBranding(
    layoutImagePath: string,
    outputPath: string,
  ): Promise<string>;
}

export interface IAiService {
  generateMetadata(
    ocrText: string,
    imageContext: string,
  ): Promise<VideoMetadata>;
}

export interface IVideoRenderer {
  renderImageToVideo(
    imagePath: string,
    outputPath: string,
    options: RenderOptions,
  ): Promise<string>;
  processVideo(
    videoPath: string,
    outputPath: string,
    context: PipelineContext,
    options: RenderOptions,
  ): Promise<string>;
}

export interface IMusicService {
  lastSelectedTrack: string | null;
  selectLocalTrack(musicFolder: string, mood?: string, excludeTrack?: string): string;
  addBackgroundMusic(
    videoPath: string,
    musicFolder: string,
    outputPath: string,
    mood?: string,
    forceReplace?: boolean,
    excludeTrack?: string,
    specificTrack?: string,
    voiceoverPath?: string,
  ): Promise<string>;
}

export interface IYouTubeService {
  uploadShort(
    videoPath: string,
    metadata: VideoMetadata,
  ): Promise<{ url: string; videoId: string }>;
}
