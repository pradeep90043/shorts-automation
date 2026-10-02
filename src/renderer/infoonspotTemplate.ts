import path from "path";
import fs from "fs";
import sharp from "sharp";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";

export interface InfoOnSpotFrameOptions {
  headline?: string;
  keyPoint?: string;
  location?: string;
  date?: string;
  tempDir: string;
}

function wrapHeadline(text: string, maxCharsPerLine = 24): string[] {
  const clean = text.toUpperCase().replace(/\s+/g, " ").trim();
  const words = clean.split(" ").filter(Boolean);
  if (words.length <= 3 && clean.length <= maxCharsPerLine) {
    return [clean];
  }
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length <= maxCharsPerLine) {
      cur = (cur + " " + w).trim();
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

function wrapKeyPoint(text: string, maxCharsPerLine = 34): string[] {
  const clean = text.toUpperCase().replace(/\s+/g, " ").trim();
  const words = clean.split(" ").filter(Boolean);
  if (clean.length <= maxCharsPerLine) {
    return [clean];
  }
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length <= maxCharsPerLine) {
      cur = (cur + " " + w).trim();
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 2);
}

/**
 * Generates a 1080x1920 broadcast template overlay for InfoOnSpot.
 *
 * It takes the base studio frame (`assets/templates/infoonspot_base.png`),
 * injects LLM-derived dynamic text for [HEADLINE], [KEY POINT], [LOCATION], and [DATE],
 * and applies a feathered alpha cutout in the middle (Y=446 to Y=1585) so the underlying
 * reel video blends into the frame.
 */
