import fs from "fs";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { iconFor, iconSvg } from "./rowIcons";
import { ListCardContent } from "./listCard";

export interface HtmlCardOptions {
  footer?: string;
  heroBuffer?: Buffer | null;
}

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hexToRgb(hex: string): string {
  const clean = (hex || "").replace("#", "").trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16) || 255;
    const g = parseInt(clean[1] + clean[1], 16) || 184;
    const b = parseInt(clean[2] + clean[2], 16) || 0;
    return `${r}, ${g}, ${b}`;
  }
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16) || 255;
    const g = parseInt(clean.slice(2, 4), 16) || 184;
    const b = parseInt(clean.slice(4, 6), 16) || 0;
    return `${r}, ${g}, ${b}`;
  }
  return "255, 184, 0";
}

/** Check if every row has a compact metric/numeric value e.g. "₹15 LPA", "250-300", "5 tonnes" */
function isMetricValue(v: string): boolean {
  const s = (v || "").trim();
  if (!s || s.length > 15) return false;
  const words = s.split(/\s+/);
  return words.length <= 3 || /^[₹$€£\d\s\-.,%a-zA-Z/+]+$/.test(s);
}

export function buildCardHtml(
  c: ListCardContent,
  accent: string,
  opts?: { heroDataUri?: string; footer?: string }
): string {
  const accentRgb = hexToRgb(accent);
  const isMetricCard = c.rows.length > 0 && c.rows.every((r) => isMetricValue(r.value));

  // Adaptive sizing based on row count
  const n = c.rows.length;
  const rowPad = n <= 5 ? "22px 0" : n <= 8 ? "18px 0" : "14px 0";
  const rowFontSize = n <= 5 ? 40 : n <= 8 ? 37 : 33;
  const valueFontSize = rowFontSize + 6;
  const iconPx = n <= 5 ? 64 : n <= 8 ? 58 : 50;

  // Title sizing
  const titleLen = (c.title || "").length;
  const titleFontSize = titleLen > 50 ? 54 : titleLen > 35 ? 62 : 68;

  const rowsHtml = c.rows
    .map((r, i) => {
      const iconKey = iconFor(r.label || r.value);
      const innerSvg = iconSvg(iconKey, 0, 0, iconPx, accent);
      const isMetricRow = isMetricCard && Boolean(r.value && r.value.trim());

      const fullLabel = !isMetricCard && r.value && r.value !== r.label
        ? `${r.label} — ${r.value}`
        : r.label;

      const valueColor = i >= c.rows.length - 2 ? accent : "#ffffff";

      return `
      <div class="card-row">
        <div class="row-icon">
          <svg viewBox="0 0 ${iconPx} ${iconPx}" width="${iconPx}" height="${iconPx}" fill="none" stroke="${accent}" stroke-width="2">
            ${innerSvg}
          </svg>
        </div>
        <div class="row-label">${esc(fullLabel)}</div>
        ${isMetricRow ? `<div class="row-value" style="color: ${valueColor}">${esc(r.value)}</div>` : ""}
      </div>`;
    })
    .join("\n");

  const heroTag = opts?.heroDataUri
    ? `<img class="bg-hero" src="${opts.heroDataUri}" alt="" />`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  :root {
    --accent: ${accent};
    --accent-rgb: ${accentRgb};
  }
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    -webkit-font-smoothing: antialiased;
  }
  html, body {
    width: 1080px;
    margin: 0;
    padding: 0;
    background-color: #050b1c;
    background-image: radial-gradient(circle at 70% 15%, rgba(var(--accent-rgb), 0.32) 0%, transparent 65%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Noto Sans Devanagari", sans-serif;
    color: #ffffff;
  }
  body {
    min-height: 1920px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
  }
  .bg-hero {
    position: absolute;
    top: 0;
    left: 0;
    width: 1080px;
    height: 1400px;
    object-fit: cover;
    z-index: 1;
  }
  .bg-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 1080px;
    height: 100%;
    background: linear-gradient(
      180deg,
      rgba(5, 11, 28, 0.35) 0%,
      rgba(5, 11, 28, 0.62) 500px,
      rgba(5, 11, 28, 0.96) 1200px,
      #050b1c 100%
    );
    z-index: 2;
  }
  .card-page {
    position: relative;
    z-index: 10;
    width: 1080px;
    padding: 160px 60px 140px 60px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .card-title {
    width: 960px;
    font-size: ${titleFontSize}px;
    font-weight: 800;
    line-height: 1.25;
    text-align: center;
    color: #ffffff;
    text-shadow: 0 4px 16px rgba(0, 0, 0, 0.65);
    margin-bottom: 24px;
    word-break: break-word;
  }
  .card-rule {
    width: 220px;
    height: 6px;
    background: var(--accent);
    border-radius: 3px;
    margin-bottom: 42px;
  }
  .card-box {
    width: 960px;
    background: rgba(8, 14, 30, 0.88);
    border: 3px solid var(--accent);
    border-radius: 46px;
    padding: 24px 40px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
  }
  .card-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 28px;
    padding: ${rowPad};
    border-bottom: 2px solid rgba(255, 255, 255, 0.12);
  }
  .card-row:last-child {
    border-bottom: none;
  }
  .row-icon {
    flex-shrink: 0;
    width: ${iconPx}px;
    height: ${iconPx}px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .row-icon svg {
    width: ${iconPx}px;
    height: ${iconPx}px;
  }
  .row-label {
    flex: 1;
    min-width: 0;
    font-size: ${rowFontSize}px;
    font-weight: 500;
    line-height: 1.35;
    color: rgba(255, 255, 255, 0.95);
    overflow-wrap: break-word;
    word-break: break-word;
  }
  .row-value {
    flex-shrink: 0;
    font-size: ${valueFontSize}px;
    font-weight: 700;
    text-align: right;
    white-space: nowrap;
    margin-left: 20px;
  }
  .card-closing {
    margin-top: 40px;
    width: 920px;
    text-align: center;
    font-size: 42px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.92);
    line-height: 1.4;
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.7);
  }
  .card-footer {
    margin-top: 36px;
    text-align: center;
    font-size: 30px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.7);
    letter-spacing: 1px;
  }
