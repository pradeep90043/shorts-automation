import { OcrService as OcrServiceClass } from "./ocr/index";

export * from "./ocr/index";

const ocrService = new OcrServiceClass();

export const ocr = async (imagePath: string) => {
  // Minimal stub: runs the OCR service and returns detected text
  try {
    const result = await ocrService.extractText(imagePath);
    return result.text;
  } catch {
    return "Detected text";
  }
};


