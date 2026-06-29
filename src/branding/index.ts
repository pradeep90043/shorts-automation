import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { IBrandingService } from '../types';
import { config } from '../config';
import { pipelineLogger } from '../utils/logger';
import { TOP_RESERVED, BOTTOM_RESERVED } from '../layout';

const CANVAS_W = 1080;
const CANVAS_H = 1920;

export class BrandingService implements IBrandingService {
  public async applyCodeOrCapBranding(
    layoutImagePath: string,
    outputPath: string
  ): Promise<string> {
    pipelineLogger.info(`Applying CodeOrCap branding to ${layoutImagePath}`, 'BrandingService');

    const logoPath = path.join(config.paths.assetsDir, 'logo.png');
    if (!fs.existsSync(logoPath)) {
      throw new Error(`Branding logo not found at ${logoPath}.`);
    }

    const composites: sharp.OverlayOptions[] = [];

    // ── Logo ─────────────────────────────────────────────────────────────────
    // Logo is 400×120px. Fit it within the TOP_RESERVED zone (220px).
    // We target 340px wide → 102px tall, leaving ~59px vertical padding.
    const LOGO_W     = 340;
    const LOGO_H     = Math.round(LOGO_W * (120 / 400));  // ≈ 102px
    const logoBuffer = await sharp(logoPath).resize(LOGO_W, LOGO_H).toBuffer();
    const logoLeft   = Math.floor((CANVAS_W - LOGO_W) / 2);
    const logoTop    = Math.floor((TOP_RESERVED - LOGO_H) / 2); // vertically centered in zone

    composites.push({ input: logoBuffer, left: logoLeft, top: logoTop });


    // ── Footer (bottom zone = BOTTOM_RESERVED = 340px) ───────────────────────
    const footerY = CANVAS_H - BOTTOM_RESERVED;
    const footerSvg = `<svg width="${CANVAS_W}" height="${BOTTOM_RESERVED}" viewBox="0 0 ${CANVAS_W} ${BOTTOM_RESERVED}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Footer background gradient -->
    <linearGradient id="footerBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%"   stop-color="#070A12" stop-opacity="0.0"/>
      <stop offset="20%"  stop-color="#08102A" stop-opacity="0.92"/>
      <stop offset="100%" stop-color="#060810" stop-opacity="1"/>
    </linearGradient>

    <!-- Neon top-border gradient -->
    <linearGradient id="neonLine" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%"   stop-color="#FF0066"  stop-opacity="0"/>
      <stop offset="20%"  stop-color="#FF0066"  stop-opacity="1"/>
      <stop offset="50%"  stop-color="#00E5FF"  stop-opacity="1"/>
      <stop offset="80%"  stop-color="#6600EE"  stop-opacity="1"/>
      <stop offset="100%" stop-color="#6600EE"  stop-opacity="0"/>
    </linearGradient>

    <!-- FOLLOW text glow filter -->
    <filter id="textGlow" x="-10%" y="-20%" width="120%" height="140%">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <!-- At-handle glow -->
    <filter id="handleGlow" x="-5%" y="-15%" width="110%" height="130%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Dark fade background -->
  <rect width="${CANVAS_W}" height="${BOTTOM_RESERVED}" fill="url(#footerBg)"/>

  <!-- Top neon divider line -->
  <rect x="0" y="0" width="${CANVAS_W}" height="2" fill="url(#neonLine)"/>

  <!-- Accent dots on the divider -->
  <circle cx="80"            cy="1" r="4" fill="#FF0066" opacity="0.9"/>
  <circle cx="${CANVAS_W/2}" cy="1" r="4" fill="#00E5FF" opacity="0.9"/>
  <circle cx="${CANVAS_W-80}" cy="1" r="4" fill="#6600EE" opacity="0.9"/>

  <!-- Left bracket accent -->
  <path d="M 60 60 L 60 35 L 85 35" fill="none" stroke="#6600EE" stroke-width="2.5" opacity="0.7"/>
  <!-- Right bracket accent -->
  <path d="M ${CANVAS_W-60} 60 L ${CANVAS_W-60} 35 L ${CANVAS_W-85} 35" fill="none" stroke="#00E5FF" stroke-width="2.5" opacity="0.7"/>

  <!-- "FOLLOW" label -->
  <text x="${CANVAS_W/2}" y="96"
        fill="#E0E8FF"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif"
        font-size="22" font-weight="700"
        text-anchor="middle" letter-spacing="12"
        filter="url(#textGlow)">FOLLOW</text>

  <!-- "@CodeOrCap" in neon cyan — big and bold -->
  <text x="${CANVAS_W/2}" y="170"
        fill="#00E5FF"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif"
        font-size="54" font-weight="900"
        text-anchor="middle" letter-spacing="2"
        filter="url(#handleGlow)">@CodeOrCap</text>

  <!-- Subtitle -->
  <text x="${CANVAS_W/2}" y="218"
        fill="#5C7A9A"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif"
        font-size="16" font-weight="500"
        text-anchor="middle" letter-spacing="4">DAILY CODING TIPS &amp; TRICKS</text>

  <!-- HUD tick marks below subtitle -->
  <rect x="${CANVAS_W/2 - 50}" y="235" width="40" height="3" rx="1.5" fill="#6600EE" opacity="0.6"/>
  <rect x="${CANVAS_W/2 - 5}"  y="235" width="10" height="3" rx="1.5" fill="#00E5FF" opacity="0.8"/>
  <rect x="${CANVAS_W/2 + 10}" y="235" width="40" height="3" rx="1.5" fill="#FF0066" opacity="0.6"/>

  <!-- Subscribe prompt -->
  <text x="${CANVAS_W/2}" y="282"
        fill="#3A5070"
        font-family="-apple-system, BlinkMacSystemFont, sans-serif"
        font-size="14" font-weight="500"
        text-anchor="middle" letter-spacing="3">TAP  SUBSCRIBE  FOR  MORE</text>
</svg>`;

    const footerBuf = await sharp(Buffer.from(footerSvg)).png().toBuffer();
    composites.push({ input: footerBuf, left: 0, top: footerY });

    // ── Composite all layers onto the layout image ────────────────────────────
    await sharp(layoutImagePath).composite(composites).toFile(outputPath);

    pipelineLogger.checkpoint('Branding applied', true,
      `Logo at y:${logoTop}, footer at y:${footerY} → ${outputPath}`);
    return outputPath;
  }
}
