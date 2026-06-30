import sharp from "sharp";
import path from "path";
import fs from "fs";
import { ILayoutGenerator, ImageAnalysisResult } from "../types";
import { CodeRenderer } from "./code-renderer";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";

// Zone constants — must match branding/index.ts exactly
export const TOP_RESERVED = 160; // Logo zone height
export const BOTTOM_RESERVED = 260; // Footer zone height
export const CODE_ZONE_Y = TOP_RESERVED;
export const CODE_ZONE_H = 1920 - TOP_RESERVED - BOTTOM_RESERVED; // 1500px

export class LayoutGenerator implements ILayoutGenerator {
  private codeRenderer: CodeRenderer;

  constructor() {
    this.codeRenderer = new CodeRenderer();
  }

  /**
   * Returns true only when the OCR text looks like actual source code.
   * Infographic/roadmap text (numbered lists, topic names, etc.) returns false.
   */
  private isActualCode(text: string): boolean {
    const lines = text
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    if (lines.length < 3) return false;

    // Strong code indicators — any one is enough
    const strongPatterns = [
      /\bfunction\s+\w+\s*\(/, // function declaration
      /\bclass\s+\w+\s*[\{(]/, // class declaration
      /\bvoid\s+\w+\s*\(/, // Java/C method
      /\bdef\s+\w+\s*\(/, // Python function
      /\bimport\s+[\w.]+\s*;/, // Java import with ;
      /\bimport\s+[\w{},\s]+\s+from\s+/, // JS/TS import from
      /\w+\s*=\s*new\s+\w+\s*\(/, // new instantiation
      /\bSystem\.out\.print/, // Java print
      /\bconsole\.(log|error|warn)\s*\(/, // JS console
      /\bpublic\s+(static\s+)?[\w<>[\]]+\s+\w+\s*\(/, // Java method sig
      /^\s{2,}\w/m, // indented code block (2+ spaces)
    ];

    for (const p of strongPatterns) {
      if (p.test(text)) return true;
    }

    // Density check: code symbols {} ; () [] = make up >4% of non-whitespace
    const codeChars = (text.match(/[{}()\[\];=]/g) || []).length;
    const totalChars = text.replace(/\s/g, "").length;
    if (totalChars > 0 && codeChars / totalChars > 0.04) return true;

    return false;
  }

  public async generate(
    imagePath: string,
    analysis: ImageAnalysisResult,
    outputPath: string,
    ocrText?: string,
  ): Promise<string> {
    pipelineLogger.info(
      `Generating 9:16 layout for image: ${imagePath}`,
      "LayoutGenerator",
    );

    const CANVAS_W = 1080;
    const CANVAS_H = 1920;

    let workingImagePath = imagePath;
    let workingAnalysis = { ...analysis };

    // ── 1. Render beautified code card — ONLY when OCR text looks like real code ─
    const looksLikeCode =
      ocrText && ocrText.trim().length > 0 && this.isActualCode(ocrText);

    if (config.rendering.beautifyCode && looksLikeCode) {
      try {
        const tempPath = path.join(
          path.dirname(outputPath),
          "beautified_code.png",
        );

        const lower = ocrText!.toLowerCase();
        const isJava =
          lower.includes("public class") ||
          lower.includes("public static void") ||
          lower.includes("system.out") ||
          lower.includes("import java.");

        await this.codeRenderer.renderCodeToImage(ocrText!, tempPath, isJava);

        if (fs.existsSync(tempPath)) {
          pipelineLogger.info(
            "OCR text looks like code — using beautified code card.",
            "LayoutGenerator",
          );
          workingImagePath = tempPath;
          const meta = await sharp(tempPath).metadata();
          if (meta.width && meta.height) {
            workingAnalysis = {
              width: meta.width,
              height: meta.height,
              aspectRatio: meta.width / meta.height,
              orientation: meta.height > meta.width ? "portrait" : "landscape",
              hasBlackMargins: false,
              hasWhiteMargins: false,
            };
          }
        }
      } catch (err) {
        pipelineLogger.warn(
          `Code card failed: ${err instanceof Error ? err.message : err}. Using original image.`,
          "LayoutGenerator",
        );
        workingImagePath = imagePath;
        workingAnalysis = { ...analysis };
      }
    } else if (ocrText && !looksLikeCode) {
      pipelineLogger.info(
        "OCR text does not look like source code (infographic/roadmap) — using original image with branding overlay.",
        "LayoutGenerator",
      );
    }

    // ── 2. Scale the code card / screenshot to fit the CODE ZONE ─────────────
    // Available area for the card (with compact 10px margin/padding for maximum size/readability)
    const maxCardW = CANVAS_W - 20; // 1060px — 10px margin each side
    const maxCardH = CODE_ZONE_H - 20; // 1480px — 10px padding top/bottom

    let scaledW = maxCardW;
    let scaledH = Math.round(scaledW / workingAnalysis.aspectRatio);

    if (scaledH > maxCardH) {
      scaledH = maxCardH;
      scaledW = Math.round(scaledH * workingAnalysis.aspectRatio);
    }

    pipelineLogger.info(
      `Code card scaled to ${scaledW}×${scaledH} (aspect ${workingAnalysis.aspectRatio.toFixed(2)})`,
      "LayoutGenerator",
    );

    const cardLeft = Math.floor((CANVAS_W - scaledW) / 2);
    // Bias 40% from top of zone (not dead-center) so the card sits closer
    // to the logo rather than floating in the middle — looks better on short snippets.
    const cardTop = CODE_ZONE_Y + Math.floor((CODE_ZONE_H - scaledH) * 0.4);

    // ── 3. Build atmospheric SVG background ──────────────────────────────────
    const bgSvg = `<svg width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Background: solid black for clean premium look -->
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%"   stop-color="#000000"/>
      <stop offset="100%" stop-color="#050505"/>
    </linearGradient>

    <!-- Subtle gold grid pattern -->
    <pattern id="goldDots" width="48" height="48" patternUnits="userSpaceOnUse">
      <circle cx="24" cy="24" r="0.75" fill="rgba(255, 215, 0, 0.08)"/>
    </pattern>

    <!-- Card glow filter -->
    <filter id="cardGlow" x="-6%" y="-4%" width="112%" height="108%">
      <feGaussianBlur stdDeviation="10" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <!-- Card border gradient -->
    <linearGradient id="cardBorder" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#FFD700" stop-opacity="0.95"/>
      <stop offset="50%"  stop-color="#FFA500" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#FFD700" stop-opacity="0.95"/>
    </linearGradient>
  </defs>

  <!-- ── Base Background ── -->
  <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#bgGrad)"/>
  <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#goldDots)"/>

  <!-- ── Gold Double Outer Border ── -->
  <!-- Outer sci-fi cut outline -->
  <path d="M 60 30 L 1020 30 L 1050 60 L 1050 1860 L 1020 1890 L 60 1890 L 30 1860 L 30 60 Z"
        fill="none" stroke="#FFD700" stroke-width="2.5" opacity="0.95"/>
  <!-- Inner offset outline -->
  <path d="M 65 38 L 1015 38 L 1042 65 L 1042 1855 L 1015 1882 L 65 1882 L 38 1855 L 38 65 Z"
        fill="none" stroke="#FFD700" stroke-width="1" opacity="0.4"/>

  <!-- Tech details on corners -->
  <!-- Top Left Cut Accents -->
  <line x1="30" y1="90" x2="30" y2="120" stroke="#FFD700" stroke-width="2" opacity="0.6"/>
  <line x1="90" y1="30" x2="120" y2="30" stroke="#FFD700" stroke-width="2" opacity="0.6"/>
  
  <!-- Top Right Cut Accents -->
  <line x1="1050" y1="90" x2="1050" y2="120" stroke="#FFD700" stroke-width="2" opacity="0.6"/>
  <line x1="990" y1="30" x2="960" y2="30" stroke="#FFD700" stroke-width="2" opacity="0.6"/>

  <!-- Bottom Left Cut Accents -->
  <line x1="30" y1="1830" x2="30" y2="1800" stroke="#FFD700" stroke-width="2" opacity="0.6"/>
  <line x1="90" y1="1890" x2="120" y2="1890" stroke="#FFD700" stroke-width="2" opacity="0.6"/>

  <!-- Bottom Right Cut Accents -->
  <line x1="1050" y1="1830" x2="1050" y2="1800" stroke="#FFD700" stroke-width="2" opacity="0.6"/>
  <line x1="990" y1="1890" x2="960" y2="1890" stroke="#FFD700" stroke-width="2" opacity="0.6"/>

  <!-- ── Glowing border around card (code/infographic) ── -->
  <rect x="${cardLeft - 3}" y="${cardTop - 3}"
        width="${scaledW + 6}" height="${scaledH + 6}"
        rx="17" fill="none"
        stroke="url(#cardBorder)" stroke-width="2.5"
        filter="url(#cardGlow)"/>
</svg>`;

    const bgBuffer = await sharp(Buffer.from(bgSvg)).png().toBuffer();

    // ── 4. Resize content — add rounded corners for original (non-code) images ─
    let cardBuffer: Buffer;
    if (!looksLikeCode) {
      // Clip infographic to rounded rectangle so it looks intentional
      const roundedMask = Buffer.from(
        `<svg width="${scaledW}" height="${scaledH}">` +
          `<rect width="${scaledW}" height="${scaledH}" rx="20" ry="20" fill="white"/>` +
          `</svg>`,
      );
      cardBuffer = await sharp(workingImagePath)
        .resize(scaledW, scaledH)
        .composite([{ input: roundedMask, blend: "dest-in" }])
        .png()
        .toBuffer();
    } else {
      cardBuffer = await sharp(workingImagePath)
        .resize(scaledW, scaledH)
        .toBuffer();
    }

    // ── 5. Composite: background → card ──────────────────────────────────────
    await sharp(bgBuffer)
      .composite([{ input: cardBuffer, left: cardLeft, top: cardTop }])
      .toFile(outputPath);

    pipelineLogger.checkpoint(
      "Layout generated",
      true,
      `Card at x:${cardLeft} y:${cardTop} (${scaledW}×${scaledH}) → ${outputPath}`,
    );
    return outputPath;
  }
}
