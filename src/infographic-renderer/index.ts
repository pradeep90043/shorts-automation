import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { InfographicContent } from "../types";
import { pipelineLogger } from "../utils/logger";
import { config } from "../config";

// Canvas dimensions
const W = 1080;
const H = 1920;
const TOP_RESERVED = 160;
const BOTTOM_RESERVED = 260;

export class InfographicRenderer {
  private static esc(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private buildHTML(content: InfographicContent, transparent: boolean): string {
    const bodyBg = transparent ? "rgba(11,11,11,0.82)" : "#0B0B0B";

    const cardsHTML = content.items
      .map(
        (item) => `
      <div class="card">
        <div class="card-bar"></div>
        <div class="card-inner">
          <div class="card-top">
            <div class="badge">${String(item.number).padStart(2, "0")}</div>
            <div class="card-title">${InfographicRenderer.esc(item.icon ?? "")} ${InfographicRenderer.esc(item.title)}</div>
          </div>
          <p class="card-desc">${InfographicRenderer.esc(item.description)}</p>
          ${item.tag ? `<span class="tag">${InfographicRenderer.esc(item.tag)}</span>` : ""}
        </div>
      </div>
    `,
      )
      .join("");

    const summaryHTML =
      content.tipLeft || content.tipRight
        ? `
      <div class="summary">
        <div class="summary-header">🏆 TOP PICKS</div>
        <div class="summary-cols">
          ${
            content.tipLeft
              ? `
            <div class="summary-col">
              <div class="col-label">BEST OVERALL</div>
              <p class="col-text">${InfographicRenderer.esc(content.tipLeft)}</p>
            </div>`
              : "<div></div>"
          }
          ${
            content.tipRight
              ? `
            <div class="summary-col">
              <div class="col-label">PRO TIP</div>
              <p class="col-text">${InfographicRenderer.esc(content.tipRight)}</p>
            </div>`
              : "<div></div>"
          }
        </div>
      </div>`
        : "";

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: ${W}px;
    height: ${H}px;
    background: ${bodyBg};
    font-family: 'Arial Black', 'Arial', sans-serif;
    color: #fff;
    overflow: hidden;
  }

  /* Circuit dot overlay */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image: radial-gradient(circle, rgba(255,184,0,0.07) 1px, transparent 1px);
    background-size: 48px 48px;
    pointer-events: none;
  }

  .top-zone    { height: ${TOP_RESERVED}px; }
  .bottom-zone { height: ${BOTTOM_RESERVED}px; }

  .content {
    height: ${H - TOP_RESERVED - BOTTOM_RESERVED}px;
    padding: 0 48px;
    display: flex;
    flex-direction: column;
  }

  /* ── HUD corner brackets ── */
  .content::before, .content::after {
    content: '';
    position: absolute;
    width: 54px; height: 54px;
    border-color: rgba(255,184,0,0.55);
    border-style: solid;
  }
  .content::before {
    top: ${TOP_RESERVED + 18}px; left: 40px;
    border-width: 2px 0 0 2px;
  }
  .content::after {
    top: ${TOP_RESERVED + 18}px; right: 40px;
    border-width: 2px 2px 0 0;
  }

  /* ── Series tag ── */
  .series-tag {
    font-size: 20px;
    font-weight: 700;
    font-family: Arial, sans-serif;
    color: rgba(255,184,0,0.65);
    text-align: center;
    letter-spacing: 5px;
    padding-top: 44px;
    margin-bottom: 18px;
  }

  /* ── Title ── */
  .title {
    font-size: 80px;
    font-weight: 900;
    color: #fff;
    text-align: center;
    line-height: 1.05;
    text-shadow: 0 0 40px rgba(255,255,255,0.25);
    margin-bottom: 6px;
    word-break: break-word;
  }

  /* ── Accent ── */
  .accent {
    font-size: 86px;
    font-weight: 900;
    font-style: italic;
    color: #FFB800;
    text-align: center;
    line-height: 1.05;
    text-shadow: 0 0 40px rgba(255,184,0,0.45);
    margin-bottom: 10px;
    word-break: break-word;
  }

  /* ── Subtitle ── */
  .subtitle {
    font-size: 26px;
    font-weight: 400;
    font-family: Arial, sans-serif;
    color: #999;
    text-align: center;
    margin-bottom: 14px;
  }

