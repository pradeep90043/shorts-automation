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
    _analysis: ImageAnalysisResult,
    precomputedOcrText?: string
  ): Promise<BrandingZone[]> {
    const zones: BrandingZone[] = [];
    
    try {
      // Use precomputed OCR text if available, otherwise run OCR
      let text = precomputedOcrText;
      if (!text) {
        const ocrResult = await this.ocrService.extractText(imagePath);
        text = ocrResult.text;
      }

      // Look for social handles or branding elements (e.g. @username, www.website, etc.)
      // Note: A full implementation with tesseract.js can return character/word bounding boxes.
      // For this local production module, we search the text for handles or watermarks.
      const handleRegex = /@[a-zA-Z0-9_\.]+|https?:\/\/(www\.)?[a-zA-Z0-9-]+\.[a-z]+/gi;
      const matches = text.match(handleRegex);

      if (matches) {
        matches.forEach((match, index) => {
          pipelineLogger.info(`Found branding text match: ${match}`, 'SocialHandleDetector');
          
          // Since we are doing regex search on text, we can label the approximate location.
          // In a full OCR engine, we get the exact bounding box. Here we flag general zones
          // based on text patterns, default to center-bottom or top-right.
          zones.push({
            id: `ocr-handle-${index}`,
            type: match.startsWith('@') ? 'handle' : 'watermark',
            boundingBox: { x: 0.1, y: 0.85, width: 0.8, height: 0.1 }, // Standard lower overlay
            confidence: 0.85,
            description: `Social handle or URL text: "${match}"`
          });
        });
      }
    } catch (err) {
      pipelineLogger.warn(`OCR handle detection failed or skipped: ${err instanceof Error ? err.message : err}`, 'SocialHandleDetector');
    }

    return zones;
  }
}

export class BrandingDetector implements IBrandingDetector {
  private detectors: IBrandingSubDetector[] = [];

  constructor() {
    // Register active detectors
    this.detectors.push(new EdgeBrandingDetector());
    this.detectors.push(new SocialHandleDetector());
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