export async function generateInfoOnSpotOverlay(
  options: InfoOnSpotFrameOptions,
): Promise<string> {
  const templatePath = path.join(config.paths.assetsDir, "templates", "infoonspot_base.png");
  if (!fs.existsSync(templatePath)) {
    throw new Error(`InfoOnSpot template base missing at: ${templatePath}`);
  }

  const baseImg = sharp(templatePath);
  const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const headlineRaw = options.headline?.trim() || "VIRAL TECH UPDATE";
  const keyPointRaw = options.keyPoint?.trim() || "WATCH FULL BREAKDOWN";
  const locationRaw = (options.location?.trim() || "WORLDWIDE").toUpperCase();
  const dateRaw = (
    options.date?.trim() ||
    new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
  ).toUpperCase();

  // Format Headline Lines
  const headlineLines = wrapHeadline(headlineRaw, 24);
  let headlineSvg = "";
  if (headlineLines.length === 1) {
    headlineSvg = `<text x="450" y="405" font-family="'Impact', 'Archivo Black', 'Arial Black', sans-serif" font-size="40" font-weight="900" fill="#0A0A0A" text-anchor="middle" letter-spacing="0.5">${esc(headlineLines[0])}</text>`;
  } else if (headlineLines.length === 2) {
    headlineSvg = `
      <text x="450" y="384" font-family="'Impact', 'Archivo Black', 'Arial Black', sans-serif" font-size="34" font-weight="900" fill="#0A0A0A" text-anchor="middle" letter-spacing="0.5">${esc(headlineLines[0])}</text>
      <text x="450" y="426" font-family="'Impact', 'Archivo Black', 'Arial Black', sans-serif" font-size="34" font-weight="900" fill="#0A0A0A" text-anchor="middle" letter-spacing="0.5">${esc(headlineLines[1])}</text>
    `;
  } else {
    headlineSvg = `
      <text x="450" y="370" font-family="'Impact', 'Archivo Black', 'Arial Black', sans-serif" font-size="27" font-weight="900" fill="#0A0A0A" text-anchor="middle" letter-spacing="0.5">${esc(headlineLines[0])}</text>
      <text x="450" y="404" font-family="'Impact', 'Archivo Black', 'Arial Black', sans-serif" font-size="27" font-weight="900" fill="#0A0A0A" text-anchor="middle" letter-spacing="0.5">${esc(headlineLines[1])}</text>
      <text x="450" y="438" font-family="'Impact', 'Archivo Black', 'Arial Black', sans-serif" font-size="27" font-weight="900" fill="#0A0A0A" text-anchor="middle" letter-spacing="0.5">${esc(headlineLines[2])}</text>
    `;
  }

  // Format Key Point Lines
  const kpLines = wrapKeyPoint(keyPointRaw, 34);
  let kpSvg = "";
  if (kpLines.length === 1) {
    kpSvg = `
      <text x="540" y="1742" font-family="'Impact', 'Archivo Black', 'Arial Black', sans-serif" font-size="36" font-weight="900" text-anchor="middle" letter-spacing="0.5">
        <tspan fill="#FFFFFF">KEY POINT: </tspan>
        <tspan fill="#FFE600">${esc(kpLines[0])}</tspan>
      </text>
    `;
  } else {
    kpSvg = `
      <text x="540" y="1718" font-family="'Impact', 'Archivo Black', 'Arial Black', sans-serif" font-size="30" font-weight="900" text-anchor="middle" letter-spacing="0.5">
        <tspan fill="#FFFFFF">KEY POINT: </tspan>
        <tspan fill="#FFE600">${esc(kpLines[0])}</tspan>
      </text>
      <text x="540" y="1760" font-family="'Impact', 'Archivo Black', 'Arial Black', sans-serif" font-size="30" font-weight="900" fill="#FFE600" text-anchor="middle" letter-spacing="0.5">
        ${esc(kpLines[1])}
      </text>
    `;
  }

  const dynamicSvg = `
  <svg width="1080" height="1920" viewBox="0 0 1080 1920" xmlns="http://www.w3.org/2000/svg">
    <!-- Patch Location Pill -->
    <rect x="585" y="274" width="205" height="58" rx="29" fill="#FFFFFF"/>
    <g transform="translate(598, 286)">
      <path d="M12 2C7.58 2 4 5.58 4 10c0 5.25 8 13 8 13s8-7.75 8-13c0-4.42-3.58-8-8-8zm0 11c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z" fill="#0A0A0A" transform="scale(1.2)"/>
      <text x="32" y="24" font-family="'Impact', 'Arial Black', sans-serif" font-size="18" font-weight="900" fill="#0A0A0A" letter-spacing="0.5">${esc(locationRaw.slice(0, 14))}</text>
    </g>

    <!-- Patch Date Pill -->
    <rect x="802" y="274" width="195" height="58" rx="29" fill="#0A0D14" stroke="#4A5568" stroke-width="2"/>
    <g transform="translate(814, 286)">
      <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11zM7 11h5v5H7z" fill="#FFFFFF" transform="scale(1.1)"/>
      <text x="28" y="24" font-family="'Impact', 'Arial Black', sans-serif" font-size="18" font-weight="900" fill="#FFFFFF" letter-spacing="0.5">${esc(dateRaw.slice(0, 14))}</text>
    </g>

    <!-- Patch Headline Box (complete coverage up to emoji) -->
    <polygon points="50,338 898,338 868,446 25,446" fill="#FFFFFF"/>
    ${headlineSvg}

    <!-- Patch Bottom Key Point Box -->
    <rect x="75" y="1660" width="930" height="135" rx="10" fill="#080B12"/>
    ${kpSvg}
  </svg>
  `;

  const filledTemplate = await baseImg
    .composite([{ input: Buffer.from(dynamicSvg), top: 0, left: 0 }])
    .png()
    .toBuffer();

  // Alpha mask:
  // Top opaque: 0 to 446
  // Top feather: 446 to 506
  // Transparent video window: 506 to 1530
  // Bottom feather: 1530 to 1585
  // Bottom opaque: 1585 to 1920
  const alphaMaskSvg = `
  <svg width="1080" height="1920" viewBox="0 0 1080 1920" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="topFade" x1="0" y1="446" x2="0" y2="506" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FFFFFF"/>
        <stop offset="100%" stop-color="#000000"/>
      </linearGradient>
      <linearGradient id="botFade" x1="0" y1="1530" x2="0" y2="1585" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#000000"/>
        <stop offset="100%" stop-color="#FFFFFF"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="1080" height="446" fill="#FFFFFF"/>
    <rect x="0" y="446" width="1080" height="60" fill="url(#topFade)"/>
    <rect x="0" y="506" width="1080" height="1024" fill="#000000"/>
    <rect x="0" y="1530" width="1080" height="55" fill="url(#botFade)"/>
    <rect x="0" y="1585" width="1080" height="335" fill="#FFFFFF"/>
  </svg>
  `;

  const maskAlpha = await sharp(Buffer.from(alphaMaskSvg))
    .extractChannel(0)
    .toBuffer();

  const rgbOnly = await sharp(filledTemplate)
    .removeAlpha()
    .toBuffer();

  const outputPath = path.join(options.tempDir, `infoonspot_overlay_${Date.now()}.png`);
  await sharp(rgbOnly)
    .joinChannel(maskAlpha)
    .png()
    .toFile(outputPath);

  pipelineLogger.info(
    `[InfoOnSpotTemplate] Generated dynamic broadcast overlay at ${outputPath}`,
    "VideoRenderer",
  );

  return outputPath;
}