  /* ── Divider ── */
  .divider {
    height: 1px;
    background: linear-gradient(90deg,
      transparent 0%, #FFB800 20%, #FFB800 80%, transparent 100%);
    margin-bottom: 14px;
  }

  /* ── Grid ── */
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-auto-rows: 1fr;
    gap: 12px 18px;
    flex: 1;
  }

  /* ── Card ── */
  .card {
    display: flex;
    background: #0D0D0D;
    border: 1px solid rgba(255,184,0,0.22);
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 0 12px rgba(255,184,0,0.06);
  }

  .card-bar {
    width: 6px;
    background: #FFB800;
    flex-shrink: 0;
  }

  .card-inner {
    padding: 12px 14px 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    flex: 1;
    justify-content: space-between;
  }

  .card-top {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .badge {
    width: 44px;
    height: 44px;
    border: 2px solid #FFB800;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 900;
    color: #FFB800;
    flex-shrink: 0;
  }

  .card-title {
    font-size: 24px;
    font-weight: 900;
    color: #FFB800;
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .card-desc {
    font-size: 18px;
    font-weight: 400;
    font-family: Arial, sans-serif;
    color: #CCC;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .tag {
    display: inline-block;
    padding: 2px 8px;
    border: 1px solid #FF8A00;
    border-radius: 3px;
    font-size: 14px;
    font-weight: 700;
    font-family: Arial, sans-serif;
    color: #FF8A00;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    align-self: flex-start;
  }

  /* ── Summary ── */
  .summary {
    border: 1px solid rgba(255,184,0,0.28);
    border-radius: 4px;
    background: #0D0D0D;
    padding: 18px 24px;
    margin-top: 12px;
  }

  .summary-header {
    font-size: 20px;
    font-weight: 700;
    font-family: Arial, sans-serif;
    color: #FFB800;
    text-align: center;
    letter-spacing: 3px;
    text-transform: uppercase;
    margin-bottom: 10px;
  }

  .summary-cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .summary-col {
    border-left: 2px solid rgba(255,184,0,0.3);
    padding-left: 10px;
  }

  .col-label {
    font-size: 16px;
    font-weight: 700;
    font-family: Arial, sans-serif;
    color: #FF8A00;
    letter-spacing: 1px;
    margin-bottom: 4px;
  }

  .col-text {
    font-size: 18px;
    font-family: Arial, sans-serif;
    font-weight: 400;
    color: #CCC;
    line-height: 1.4;
  }
</style>
</head>
<body>
  <div class="top-zone"></div>
  <div class="content">
    <div class="series-tag">── TOP ${content.items.length} ──</div>
    <h1 class="title">${InfographicRenderer.esc(content.title)}</h1>
    <h2 class="accent">${InfographicRenderer.esc(content.titleAccent)}</h2>
    ${content.subtitle ? `<p class="subtitle">${InfographicRenderer.esc(content.subtitle)}</p>` : ""}
    <div class="divider"></div>
    <div class="grid">${cardsHTML}</div>
    ${summaryHTML}
  </div>
  <div class="bottom-zone"></div>
</body>
</html>`;
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  public async renderToBuffer(
    content: InfographicContent,
    transparentBg = false,
  ): Promise<Buffer> {
    const html = this.buildHTML(content, transparentBg);

    const browser = await puppeteer.launch({
      executablePath: config.binaries.chrome,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--force-color-profile=srgb",
      ],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: "domcontentloaded" });

      const shot = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: W, height: H },
        omitBackground: transparentBg,
      });

      return Buffer.from(shot);
    } finally {
      await browser.close();
    }
  }

  public async render(
    content: InfographicContent,
    outputPath: string,
  ): Promise<string> {
    pipelineLogger.info(
      `Rendering infographic: "${content.title} ${content.titleAccent}" (${content.items.length} items)`,
      "InfographicRenderer",
    );
    const buf = await this.renderToBuffer(content, false);
    await sharp(buf).toFile(outputPath);
    pipelineLogger.checkpoint(
      "Infographic rendered",
      true,
      `${content.items.length} items → ${outputPath}`,
    );
    return outputPath;
  }
}
