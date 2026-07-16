import fs from "fs";
import sharp from "sharp";
import { pipelineLogger } from "./logger";

/**
 * Overlay a crop-guide grid on a frame for the settings review preview.
 * Horizontal lines every 10% of the height carry their percentage label
 * directly on the line (matches the crop buttons); vertical lines V1–V5
 * split the width in sixths with the label sitting on the line at the top.
 * Returns outPath, or null if the overlay could not be produced.
 */
export async function buildGridPreview(
  srcPath: string,
  outPath: string,
): Promise<string | null> {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) return null;

    const meta = await sharp(srcPath).metadata();
    const w = meta.width || 1080;
    const h = meta.height || 1920;
    const fontSize = Math.max(18, Math.round(h * 0.025));

    // Horizontal lines every 10%, label box centered ON the line at the left edge
    const hLines = Array.from({ length: 9 }, (_, i) => {
      const pct = (i + 1) * 10;
      const y = (h * pct) / 100;
      const boxW = fontSize * 3;
      const boxH = fontSize * 1.5;
      return (
        `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="rgba(255,255,0,0.9)" stroke-width="3"/>` +
        `<rect x="8" y="${y - boxH / 2}" width="${boxW}" height="${boxH}" rx="6" fill="rgba(0,0,0,0.75)"/>` +
        `<text x="${8 + boxW / 2}" y="${y + fontSize * 0.35}" text-anchor="middle" font-family="sans-serif" font-size="${fontSize}" font-weight="bold" fill="yellow">${pct}%</text>`
      );
    }).join("");

    // Vertical lines in sixths, label box centered ON the line near the top
    const vLines = Array.from({ length: 5 }, (_, i) => {
      const x = (w * (i + 1)) / 6;
      const boxW = fontSize * 2.2;
      const boxH = fontSize * 1.5;
      const boxY = h * 0.03;
      return (
        `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="rgba(255,255,0,0.9)" stroke-width="3"/>` +
        `<rect x="${x - boxW / 2}" y="${boxY}" width="${boxW}" height="${boxH}" rx="6" fill="rgba(0,0,0,0.75)"/>` +
        `<text x="${x}" y="${boxY + fontSize * 1.1}" text-anchor="middle" font-family="sans-serif" font-size="${fontSize}" font-weight="bold" fill="yellow">V${i + 1}</text>`
      );
    }).join("");

    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${hLines}${vLines}</svg>`;
    await sharp(srcPath)
      .composite([{ input: Buffer.from(svg) }])
      .toFile(outPath);
    return outPath;
  } catch (err) {
    pipelineLogger.warn(
      `Failed to build grid preview: ${err instanceof Error ? err.message : err}`,
      "GridPreview",
    );
    return null;
  }
}
