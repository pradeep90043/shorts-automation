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
    | "main_post_content";
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
  tags: string[];
  mood?: "funny" | "sad" | "other";
}

export interface RenderOptions {
  durationSeconds: number;
  fps: number;
  effect: "none" | "fade" | "zoom" | "slide";
}

export interface PipelineContext {
  id: string; // Unique Generation ID
  tempDir: string;
  telegramMeta: TelegramMetadata;

  // Pipeline file paths & results
  originalImagePath: string;
  originalVideoPath?: string;
  isVideo?: boolean;
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
  addBackgroundMusic(
    videoPath: string,
    musicFolder: string,
    outputPath: string,
    mood?: "funny" | "sad" | "other",
  ): Promise<string>;
}

export interface IYouTubeService {
  uploadShort(
    videoPath: string,
    metadata: VideoMetadata,
  ): Promise<{ url: string; videoId: string }>;
}
