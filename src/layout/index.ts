import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { ILayoutGenerator, ImageAnalysisResult } from '../types';
import { CodeRenderer } from './code-renderer';
import { config } from '../config';
import { pipelineLogger } from '../utils/logger';

// Zone constants — must match branding/index.ts exactly
export const TOP_RESERVED    = 220;   // Logo zone height
export const BOTTOM_RESERVED = 340;   // Footer zone height
export const CODE_ZONE_Y     = TOP_RESERVED;
export const CODE_ZONE_H     = 1920 - TOP_RESERVED - BOTTOM_RESERVED; // 1360px

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
    const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
    if (lines.length < 3) return false;

    // Strong code indicators — any one is enough
    const strongPatterns = [
      /\bfunction\s+\w+\s*\(/,           // function declaration
      /\bclass\s+\w+\s*[\{(]/,           // class declaration
      /\bvoid\s+\w+\s*\(/,               // Java/C method
      /\bdef\s+\w+\s*\(/,                // Python function
      /\bimport\s+[\w.]+\s*;/,           // Java import with ;
      /\bimport\s+[\w{},\s]+\s+from\s+/, // JS/TS import from
      /\w+\s*=\s*new\s+\w+\s*\(/,       // new instantiation
      /\bSystem\.out\.print/,            // Java print
      /\bconsole\.(log|error|warn)\s*\(/, // JS console
      /\bpublic\s+(static\s+)?[\w<>[\]]+\s+\w+\s*\(/, // Java method sig
      /^\s{2,}\w/m,                      // indented code block (2+ spaces)
    ];

    for (const p of strongPatterns) {
      if (p.test(text)) return true;
    }

    // Density check: code symbols {} ; () [] = make up >4% of non-whitespace
    const codeChars  = (text.match(/[{}()\[\];=]/g) || []).length;
    const totalChars = text.replace(/\s/g, '').length;
    if (totalChars > 0 && codeChars / totalChars > 0.04) return true;

    return false;
  }

  public async generate(
    imagePath: string,
    analysis: ImageAnalysisResult,
    outputPath: string,
    ocrText?: string
  ): Promise<string> {
    pipelineLogger.info(`Generating 9:16 layout for image: ${imagePath}`, 'LayoutGenerator');

    const CANVAS_W = 1080;
    const CANVAS_H = 1920;

    let workingImagePath = imagePath;
    let workingAnalysis  = { ...analysis };

    // ── 1. Render beautified code card — ONLY when OCR text looks like real code ─
    const looksLikeCode = ocrText && ocrText.trim().length > 0 && this.isActualCode(ocrText);

    if (config.rendering.beautifyCode && looksLikeCode) {
      try {
        const tempPath = path.join(path.dirname(outputPath), 'beautified_code.png');

        const lower = ocrText!.toLowerCase();
        const isJava =
          lower.includes('public class') ||
          lower.includes('public static void') ||
          lower.includes('system.out') ||
          lower.includes('import java.');

        await this.codeRenderer.renderCodeToImage(ocrText!, tempPath, isJava);

        if (fs.existsSync(tempPath)) {
          pipelineLogger.info('OCR text looks like code — using beautified code card.', 'LayoutGenerator');
          workingImagePath = tempPath;
          const meta = await sharp(tempPath).metadata();
          if (meta.width && meta.height) {
            workingAnalysis = {
              width: meta.width,
              height: meta.height,
              aspectRatio: meta.width / meta.height,
              orientation: meta.height > meta.width ? 'portrait' : 'landscape',
              hasBlackMargins: false,
              hasWhiteMargins: false,
            };
          }
        }
      } catch (err) {
        pipelineLogger.warn(
          `Code card failed: ${err instanceof Error ? err.message : err}. Using original image.`,
          'LayoutGenerator'
        );
        workingImagePath = imagePath;
        workingAnalysis  = { ...analysis };
      }
    } else if (ocrText && !looksLikeCode) {
      pipelineLogger.info(
        'OCR text does not look like source code (infographic/roadmap) — using original image with branding overlay.',
        'LayoutGenerator'
      );
    }

    // ── 2. Scale the code card / screenshot to fit the CODE ZONE ─────────────
    // Available area for the card (with inner padding)
    const maxCardW = CANVAS_W - 40;      // 1040px — 20px margin each side
    const maxCardH = CODE_ZONE_H - 40;   // 1320px — 20px padding top/bottom

    let scaledW = maxCardW;
    let scaledH = Math.round(scaledW / workingAnalysis.aspectRatio);

    if (scaledH > maxCardH) {
      scaledH = maxCardH;
      scaledW = Math.round(scaledH * workingAnalysis.aspectRatio);
    }

    pipelineLogger.info(
      `Code card scaled to ${scaledW}×${scaledH} (aspect ${workingAnalysis.aspectRatio.toFixed(2)})`,
      'LayoutGenerator'
    );

    const cardLeft = Math.floor((CANVAS_W - scaledW) / 2);
    // Bias 40% from top of zone (not dead-center) so the card sits closer
    // to the logo rather than floating in the middle — looks better on short snippets.
    const cardTop  = CODE_ZONE_Y + Math.floor((CODE_ZONE_H - scaledH) * 0.40);

    // ── 3. Build atmospheric SVG background ──────────────────────────────────
    const bgSvg = `<svg width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Base dark gradient -->
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%"   stop-color="#080C14"/>
      <stop offset="45%"  stop-color="#0A0F1C"/>
      <stop offset="100%" stop-color="#060A12"/>
    </linearGradient>

    <!-- Atmospheric glow behind code zone -->
    <radialGradient id="codeGlow" cx="50%" cy="50%" r="55%">
      <stop offset="0%"   stop-color="#1A0A50" stop-opacity="0.45"/>
      <stop offset="60%"  stop-color="#0A1A3A" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#080C14" stop-opacity="0"/>
    </radialGradient>

    <!-- Top purple accent glow -->
    <radialGradient id="topGlow" cx="50%" cy="0%" r="60%">
      <stop offset="0%"   stop-color="#5500CC" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#080C14" stop-opacity="0"/>
    </radialGradient>

    <!-- Bottom cyan accent glow -->
    <radialGradient id="botGlow" cx="50%" cy="100%" r="50%">
      <stop offset="0%"   stop-color="#00C8FF" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#080C14" stop-opacity="0"/>
    </radialGradient>

    <!-- Dot grid pattern -->
    <pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse">
      <circle cx="16" cy="16" r="1" fill="rgba(120,140,220,0.09)"/>
    </pattern>

    <!-- Card glow filter -->
    <filter id="cardGlow" x="-6%" y="-4%" width="112%" height="108%">
      <feGaussianBlur stdDeviation="14" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <!-- Card border gradient -->
    <linearGradient id="cardBorder" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#6600EE" stop-opacity="0.85"/>
      <stop offset="45%"  stop-color="#00E5FF" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#FF0066" stop-opacity="0.85"/>
    </linearGradient>
  </defs>

  <!-- ── Base ── -->
  <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#bgGrad)"/>

  <!-- ── Dot grid ── -->
  <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#dots)"/>

  <!-- ── Atmospheric glows ── -->
  <rect width="${CANVAS_W}" height="600" fill="url(#topGlow)"/>
  <rect y="${CODE_ZONE_Y}" width="${CANVAS_W}" height="${CODE_ZONE_H}" fill="url(#codeGlow)"/>
  <rect y="${CANVAS_H - 600}" width="${CANVAS_W}" height="600" fill="url(#botGlow)"/>

  <!-- ── Zone separator lines ── -->
  <line x1="60" y1="${TOP_RESERVED}" x2="${CANVAS_W - 60}" y2="${TOP_RESERVED}"
        stroke="rgba(100,0,240,0.22)" stroke-width="1"/>
  <line x1="60" y1="${CANVAS_H - BOTTOM_RESERVED}" x2="${CANVAS_W - 60}" y2="${CANVAS_H - BOTTOM_RESERVED}"
        stroke="rgba(0,220,255,0.22)" stroke-width="1"/>

  <!-- ── Corner bracket top-left ── -->
  <path d="M 42 ${TOP_RESERVED + 24} L 42 ${TOP_RESERVED + 8} L 66 ${TOP_RESERVED + 8}"
        fill="none" stroke="#6600EE" stroke-width="2" opacity="0.5"/>
  <!-- ── Corner bracket top-right ── -->
  <path d="M ${CANVAS_W - 42} ${TOP_RESERVED + 24} L ${CANVAS_W - 42} ${TOP_RESERVED + 8} L ${CANVAS_W - 66} ${TOP_RESERVED + 8}"
        fill="none" stroke="#00E5FF" stroke-width="2" opacity="0.5"/>
  <!-- ── Corner bracket bottom-left ── -->
  <path d="M 42 ${CANVAS_H - BOTTOM_RESERVED - 24} L 42 ${CANVAS_H - BOTTOM_RESERVED - 8} L 66 ${CANVAS_H - BOTTOM_RESERVED - 8}"
        fill="none" stroke="#00E5FF" stroke-width="2" opacity="0.5"/>
  <!-- ── Corner bracket bottom-right ── -->
  <path d="M ${CANVAS_W - 42} ${CANVAS_H - BOTTOM_RESERVED - 24} L ${CANVAS_W - 42} ${CANVAS_H - BOTTOM_RESERVED - 8} L ${CANVAS_W - 66} ${CANVAS_H - BOTTOM_RESERVED - 8}"
        fill="none" stroke="#FF0066" stroke-width="2" opacity="0.5"/>

  <!-- ── Glowing border around code card position ── -->
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
        `</svg>`
      );
      cardBuffer = await sharp(workingImagePath)
        .resize(scaledW, scaledH)
        .composite([{ input: roundedMask, blend: 'dest-in' }])
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

    pipelineLogger.checkpoint('Layout generated', true,
      `Card at x:${cardLeft} y:${cardTop} (${scaledW}×${scaledH}) → ${outputPath}`);
    return outputPath;
  }
}
