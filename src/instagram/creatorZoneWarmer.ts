import fs from "fs";
import path from "path";
import sharp from "sharp";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { creatorZoneStore } from "../utils/creatorZones";
import { OcrService } from "../ocr";
import { OcrWord, BrandingZone } from "../types";
import { listChannelReels } from "./channelFeed";
import { downloadReelFrame } from "./index";

const ocr = new OcrService();

/**
 * For a channel-watch account, we already know the exact @handle to look
 * for — that's a much narrower, purely local task than general branding
 * detection (which has to identify unknown zones with no prior knowledge),
 * so it doesn't need FreeLLMAPI/Gemini vision quota at all. Tesseract OCR
 * (already used elsewhere in this pipeline, src/ocr/index.ts) just has to
 * confirm where the known username string sits on the frame.
 */
export function findCreatorZoneViaOcr(
  words: OcrWord[],
  imageWidth: number,
  imageHeight: number,
  username: string,
): BrandingZone[] | null {
  const target = username.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (target.length < 3) return null;

  const match = words.find((w) => {
    const norm = w.text.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (norm.length < 3) return false;
    return norm === target || norm.includes(target) || target.includes(norm);
  });
  if (!match) return null;

  const { bbox } = match;
  const handleZone: BrandingZone = {
    id: "ocr-creator-handle",
    type: "handle",
    boundingBox: {
      x: bbox.x0 / imageWidth,
      y: bbox.y0 / imageHeight,
      width: (bbox.x1 - bbox.x0) / imageWidth,
      height: (bbox.y1 - bbox.y0) / imageHeight,
    },
    confidence: 0.7,
    description: `@${username} (found via local OCR, no AI vision used)`,
  };

  // Heuristic, not detected: repost-account overlays almost always put a
  // circular profile picture immediately to the left of the handle text,
  // roughly the same height. OCR can't see it (no text), so estimate its
  // box from the handle's own position rather than leaving it uncovered.
  const picSize = (bbox.y1 - bbox.y0) * 1.1;
  const picZone: BrandingZone = {
    id: "ocr-creator-profile-pic",
    type: "profile_picture",
    boundingBox: {
      x: Math.max(0, (bbox.x0 - picSize * 1.3) / imageWidth),
      y: bbox.y0 / imageHeight,
      width: picSize / imageWidth,
      height: picSize / imageHeight,
    },
    confidence: 0.4,
    description: `estimated profile picture position near @${username} (not directly detected)`,
  };

  return [handleZone, picZone];
}

export interface WarmResult {
  channel: string;
  found: boolean;
  reason?: string;
}

/**
 * Runs once per configured watch channel across all profiles: downloads one
 * recent reel's frame and OCRs it locally for the channel's own handle. Safe
 * to re-run — already-cached creators are skipped, and a miss here never
 * overwrites a zone found some other way (CreatorZoneStore.saveZones no-ops
 * on empty results).
 */
export async function warmCreatorZonesFromOcr(): Promise<WarmResult[]> {
  const channels = new Set<string>();
  for (const profile of config.profiles) {
    for (const ch of profile.watch.channels) channels.add(ch);
  }

  const results: WarmResult[] = [];
  for (const channel of channels) {
    if (creatorZoneStore.getZones(channel)) {
      results.push({ channel, found: true, reason: "already cached" });
      continue;
    }

    const tempDir = path.join(config.paths.tempDir, `warm-${channel}`);
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      const reels = await listChannelReels(channel);
      if (reels.length === 0) {
        results.push({ channel, found: false, reason: "no reels listed" });
        continue;
      }

      const { framePath } = await downloadReelFrame(reels[0].url, tempDir);
      const metadata = await sharp(framePath).metadata();
      const { width, height } = metadata;
      if (!width || !height) {
        results.push({ channel, found: false, reason: "could not read frame dimensions" });
        continue;
      }

      const ocrResult = await ocr.extractText(framePath);
      const zones = findCreatorZoneViaOcr(
        ocrResult.detailedWords || [],
        width,
        height,
        channel,
      );

      if (zones) {
        creatorZoneStore.saveZones(channel, zones);
        results.push({ channel, found: true });
      } else {
        results.push({ channel, found: false, reason: "handle not found via OCR on sampled frame" });
      }
    } catch (err) {
      pipelineLogger.warn(
        `Creator zone warm-up failed for @${channel}: ${err instanceof Error ? err.message : err}`,
        "CreatorZoneWarmer",
      );
      results.push({
        channel,
        found: false,
        reason: err instanceof Error ? err.message.slice(0, 100) : String(err),
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return results;
}
