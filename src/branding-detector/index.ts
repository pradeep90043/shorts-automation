import sharp from "sharp";
import { FreeLlmApiClient } from "../ai/freellmapi";
import { config } from "../config";
import { parseAiJson } from "../utils/json";
import {
  IBrandingDetector,
  BrandingDetectionResult,
  BrandingZone,
  ImageAnalysisResult,
  OcrWord,
} from "../types";
import { pipelineLogger } from "../utils/logger";
import { OcrService } from "../ocr"; // We will use OCR text to assist detection

export interface IBrandingSubDetector {
  name: string;
  detect(
    imagePath: string,
    analysis: ImageAnalysisResult,
    ocrText?: string,
  ): Promise<BrandingZone[]>;
}

/**
 * Detects branding near edges/corners of the image
 */
class EdgeBrandingDetector implements IBrandingSubDetector {
  public name = "EdgeBrandingDetector";

  public async detect(
    _imagePath: string,
    _analysis: ImageAnalysisResult,
  ): Promise<BrandingZone[]> {
    const zones: BrandingZone[] = [];

    // Heuristic: Many screenshots have header/footer branding in the top 8% or bottom 8%
    // Let's mark these as potential watermark/profile zones.
    // They will be passed to the remover. If we crop them, we get rid of top/bottom bars.

    // Top bar (potential profile header / app bar)
    zones.push({
      id: "edge-top-bar",
      type: "profile_name",
      boundingBox: { x: 0, y: 0, width: 1, height: 0.08 },
      confidence: 0.6,
      description: "Potential header branding/status bar zone",
    });

    // Bottom bar (potential watermark / app footer)
    zones.push({
      id: "edge-bottom-bar",
      type: "watermark",
      boundingBox: { x: 0, y: 0.92, width: 1, height: 0.08 },
      confidence: 0.6,
      description: "Potential footer branding/watermark zone",
    });

    return zones;
  }
}


/**
 * Detects social handles or logos using OCR-based keyword/pattern matching
 */
export class SocialHandleDetector implements IBrandingSubDetector {
  public name = "SocialHandleDetector";
  private ocrService: OcrService;

  constructor() {
    this.ocrService = new OcrService();
  }

  public async detect(
    imagePath: string,
    analysis: ImageAnalysisResult,
    precomputedOcrText?: string,
    precomputedWords?: OcrWord[],
  ): Promise<BrandingZone[]> {
    const zones: BrandingZone[] = [];

    try {
      let text = precomputedOcrText || "";
      let detailedWords: OcrWord[] = precomputedWords || [];

      // Multi-pass OCR takes 1-3 minutes on the prod VM — only run it when the
      // caller didn't already provide word-level results to reuse.
      if (!precomputedWords) {
        const ocrResult = await this.ocrService.extractText(imagePath);
        text = ocrResult.text;
        detailedWords = ocrResult.detailedWords || [];
      }

      const handleRegex = /\S*@\S*|https?:\/\/(www\.)?[a-zA-Z0-9-]+\.[a-z]+/gi;

      if (detailedWords && detailedWords.length > 0) {
        detailedWords.forEach((word, index) => {
          const isHandle = word.text.match(handleRegex);

          // Low-confidence single-char matches (e.g. a lone "@" at 0%
          // confidence) create bogus cover zones in the middle of the video
          if (isHandle && ((word.confidence || 0) < 40 || word.text.trim().length < 4)) {
            return;
          }

          if (isHandle) {
            pipelineLogger.info(
              `Found handle/URL to blur: "${word.text}" (confidence: ${word.confidence}%)`,
              "SocialHandleDetector",
            );
            const w = (word.bbox.x1 - word.bbox.x0) / analysis.width;
            const h = (word.bbox.y1 - word.bbox.y0) / analysis.height;
            zones.push({
              id: `ocr-exact-handle-${index}`,
              type: "handle",
              boundingBox: {
                x: word.bbox.x0 / analysis.width,
                y: word.bbox.y0 / analysis.height,
                width: w,
                height: h,
              },
              confidence: (word.confidence || 85) / 100,
              description: `Exact social handle or URL text: "${word.text}"`,
            });
          }
        });
      }

      // Fallback to legacy behavior if matches exist but detailedWords didn't catch them
      if (zones.length === 0) {
        const matches = text.match(handleRegex);
        if (matches) {
          matches.forEach((match, index) => {
            pipelineLogger.info(
              `Found branding text match: ${match}`,
              "SocialHandleDetector",
            );
            zones.push({
              id: `ocr-handle-${index}`,
              type: match.includes("@") ? "handle" : "watermark",
              boundingBox: { x: 0.1, y: 0.85, width: 0.8, height: 0.1 }, // Standard lower overlay
              confidence: 0.85,
              description: `Social handle or URL text: "${match}"`,
            });
          });
        }
      }
    } catch (err) {
      pipelineLogger.warn(
        `OCR handle detection failed or skipped: ${err instanceof Error ? err.message : err}`,
        "SocialHandleDetector",
      );
    }

    return zones;
  }
}

class AiBrandingDetector implements IBrandingSubDetector {
  public name = "AiBrandingDetector";
  private freellmapi: FreeLlmApiClient | null = null;

  constructor() {
    if (config.ai.provider === "freellmapi") {
      this.freellmapi = new FreeLlmApiClient();
    }
  }

