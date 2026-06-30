import sharp from 'sharp';
import { FreeLlmApiClient } from '../ai/freellmapi';
import { config } from '../config';
import { 
  IBrandingDetector, 
  BrandingDetectionResult, 
  BrandingZone, 
  ImageAnalysisResult 
} from '../types';
import { pipelineLogger } from '../utils/logger';
import { OcrService } from '../ocr'; // We will use OCR text to assist detection

export interface IBrandingSubDetector {
  name: string;
  detect(imagePath: string, analysis: ImageAnalysisResult, ocrText?: string): Promise<BrandingZone[]>;
}

/**
 * Detects branding near edges/corners of the image
 */
class EdgeBrandingDetector implements IBrandingSubDetector {
  public name = 'EdgeBrandingDetector';

  public async detect(
    _imagePath: string,
    _analysis: ImageAnalysisResult
  ): Promise<BrandingZone[]> {
    const zones: BrandingZone[] = [];
    
    // Heuristic: Many screenshots have header/footer branding in the top 8% or bottom 8%
    // Let's mark these as potential watermark/profile zones.
    // They will be passed to the remover. If we crop them, we get rid of top/bottom bars.
    
    // Top bar (potential profile header / app bar)
    zones.push({
      id: 'edge-top-bar',
      type: 'profile_name',
      boundingBox: { x: 0, y: 0, width: 1, height: 0.08 },
      confidence: 0.6,
      description: 'Potential header branding/status bar zone'
    });

    // Bottom bar (potential watermark / app footer)
    zones.push({
      id: 'edge-bottom-bar',
      type: 'watermark',
      boundingBox: { x: 0, y: 0.92, width: 1, height: 0.08 },
      confidence: 0.6,
      description: 'Potential footer branding/watermark zone'
    });

    return zones;
  }
}

/**
 * Detects social handles or logos using OCR-based keyword/pattern matching
 */
class SocialHandleDetector implements IBrandingSubDetector {
  public name = 'SocialHandleDetector';
  private ocrService: OcrService;

  constructor() {
    this.ocrService = new OcrService();
  }

  public async detect(
    imagePath: string,
    analysis: ImageAnalysisResult,
    precomputedOcrText?: string
  ): Promise<BrandingZone[]> {
    const zones: BrandingZone[] = [];
    
    try {
      let text = precomputedOcrText || '';
      let detailedWords: any[] = [];
      
      // Always fetch full OCR result if precomputed text is not provided or if we want coordinates
      const ocrResult = await this.ocrService.extractText(imagePath);
      text = ocrResult.text;
      detailedWords = ocrResult.detailedWords || [];

      const handleRegex = /@[a-zA-Z0-9_\.]+|https?:\/\/(www\.)?[a-zA-Z0-9-]+\.[a-z]+/gi;

      if (detailedWords && detailedWords.length > 0) {
        detailedWords.forEach((word, index) => {
          if (word.text.match(handleRegex)) {
            pipelineLogger.info(`Found exact branding text match: ${word.text}`, 'SocialHandleDetector');
            const w = (word.bbox.x1 - word.bbox.x0) / analysis.width;
            const h = (word.bbox.y1 - word.bbox.y0) / analysis.height;
            zones.push({
              id: `ocr-exact-handle-${index}`,
              type: word.text.startsWith('@') ? 'handle' : 'watermark',
              boundingBox: {
                x: word.bbox.x0 / analysis.width,
                y: word.bbox.y0 / analysis.height,
                width: w,
                height: h,
              },
              confidence: (word.confidence || 85) / 100,
              description: `Exact social handle or URL text: "${word.text}"`
            });
          }
        });
      }

      // Fallback to legacy behavior if matches exist but detailedWords didn't catch them
      if (zones.length === 0) {
        const matches = text.match(handleRegex);
        if (matches) {
          matches.forEach((match, index) => {
            pipelineLogger.info(`Found branding text match: ${match}`, 'SocialHandleDetector');
            zones.push({
              id: `ocr-handle-${index}`,
              type: match.startsWith('@') ? 'handle' : 'watermark',
              boundingBox: { x: 0.1, y: 0.85, width: 0.8, height: 0.1 }, // Standard lower overlay
              confidence: 0.85,
              description: `Social handle or URL text: "${match}"`
            });
          });
        }
      }
    } catch (err) {
      pipelineLogger.warn(`OCR handle detection failed or skipped: ${err instanceof Error ? err.message : err}`, 'SocialHandleDetector');
    }

    return zones;
  }
}

class AiBrandingDetector implements IBrandingSubDetector {
  public name = 'AiBrandingDetector';
  private freellmapi: FreeLlmApiClient | null = null;

  constructor() {
    if (config.ai.provider === 'freellmapi') {
      this.freellmapi = new FreeLlmApiClient();
    }
  }

  public async detect(
    imagePath: string,
    _analysis: ImageAnalysisResult
  ): Promise<BrandingZone[]> {
    if (!this.freellmapi) {
      pipelineLogger.warn('FreeLLMAPI not configured for AiBrandingDetector', 'AiBrandingDetector');
      return [];
    }

    try {
      // Downscale the image to prevent payload limit issues (similar to metadata generator)
      const buffer = await sharp(imagePath)
        .resize({ width: 480, height: 854, fit: 'inside' })
        .jpeg({ quality: 75 })
        .toBuffer();
      const base64 = buffer.toString('base64');
      const mimeType = 'image/jpeg';

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

      let raw = '';
      if (this.freellmapi) {
        raw = await this.freellmapi.generateVision(prompt, base64, mimeType);
      }

      const startIndex = raw.indexOf('[');
      const endIndex = raw.lastIndexOf(']');
      if (startIndex === -1 || endIndex === -1) {
        pipelineLogger.info('AI Branding Detector returned empty or invalid response', 'AiBrandingDetector');
        return [];
      }

      const s = raw.slice(startIndex, endIndex + 1);
      const items = JSON.parse(s) as Array<{
        type: 'logo' | 'watermark' | 'handle' | 'profile_name' | 'main_post_content';
        box: { x: number; y: number; width: number; height: number };
        description: string;
      }>;

      const zones: BrandingZone[] = items.map((item, index) => ({
        id: `ai-branding-${index}`,
        type: item.type,
        boundingBox: item.box,
        confidence: 0.9,
        description: item.description
      }));

      pipelineLogger.info(`AI Branding Detector found ${zones.length} zones`, 'AiBrandingDetector');
      return zones;

    } catch (err) {
      pipelineLogger.error('AI Branding Detector failed', err, 'AiBrandingDetector');
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
    pipelineLogger.info(`Registered custom branding detector: ${detector.name}`, 'BrandingDetector');
  }

  public async detect(
    imagePath: string,
    analysis: ImageAnalysisResult,
    ocrText?: string
  ): Promise<BrandingDetectionResult> {
    pipelineLogger.info('Scanning image for existing branding...', 'BrandingDetector');
    
    let allZones: BrandingZone[] = [];

    for (const detector of this.detectors) {
      try {
        const zones = await detector.detect(imagePath, analysis, ocrText);
        allZones = allZones.concat(zones);
      } catch (err) {
        pipelineLogger.error(`Detector ${detector.name} failed`, err, 'BrandingDetector');
      }
    }

    const detected = allZones.length > 0;
    
    pipelineLogger.info(
      `Branding detection finished: ${detected ? `${allZones.length} zones found` : 'no branding found'}`,
      'BrandingDetector'
    );
    
    return {
      detected,
      zones: allZones,
    };
  }
}
