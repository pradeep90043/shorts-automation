import Tesseract from "tesseract.js";
import sharp from "sharp";
import fs from "fs";
import { IOcrService, OcrResult, OcrWord } from "../types";
import { pipelineLogger } from "../utils/logger";

interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const getOverlapRatio = (a: BBox, b: BBox): number => {
  const xLeft = Math.max(a.x0, b.x0);
  const yTop = Math.max(a.y0, b.y0);
  const xRight = Math.min(a.x1, b.x1);
  const yBottom = Math.min(a.y1, b.y1);

  if (xRight <= xLeft || yBottom <= yTop) {
    return 0;
  }

  const intersectionArea = (xRight - xLeft) * (yBottom - yTop);
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);

  const minArea = Math.min(areaA, areaB);
  return minArea > 0 ? intersectionArea / minArea : 0;
};

export class OcrService implements IOcrService {
  public async extractText(imagePath: string): Promise<OcrResult> {
    pipelineLogger.info(
      `Running Multi-Pass Deep OCR on ${imagePath}...`,
      "OCR",
    );

    const pass2Path = imagePath.replace(/\.(\w+)$/, "_pass2.$1");
    const pass3Path = imagePath.replace(/\.(\w+)$/, "_pass3.$1");

    try {
      // Get image dimensions for upscaling reference
      const metadata = await sharp(imagePath).metadata();
      const width = metadata.width || 1080;

      // ── PASS 1: Original Image ─────────────────────────────────────────────
      pipelineLogger.info("OCR Pass 1/3: Running on raw image...", "OCR");
      const res1 = await Tesseract.recognize(imagePath, "eng");
      const words1: OcrWord[] = (res1.data.words || []).map((w) => ({
        text: w.text,
        confidence: w.confidence || 0,
        bbox: w.bbox,
      }));

      // ── PASS 2: 2x Upscaled + Grayscale + Sharpened ────────────────────────
      pipelineLogger.info(
        "OCR Pass 2/3: Generating upscaled high-contrast frame...",
        "OCR",
      );
      await sharp(imagePath)
        .resize({ width: width * 2 })
        .grayscale()
        .normalize()
        .sharpen()
        .toFile(pass2Path);

      pipelineLogger.info("OCR Pass 2/3: Extracting text...", "OCR");
      const res2 = await Tesseract.recognize(pass2Path, "eng");
      const words2: OcrWord[] = (res2.data.words || []).map((w) => ({
        text: w.text,
        confidence: w.confidence || 0,
        // Downscale bounding box by 2x to match original image space
        bbox: {
          x0: Math.round(w.bbox.x0 / 2),
          y0: Math.round(w.bbox.y0 / 2),
          x1: Math.round(w.bbox.x1 / 2),
          y1: Math.round(w.bbox.y1 / 2),
        },
      }));

      // ── PASS 3: Binarized Threshold Mask ───────────────────────────────────
      pipelineLogger.info(
        "OCR Pass 3/3: Generating binarized threshold frame...",
        "OCR",
      );
      await sharp(imagePath).grayscale().threshold(140).toFile(pass3Path);

      pipelineLogger.info("OCR Pass 3/3: Extracting text...", "OCR");
      const res3 = await Tesseract.recognize(pass3Path, "eng");
      const words3: OcrWord[] = (res3.data.words || []).map((w) => ({
        text: w.text,
        confidence: w.confidence || 0,
        bbox: w.bbox,
      }));

      // ── MERGE & DEDUPLICATE WORDS ──────────────────────────────────────────
      // Accumulate words, updating text/coordinates if a later pass yields higher confidence
      const mergedWords: OcrWord[] = [...words1];

      const mergePass = (newWords: OcrWord[]) => {
        for (const newWord of newWords) {
          let foundMatch = false;

          for (let i = 0; i < mergedWords.length; i++) {
            const existing = mergedWords[i];
            const overlap = getOverlapRatio(existing.bbox, newWord.bbox);

            if (overlap > 0.5) {
              foundMatch = true;
              // If new pass detected it with higher confidence, replace it
              if (newWord.confidence > existing.confidence) {
                mergedWords[i] = newWord;
              }
              break;
            }
          }

          if (!foundMatch) {
            mergedWords.push(newWord);
          }
        }
      };

      mergePass(words2);
      mergePass(words3);

      // Re-assemble final OCR output
      // Sort words by vertical coordinate (top) then horizontal coordinate (left) to form coherent sentences
      const sortedWords = [...mergedWords].sort((a, b) => {
        if (Math.abs(a.bbox.y0 - b.bbox.y0) < 15) {
          return a.bbox.x0 - b.bbox.x0;
        }
        return a.bbox.y0 - b.bbox.y0;
      });

      const text = sortedWords.map((w) => w.text).join(" ");
      const avgConfidence =
        sortedWords.length > 0
          ? Math.round(
              sortedWords.reduce((sum, w) => sum + w.confidence, 0) /
                sortedWords.length,
            )
          : 0;

      pipelineLogger.checkpoint(
        "Multi-pass OCR completed",
        true,
        `Merged final word count: ${sortedWords.length} (Avg confidence: ${avgConfidence}%)`,
      );

      return {
        text,
        confidence: avgConfidence,
        words: sortedWords.map((w) => w.text),
        detailedWords: sortedWords,
      };
    } catch (err) {
      pipelineLogger.error(
        `Multi-pass OCR failed on image ${imagePath}`,
        err,
        "OCR",
      );
      return {
        text: "",
        confidence: 0,
        words: [],
      };
    } finally {
      // Clean up temporary preprocessed files
      try {
        if (fs.existsSync(pass2Path)) fs.unlinkSync(pass2Path);
        if (fs.existsSync(pass3Path)) fs.unlinkSync(pass3Path);
      } catch (_) {}
    }
  }
}
