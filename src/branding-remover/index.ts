import sharp from 'sharp';
import { 
  IBrandingRemover, 
  BrandingRemovalResult, 
  BrandingZone, 
  ImageAnalysisResult 
} from '../types';
import { pipelineLogger } from '../utils/logger';

export class BrandingRemover implements IBrandingRemover {
  public async remove(
    imagePath: string,
    zones: BrandingZone[],
    analysis: ImageAnalysisResult
  ): Promise<BrandingRemovalResult> {
    pipelineLogger.info(`Initiating branding removal on image: ${imagePath}`, 'BrandingRemover');

    if (zones.length === 0) {
      pipelineLogger.info('No branding zones detected. Skipping removal.', 'BrandingRemover');
      return {
        success: true,
        methodUsed: 'none',
        outputPath: imagePath
      };
    }

    try {
      // Analyze detected zones to see if we can safely crop them
      // We will separate edge zones (safe to crop) from main-content zones (requires review)
      const edgeTopZones = zones.filter(z => z.boundingBox.y === 0 && z.boundingBox.height <= 0.12);
      const edgeBottomZones = zones.filter(z => z.boundingBox.y >= 0.88 && z.boundingBox.height <= 0.12);
      
      const middleZones = zones.filter(z => 
        (z.boundingBox.y > 0.12 && z.boundingBox.y < 0.88) || 
        z.boundingBox.width < 0.95 // If it's a localized watermark in a corner rather than a full bar
      );

      // If there are watermarks/handles in the middle of the screenshot, we cannot cleanly crop
      // Content-aware fill in local JS without an AI inpainting model will introduce obvious artifacts
      // So we flag it for manual review to preserve image quality
      if (middleZones.length > 0) {
        pipelineLogger.warn(
          `Detected ${middleZones.length} watermarks in content area. Clean automated removal is not possible without artifacts. Bypassing and flag for manual review.`,
          'BrandingRemover'
        );
        return {
          success: false,
          methodUsed: 'none',
          outputPath: imagePath,
          preservationReason: 'Embedded middle watermark detected, flagged for manual review'
        };
      }

      // Crop calculation
      let cropTop = 0;
      let cropBottom = 0;

      if (edgeTopZones.length > 0) {
        // Find the maximum height to crop from the top
        cropTop = Math.max(...edgeTopZones.map(z => z.boundingBox.height));
      }

      if (edgeBottomZones.length > 0) {
        // Find the maximum height to crop from the bottom
        cropBottom = Math.max(...edgeBottomZones.map(z => z.boundingBox.height));
      }

      const totalCropPercentage = cropTop + cropBottom;

      // If we are cropping more than 20% of the image, it might cut off actual content. Flag for review!
      if (totalCropPercentage > 0.20) {
        pipelineLogger.warn(
          `Calculated crop ratio of ${(totalCropPercentage * 100).toFixed(1)}% exceeds safety limit (20%). Flagging for manual review.`,
          'BrandingRemover'
        );
        return {
          success: false,
          methodUsed: 'none',
          outputPath: imagePath,
          preservationReason: 'Calculated crop ratio is too high, potential content loss'
        };
      }

      if (cropTop > 0 || cropBottom > 0) {
        const croppedPath = imagePath.replace(/(\.[\w\d]+)$/i, '_cropped$1');
        
        // Calculate new crop bounding box in pixels
        const topPixels = Math.floor(analysis.height * cropTop);
        const bottomPixels = Math.floor(analysis.height * cropBottom);
        const newHeight = analysis.height - topPixels - bottomPixels;

        pipelineLogger.info(
          `Cropping image: shaving ${topPixels}px from top, ${bottomPixels}px from bottom. New height: ${newHeight}px`,
          'BrandingRemover'
        );

        await sharp(imagePath)
          .extract({
            left: 0,
            top: topPixels,
            width: analysis.width,
            height: newHeight
          })
          .toFile(croppedPath);

        pipelineLogger.checkpoint('Branding removed', true, `Cropped via edge-shaving. Output saved to ${croppedPath}`);
        
        return {
          success: true,
          methodUsed: 'crop',
          outputPath: croppedPath
        };
      }

      // No actionable zones
      return {
        success: true,
        methodUsed: 'none',
        outputPath: imagePath
      };

    } catch (err) {
      pipelineLogger.error(`Branding removal failed`, err, 'BrandingRemover');
      // Fallback: preserve original image, but return success: false so we flag it
      return {
        success: false,
        methodUsed: 'none',
        outputPath: imagePath,
        preservationReason: `Error during processing: ${err instanceof Error ? err.message : err}`
      };
    }
  }
}
