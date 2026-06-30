import Tesseract from 'tesseract.js';
import { IOcrService, OcrResult } from '../types';
import { pipelineLogger } from '../utils/logger';

export class OcrService implements IOcrService {
  public async extractText(imagePath: string): Promise<OcrResult> {
    pipelineLogger.info(`Running Tesseract OCR on ${imagePath}...`, 'OCR');
    
    try {
      // Run recognition directly. Tesseract.js handles the worker pool under the hood.
      const result = await Tesseract.recognize(imagePath, 'eng', {
        logger: (m) => {
          if (m.status === 'recognizing' && Math.round(m.progress * 100) % 25 === 0) {
            pipelineLogger.info(`OCR Progress: ${Math.round(m.progress * 100)}%`, 'OCR');
          }
        }
      });

      const text = result.data.text || '';
      const confidence = result.data.confidence || 0;
      const words = result.data.words ? result.data.words.map(w => w.text) : [];
      const detailedWords = result.data.words ? result.data.words.map(w => ({
        text: w.text,
        confidence: w.confidence || 0,
        bbox: w.bbox,
      })) : [];

      pipelineLogger.checkpoint('OCR completed', true, `Extracted ${words.length} words with confidence ${confidence}%`);
      
      return {
        text,
        confidence,
        words,
        detailedWords,
      };
    } catch (err) {
      pipelineLogger.error(`OCR failed on image ${imagePath}`, err, 'OCR');
      // Return empty result instead of crashing the pipeline
      return {
        text: '',
        confidence: 0,
        words: [],
      };
    }
  }
}
