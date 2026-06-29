import sharp from 'sharp';
import { IImageAnalyzer, ImageAnalysisResult } from '../types';
import { pipelineLogger } from '../utils/logger';

export class ImageAnalyzer implements IImageAnalyzer {
  public async analyze(imagePath: string): Promise<ImageAnalysisResult> {
    pipelineLogger.info(`Analyzing image: ${imagePath}`, 'ImageAnalysis');
    
    try {
      const image = sharp(imagePath);
      const metadata = await image.metadata();
      
      const width = metadata.width;
      const height = metadata.height;
      
      if (!width || !height) {
        throw new Error('Could not retrieve image dimensions from metadata.');
      }
      
      const aspectRatio = width / height;
      let orientation: 'portrait' | 'landscape' | 'square' = 'square';
      if (height > width * 1.05) {
        orientation = 'portrait';
      } else if (width > height * 1.05) {
        orientation = 'landscape';
      }

      // Check for black/white margins by analyzing edge pixels
      // We will extract the outer 1% border region and check average brightness
      const { hasBlackMargins, hasWhiteMargins } = await this.detectMargins(image);

      const result: ImageAnalysisResult = {
        width,
        height,
        aspectRatio,
        orientation,
        hasWhiteMargins,
        hasBlackMargins,
      };

      pipelineLogger.info(
        `Analysis complete: ${width}x${height} (${orientation}), ` +
        `white margins: ${hasWhiteMargins}, black margins: ${hasBlackMargins}`,
        'ImageAnalysis'
      );
      
      return result;
    } catch (err) {
      pipelineLogger.error(`Failed to analyze image at ${imagePath}`, err, 'ImageAnalysis');
      throw err;
    }
  }

  private async detectMargins(
    image: sharp.Sharp
  ): Promise<{ hasBlackMargins: boolean; hasWhiteMargins: boolean }> {
    try {
      // Extract a resized small buffer to make calculation super fast and noise-tolerant
      const sampleSize = 50;
      const buffer = await image
        .resize(sampleSize, sampleSize, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const data = buffer.data;
      const info = buffer.info;
      const channels = info.channels; // 3 (RGB) or 4 (RGBA)

      // Let's sample the top row, bottom row, left column, and right column of our 50x50 sample
      let edgePixelsCount = 0;
      let totalR = 0;
      let totalG = 0;
      let totalB = 0;

      const addPixel = (x: number, y: number) => {
        const idx = (y * sampleSize + x) * channels;
        totalR += data[idx];
        totalG += data[idx + 1];
        totalB += data[idx + 2];
        edgePixelsCount++;
      };

      // Top and Bottom rows
      for (let x = 0; x < sampleSize; x++) {
        addPixel(x, 0);
        addPixel(x, sampleSize - 1);
      }

      // Left and Right columns (skipping corners as they're counted above)
      for (let y = 1; y < sampleSize - 1; y++) {
        addPixel(0, y);
        addPixel(sampleSize - 1, y);
      }

      const avgR = totalR / edgePixelsCount;
      const avgG = totalG / edgePixelsCount;
      const avgB = totalB / edgePixelsCount;
      const avgBrightness = (avgR + avgG + avgB) / 3;

      // Thresholds:
      // White margins: Average brightness is extremely high (> 240)
      // Black margins: Average brightness is extremely low (< 25)
      const hasWhiteMargins = avgBrightness > 240;
      const hasBlackMargins = avgBrightness < 25;

      return { hasWhiteMargins, hasBlackMargins };
    } catch (err) {
      pipelineLogger.warn(`Margin detection failed: ${err instanceof Error ? err.message : err}. Defaulting to false.`, 'ImageAnalysis');
      return { hasBlackMargins: false, hasWhiteMargins: false };
    }
  }
}