  public async detect(
    imagePath: string,
    analysis: ImageAnalysisResult,
  ): Promise<BrandingZone[]> {
    if (!this.freellmapi) {
      pipelineLogger.warn(
        "FreeLLMAPI not configured for AiBrandingDetector",
        "AiBrandingDetector",
      );
      return [];
    }

    try {
      // Downscale the image to prevent payload limit issues (similar to metadata generator)
      const buffer = await sharp(imagePath)
        .resize({ width: 480, height: 854, fit: "inside" })
        .jpeg({ quality: 75 })
        .toBuffer();
      const base64 = buffer.toString("base64");
      const mimeType = "image/jpeg";

      const prompt = `You are a computer vision assistant for a video editing pipeline.
Analyze the image and detect the exact coordinates of any branding, watermarks, profile pictures, usernames/handles, logos, or app overlays of other channels or creators.

We need to remove these elements. Locate them and return their bounding boxes in normalized coordinates relative to the image size (value between 0.0 and 1.0).

Specifically search for:
- profile picture (e.g. circle image showing a person/logo in top-left or bottom-left)
- profile name / username / handle (e.g. "@username", "username" in top-left or bottom-left)
- watermarks or logos (e.g. Instagram logo, TikTok watermark, other channel logo)
- actions panel (e.g. reels interaction panel on the right with like/comment/share icons)
- main_post_content (e.g. if the image contains a full post layout, comments, or web view headers, detect the bounding box of the central post image/media box itself, excluding headers, comments, likes, and footer chrome)

If no such elements are present, return an empty array [].

Return ONLY a raw JSON array of objects with the following schema — no markdown, no explanation:
[
  {
    "type": "logo" | "watermark" | "handle" | "profile_name" | "main_post_content",
    "box": {
      "x": number,      // top-left x coordinate (0.0 to 1.0)
      "y": number,      // top-left y coordinate (0.0 to 1.0)
      "width": number,  // width of bounding box (0.0 to 1.0)
      "height": number  // height of bounding box (0.0 to 1.0)
    },
    "description": string
  }
]`;

      let raw = "";
      if (this.freellmapi) {
        raw = await this.freellmapi.generateVision(prompt, base64, mimeType);
      }

      const items = parseAiJson<
        Array<{
          type:
            | "logo"
            | "watermark"
            | "handle"
            | "profile_name"
            | "main_post_content";
          box: { x: number; y: number; width: number; height: number };
          description: string;
        }>
      >(raw);

      const zones: BrandingZone[] = items.map((item, index) => {
        let { x, y, width, height } = item.box;

        // If the model returned coordinates in pixel/1000 scale, normalize them
        if (x > 1.0 || y > 1.0 || width > 1.0 || height > 1.0) {
          const maxVal = Math.max(x, y, width, height);
          if (maxVal <= 1000) {
            x /= 1000;
            y /= 1000;
            width /= 1000;
            height /= 1000;
          } else {
            // Raw pixel coordinates relative to the analysis resolution
            x /= (analysis.width || 1080);
            width /= (analysis.width || 1080);
            y /= (analysis.height || 1920);
            height /= (analysis.height || 1920);
          }
        }

        // Clamp values to [0.0, 1.0] for safety
        x = Math.max(0, Math.min(1.0, x));
        y = Math.max(0, Math.min(1.0, y));
        width = Math.max(0, Math.min(1.0 - x, width));
        height = Math.max(0, Math.min(1.0 - y, height));

        return {
          id: `ai-branding-${index}`,
          type: item.type,
          boundingBox: { x, y, width, height },
          confidence: 0.9,
          description: item.description,
        };
      });

      pipelineLogger.info(
        `AI Branding Detector found ${zones.length} zones`,
        "AiBrandingDetector",
      );
      return zones;
    } catch (err) {
      pipelineLogger.error(
        "AI Branding Detector failed",
        err,
        "AiBrandingDetector",
      );
      return [];
    }
  }
}

export class BrandingDetector implements IBrandingDetector {
  private detectors: IBrandingSubDetector[] = [];

  constructor() {
    // Register active detectors
    this.detectors.push(new EdgeBrandingDetector());
    this.detectors.push(new SocialHandleDetector());
    this.detectors.push(new AiBrandingDetector());
  }

  /**
   * Allows external code to register additional custom detectors (SOLID Open-Closed)
   */
  public registerDetector(detector: IBrandingSubDetector): void {
    this.detectors.push(detector);
    pipelineLogger.info(
      `Registered custom branding detector: ${detector.name}`,
      "BrandingDetector",
    );
  }

  public async detect(
    imagePath: string,
    analysis: ImageAnalysisResult,
    ocrText?: string,
  ): Promise<BrandingDetectionResult> {
    pipelineLogger.info(
      "Scanning image for existing branding...",
      "BrandingDetector",
    );

    let allZones: BrandingZone[] = [];

    for (const detector of this.detectors) {
      try {
        const zones = await detector.detect(imagePath, analysis, ocrText);
        allZones = allZones.concat(zones);
      } catch (err) {
        pipelineLogger.error(
          `Detector ${detector.name} failed`,
          err,
          "BrandingDetector",
        );
      }
    }

    const detected = allZones.length > 0;

    pipelineLogger.info(
      `Branding detection finished: ${detected ? `${allZones.length} zones found` : "no branding found"}`,
      "BrandingDetector",
    );

    return {
      detected,
      zones: allZones,
    };
  }
}