</style>
</head>
<body>
  ${heroTag}
  <div class="bg-overlay"></div>
  <div class="card-page">
    <div class="card-title">${esc(c.title)}</div>
    <div class="card-rule"></div>
    <div class="card-box">
      ${rowsHtml}
    </div>
    ${c.closing ? `<div class="card-closing">${esc(c.closing)}</div>` : ""}
    ${opts?.footer ? `<div class="card-footer">${esc(opts.footer)}</div>` : ""}
  </div>
</body>
</html>`;
}

/**
 * Renders a list card to a PNG using Puppeteer + HTML/CSS Flexbox.
 * Guarantees zero text overlap, perfect word wrapping, and dynamic height scaling.
 */
export async function renderListCardHtml(
  c: ListCardContent,
  accent: string,
  outPng: string,
  opts?: HtmlCardOptions
): Promise<string> {
  const heroDataUri = opts?.heroBuffer
    ? `data:image/jpeg;base64,${opts.heroBuffer.toString("base64")}`
    : undefined;

  const html = buildCardHtml(c, accent, { heroDataUri, footer: opts?.footer });

  const puppeteer = (await new Function("return import('puppeteer-core')")()).default;
  const browser = await puppeteer.launch({
    executablePath: config.binaries.chrome,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--force-color-profile=srgb",
    ],
  });

  try {
    const page = await browser.newPage();
    // Default 1080x1920
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    // Measure rendered document height
    const scrollH = (await page.evaluate("document.documentElement.scrollHeight")) as number;
    const finalH = Math.max(1920, scrollH);

    if (finalH > 1920) {
      await page.setViewport({ width: 1080, height: finalH, deviceScaleFactor: 1 });
    }

    fs.mkdirSync(path.dirname(outPng), { recursive: true });
    await page.screenshot({
      path: outPng,
      type: "png",
      clip: { x: 0, y: 0, width: 1080, height: finalH },
    });
    pipelineLogger.info(
      `List card (HTML/Flexbox): "${c.title}", ${c.rows.length} rows (${1080}x${finalH})`,
      "ListCard"
    );
    return outPng;
  } finally {
    await browser.close();
  }
}
