import { exec } from "child_process";
import path from "path";
import fs from "fs";
import sharp from "sharp";
import {
  IVideoRenderer,
  RenderOptions,
  PipelineContext,
  BrandingZone,
} from "../types";
import { pipelineLogger } from "../utils/logger";
import { config } from "../config";
import { ImageAnalyzer } from "../image-analysis";
import { BrandingDetector, SocialHandleDetector } from "../branding-detector";
import { OcrService } from "../ocr/index";

export function calculateVideoCrop(context: PipelineContext): {
  cropTop: number;
  cropBottom: number;
  hasManualCrop: boolean;
  expandFrame: boolean;
} {
  const detection = context.brandingDetection;
  const zones = detection ? [...detection.zones] : [];

  let cropTop = 0;
  let cropBottom = 0;

  // Check system status bar / header / footer edge zones first
  const edgeTopZones = zones.filter(
    (z) =>
      !z.id.startsWith("ai-branding-") &&
      z.boundingBox.y === 0 &&
      z.boundingBox.height <= 0.12,
  );
  const edgeBottomZones = zones.filter(
    (z) =>
      !z.id.startsWith("ai-branding-") &&
      z.boundingBox.y >= 0.88 &&
      z.boundingBox.height <= 0.12,
  );

  if (edgeTopZones.length > 0) {
    cropTop = Math.max(...edgeTopZones.map((z) => z.boundingBox.height));
  }
  if (edgeBottomZones.length > 0) {
    cropBottom = Math.max(
      ...edgeBottomZones.map((z) => z.boundingBox.height),
    );
  }

  let expandFrame = false;
  let hasManualCrop = false;

  if (context.userPrompt) {
    const p = context.userPrompt.toLowerCase();

    // 1. Look for manual crop instructions: "crop top XX%", "crop XX% from top", etc.
    const topMatch = p.match(
      /(?:crop\s+top\s+(\d+)\s*%|crop\s+(\d+)\s*%\s*from\s+top|crop\s+(\d+)\s*%\s*top)/,
    );
    if (topMatch) {
      const percent = parseInt(topMatch[1] || topMatch[2] || topMatch[3], 10);
      if (!isNaN(percent)) {
        cropTop = percent / 100;
        hasManualCrop = true;
      }
    }

    const bottomMatch = p.match(
      /(?:crop\s+bottom\s+(\d+)\s*%|crop\s+(\d+)\s*%\s*from\s+bottom|crop\s+(\d+)\s*%\s*bottom)/,
    );
    if (bottomMatch) {
      const percent = parseInt(
        bottomMatch[1] || bottomMatch[2] || bottomMatch[3],
        10,
      );
      if (!isNaN(percent)) {
        cropBottom = percent / 100;
        hasManualCrop = true;
      }
    }

    // general crop fallback: "crop XX%"
    if (!hasManualCrop) {
      const generalMatch = p.match(/crop\s+(\d+)\s*%/);
      if (generalMatch) {
        const percent = parseInt(generalMatch[1], 10);
        if (!isNaN(percent)) {
          cropTop = percent / 100;
          cropBottom = percent / 100;
          hasManualCrop = true;
        }
      }
    }

    // 2. If no manual crop was specified, check for frame expansion requests
    if (!hasManualCrop) {
      if (
        p.includes("expand") ||
        p.includes("less crop") ||
        p.includes("dont crop") ||
        p.includes("don't crop") ||
        p.includes("no crop") ||
        p.includes("full screen") ||
        p.includes("show all") ||
        p.includes("cropped too much") ||
        p.includes("full caption")
      ) {
        expandFrame = true;
      }
    }
  }

  // For Instagram Reels, enforce a minimum crop of 8% to clear status bars for sides not overridden
  if (context.instagramSource && !expandFrame) {
    const p = context.userPrompt ? context.userPrompt.toLowerCase() : "";
    if (!p.includes("top")) {
      cropTop = Math.max(cropTop, 0.08);
    }
    if (!p.includes("bottom")) {
      cropBottom = Math.max(cropBottom, 0.08);
    }
  }

  // Enforce existing banner top crop to remove profile headers/branding above the banner
  if (context.existingBanner && context.bannerBounds && !expandFrame) {
    const bannerTop = context.bannerBounds.y;
    if (bannerTop > 0) {
      cropTop = Math.max(cropTop, bannerTop);
    }
  }

  // Limit crop to prevent over-cropping (max 35% normally, but up to 45% if manually specified or existing banner is present)
  const maxCrop = (hasManualCrop || context.existingBanner) ? 0.45 : 0.35;
  cropTop = Math.min(cropTop, maxCrop);
  cropBottom = Math.min(cropBottom, maxCrop);

  return { cropTop, cropBottom, hasManualCrop, expandFrame };
}

export class VideoRenderer implements IVideoRenderer {
  // Social handle drawn on the watermark-cover badge (per channel profile)
  private brandHandle: string;
  private brandName: string;

  constructor(
    brandHandle: string = "@codeorcap",
    brandName: string = "CodeOrCap",
  ) {
    this.brandHandle = brandHandle;
    this.brandName = brandName;
  }

  private getVideoDuration(videoPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      exec(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
        (err, stdout) => {
          if (err) return reject(err);
          const d = parseFloat(stdout.trim());
          if (isNaN(d)) return reject(new Error("Could not parse duration"));
          resolve(d);
        },
      );
    });
  }

  private extractFrameAt(
    videoPath: string,
    seconds: number,
    outPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      exec(
        `ffmpeg -y -ss ${seconds.toFixed(2)} -i "${videoPath}" -vframes 1 -q:v 2 "${outPath}"`,
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  // Per-profile diagonal corner watermark asset, generated on first use.
  // The default profile keeps using the legacy assets/watermark.png.
  private async ensureBrandWatermark(): Promise<string> {
    const handleKey = this.brandHandle.replace(/^@/, "").toLowerCase();
    const fileName =
      handleKey === "codeorcap" ? "watermark.png" : `watermark_${handleKey}.png`;
    const wmPath = path.join(config.paths.assetsDir, fileName);
    if (fs.existsSync(wmPath)) return wmPath;

    const svg = `
      <svg width="500" height="500" viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg">
        <style>
          .watermark {
            font-family: 'Helvetica Neue', Arial, sans-serif;
            font-size: 40px;
            font-weight: 900;
            fill: rgba(255, 255, 255, 0.07);
            text-anchor: middle;
          }
        </style>
        <g transform="rotate(-35 250 250)">
          <text x="250" y="230" class="watermark">${this.brandName.toUpperCase()}</text>
          <text x="250" y="280" class="watermark">${this.brandHandle}</text>
        </g>
      </svg>
    `;
    await sharp(Buffer.from(svg)).png().toFile(wmPath);
    pipelineLogger.info(
      `Generated brand watermark asset: ${wmPath}`,
      "VideoRenderer",
    );
    return wmPath;
  }

  public async renderImageToVideo(
    imagePath: string,
    outputPath: string,
    options: RenderOptions,
  ): Promise<string> {
    pipelineLogger.info(
      `Rendering image ${imagePath} to video ${outputPath} (Duration: ${options.durationSeconds}s, FPS: ${options.fps}, Effect: ${options.effect})`,
      "VideoRenderer",
    );

    const duration = options.durationSeconds;
    const fps = options.fps;
    const totalFrames = duration * fps;

    let filterString = "";

    if (options.effect === "zoom") {
      // Cinematic retention-focused animation:
      //
      // Phase 1 (0–0.7s): "Reveal shock" — slam in from 1.3x → 1.0x. The sudden
      //   zoom-out mirrors the "camera crash" opener used in viral Shorts and hooks
      //   the viewer in the first second before they can scroll away.
      //
      // Phase 2 (0.7s–13.5s): Slow Ken Burns — creep from 1.0x → 1.08x with a
      //   gentle figure-8 drift on x/y so the frame never feels static. The drift
      //   uses two sine waves at incommensurate frequencies (period ≠ video length)
      //   so the path looks organic rather than mechanical.
      //
      // Phase 3 (13.5s–end): Hold at 1.08x — no fade-out. Fades signal "video
      //   ending" to viewers who then pre-scroll; a hard hold keeps dwell time up.
      //
      // Color: +25% saturation + slight contrast lift makes yellows and whites pop
      //   on OLED mobile screens.
      //
      // Fade-in: 0.4s to avoid hard cut from Shorts feed thumbnail.

      const p1 = Math.round(fps * 0.7); // frames in phase 1
      const p2 = Math.round(fps * 13.5); // last frame of phase 2
      const T = totalFrames;

      // z expression — zoom level per frame
      const zExpr =
        `if(lte(on,${p1}),` +
        `1.3-0.3*(on-1)/${p1},` + // phase 1: 1.3 → 1.0
        `if(lte(on,${p2}),` +
        `1.0+0.08*(on-${p1})/${p2 - p1},` + // phase 2: 1.0 → 1.08
        `1.08))`; // phase 3: hold

      // x drift: one full sine cycle across the whole video length
      const xExpr =
        `iw/2-(iw/zoom/2)+` + `if(lte(on,${p1}),0,38*sin(3.14159*on/${T}))`;

      // y drift: two cycles (double frequency) for figure-8 feel
      const yExpr =
        `ih/2-(ih/zoom/2)+` + `if(lte(on,${p1}),0,20*sin(6.28318*on/${T}))`;

      filterString =
        `-vf "zoompan=` +
        `z='${zExpr}':` +
        `x='${xExpr}':` +
        `y='${yExpr}':` +
        `d=1:s=1080x1920:fps=${fps},` +
        `eq=saturation=1.25:contrast=1.05,` +
        `fade=t=in:st=0:d=0.4"`;
    } else if (options.effect === "fade") {
      filterString = `-vf "fade=t=in:st=0:d=1,fade=t=out:st=${duration - 1}:d=1"`;
    } else if (options.effect === "slide") {
      filterString = `-vf "crop=1080:1920:0:'min(y+n*0.3, ih-1920)',fade=t=in:st=0:d=1,fade=t=out:st=${duration - 1}:d=1"`;
    } else {
      filterString = "";
    }

    const cmd = `ffmpeg -y -loop 1 -i "${imagePath}" -t ${duration} ${filterString} -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r ${fps} "${outputPath}"`;

    pipelineLogger.info(`Executing FFmpeg command: ${cmd}`, "VideoRenderer");

    return new Promise<string>((resolve, reject) => {
      exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) {
          pipelineLogger.error(
            `FFmpeg video rendering failed: ${stderr}`,
            error,
            "VideoRenderer",
          );
          reject(error);
        } else {
          pipelineLogger.checkpoint(
            "Video rendered",
            true,
            `Output saved to ${outputPath}`,
          );
          resolve(outputPath);
        }
      });
    });
  }

  public async processVideo(
    videoPath: string,
    outputPath: string,
    context: PipelineContext,
    options: RenderOptions,
  ): Promise<string> {
    const framePath = context.originalImagePath;

    pipelineLogger.info(
      `Processing video source: ${videoPath}`,
      "VideoRenderer",
    );

    // 1. Extract a frame from the video at 1.0 seconds (for analysis) if it doesn't exist
    if (!fs.existsSync(framePath)) {
      const extractCmd = `ffmpeg -y -ss 00:00:01 -i "${videoPath}" -vframes 1 -q:v 2 "${framePath}"`;
      await new Promise<void>((resolve, reject) => {
        exec(extractCmd, (err, _stdout, stderr) => {
          if (err) {
            pipelineLogger.warn(
              `Failed to extract frame at 1s, attempting 0s: ${stderr}`,
              "VideoRenderer",
            );
            // Fallback to 0s
            const fallbackCmd = `ffmpeg -y -ss 00:00:00 -i "${videoPath}" -vframes 1 -q:v 2 "${framePath}"`;
            exec(fallbackCmd, (err2, _stdout2, stderr2) => {
              if (err2) {
                reject(new Error(`Failed to extract video frame: ${stderr2}`));
              } else {
                resolve();
              }
            });
          } else {
            resolve();
          }
        });
      });
    }

    // 2. Analyze the frame
    if (!context.analysis) {
      const analyzer = new ImageAnalyzer();
      context.analysis = await analyzer.analyze(framePath);
    }
    const analysis = context.analysis;

    // 3. Run Branding Detection and OCR on the frame
    if (!context.ocr) {
      const ocrService = new OcrService();
      context.ocr = await ocrService.extractText(framePath);
    }

    if (!context.brandingDetection) {
      const detector = new BrandingDetector();
      context.brandingDetection = await detector.detect(
        framePath,
        analysis,
        context.ocr.text,
      );
    } else {
      // If brandingDetection was already set (e.g. by DirectUploader's AI vision),
      // we still want to run the SocialHandleDetector (OCR) to catch any handles
      // that the AI vision might have missed!
      const handleDetector = new SocialHandleDetector();
      const ocrZones = await handleDetector.detect(
        framePath,
        analysis,
        context.ocr.text,
      );

      // Merge unique OCR zones (avoid duplicate IDs)
      const existingIds = new Set(
        context.brandingDetection.zones.map((z) => z.id),
      );
      for (const zone of ocrZones) {
        if (!existingIds.has(zone.id)) {
          context.brandingDetection.zones.push(zone);
          context.brandingDetection.detected = true;
        }
      }
    }
    const detection = context.brandingDetection;
    const zones = detection ? [...detection.zones] : [];

    // Parse manual blur commands from user prompt (e.g., "blur V2-V4 30-60" or "blur 30-60 V2-V4")
    if (context.userPrompt) {
      const p = context.userPrompt.toLowerCase();
      // Match: blur V2-V4 30-60
      const match1 = p.match(/blur\s+v([0-6])\s*(?:to|-)\s*v([0-6])\s*(?:and|,|)?\s*(\d+)\s*(?:to|-)\s*(\d+)/i);
      // Match: blur 30-60 V2-V4
      const match2 = p.match(/blur\s+(\d+)\s*(?:to|-)\s*(\d+)\s*(?:and|,|)?\s*v([0-6])\s*(?:to|-)\s*v([0-6])/i);
      
      let vStart, vEnd, hStart, hEnd;
      if (match1) {
        vStart = parseInt(match1[1], 10);
        vEnd = parseInt(match1[2], 10);
        hStart = parseInt(match1[3], 10);
        hEnd = parseInt(match1[4], 10);
      } else if (match2) {
        hStart = parseInt(match2[1], 10);
        hEnd = parseInt(match2[2], 10);
        vStart = parseInt(match2[3], 10);
        vEnd = parseInt(match2[4], 10);
      }

      if (vStart !== undefined && vEnd !== undefined && hStart !== undefined && hEnd !== undefined) {
        const x0 = Math.min(vStart, vEnd) / 6.0;
        const x1 = Math.max(vStart, vEnd) / 6.0;
        const y0 = Math.min(hStart, hEnd) / 100.0;
        const y1 = Math.max(hStart, hEnd) / 100.0;
        
        zones.push({
          id: `manual-blur-${Date.now()}`,
          type: "watermark", // Treat as watermark to force it through the blurring logic
          boundingBox: { x: x0, y: y0, width: Math.max(x1 - x0, 0.01), height: Math.max(y1 - y0, 0.01) },
          confidence: 1.0,
          description: `Manual blur region V${Math.min(vStart, vEnd)}-V${Math.max(vStart, vEnd)} ${Math.min(hStart, hEnd)}-${Math.max(hStart, hEnd)}`
        });
        pipelineLogger.info(`Added manual blur zone: x=${x0}, y=${y0}, w=${x1-x0}, h=${y1-y0}`, "VideoRenderer");
      }
    }

    // 4. Calculate cropping dynamically using calculateVideoCrop helper
    const { cropTop, cropBottom } = calculateVideoCrop(context);

    let hCropped = 0;
    let wCropped = 0;
    let xCropped = 0;
    let yCropped = 0;
    let hScaled = 1920;
    let yOffset = 0;

    let requireSideCrop = false;
    if (context.userPrompt) {
      const p = context.userPrompt.toLowerCase();
      if (
        p.includes("zoom") ||
        p.includes("fill") ||
        p.includes("fit screen") ||
        p.includes("crop left") ||
        p.includes("crop right") ||
        p.includes("crop width") ||
        p.includes("crop sides") ||
        p.includes("zoom-to-fill")
      ) {
        requireSideCrop = true;
      }
    }

    if (!requireSideCrop) {
      // Keep full width and pad with black bars at the top/bottom to avoid cropping left/right
      hCropped = Math.round(analysis.height * (1 - cropTop - cropBottom));
      if (hCropped % 2 !== 0) hCropped -= 1;

      wCropped = analysis.width;
      if (wCropped % 2 !== 0) wCropped -= 1;

      xCropped = 0;

      yCropped = Math.round(analysis.height * cropTop);
      if (yCropped % 2 !== 0) yCropped -= 1;

      hScaled = Math.round(hCropped * (1080 / wCropped));
      if (hScaled % 2 !== 0) hScaled -= 1;
      if (hScaled > 1920) hScaled = 1920;

      yOffset = Math.round((1920 - hScaled) / 2);
      if (yOffset % 2 !== 0) yOffset -= 1;
      if (yOffset < 0) yOffset = 0;
    } else {
      // To prevent distortion, we crop a 9:16 region centered on the width and scale it to 1080x1920 (zoom-to-fill)
      hCropped = Math.round(analysis.height * (1 - cropTop - cropBottom));
      if (hCropped % 2 !== 0) hCropped -= 1;

      wCropped = Math.round((hCropped * 9) / 16);
      if (wCropped % 2 !== 0) wCropped -= 1;

      xCropped = Math.round((analysis.width - wCropped) / 2);
      if (xCropped % 2 !== 0) xCropped -= 1;
      if (xCropped < 0) xCropped = 0;

      yCropped = Math.round(analysis.height * cropTop);
      if (yCropped % 2 !== 0) yCropped -= 1;

      hScaled = 1920;
      yOffset = 0;
    }

    pipelineLogger.info(
      `Dynamic AI Video cropping: original=${analysis.width}x${analysis.height}, cropBounds=[w=${wCropped}, h=${hCropped}, x=${xCropped}, y=${yCropped}], hScaled=${hScaled}, yOffset=${yOffset}, cropTop=${cropTop.toFixed(3)}, cropBottom=${cropBottom.toFixed(3)}`,
      "VideoRenderer",
    );

    const blurRegions: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      from?: number;
      to?: number;
    }> = [];

    // Zones with optional time windows. Snapchat's baked-in watermark ANIMATES
    // (top-left at the start → bottom-right at the end), so a single-frame
    // detection misses it later in the video. For Snapchat sources we sample
    // extra frames (middle + end), detect zones on each, and time-gate every
    // cover badge to the segment its sample frame belongs to.
    let timedZones: Array<{ zone: BrandingZone; from?: number; to?: number }> =
      zones.map((z) => ({ zone: z }));

    if (context.sourcePlatform === "snapchat") {
      try {
        const duration = await this.getVideoDuration(videoPath);
        if (duration > 3) {
          const seg = duration / 3;
          // Start-frame detections only cover the first third
          timedZones = zones.map((z) => ({ zone: z, from: 0, to: seg }));

          const detector = new BrandingDetector();
          const samples = [
            { t: duration / 2, from: seg, to: 2 * seg, label: "mid" },
            {
              t: Math.max(duration - 1.2, 0),
              from: 2 * seg,
              to: duration + 1,
              label: "end",
            },
          ];
          for (const s of samples) {
            const sampleFrame = path.join(
              path.dirname(outputPath),
              `wm_sample_${s.label}.jpg`,
            );
            await this.extractFrameAt(videoPath, s.t, sampleFrame);
            const det = await detector.detect(sampleFrame, analysis);
            for (const z of det.zones) {
              timedZones.push({
                zone: { ...z, id: `${z.id}-${s.label}` },
                from: s.from,
                to: s.to,
              });
            }
            pipelineLogger.info(
              `Snapchat watermark sample @${s.t.toFixed(1)}s (${s.label}): ${det.zones.length} zones`,
              "VideoRenderer",
            );
          }
        }
      } catch (err) {
        pipelineLogger.warn(
          `Snapchat multi-frame watermark sampling failed: ${err instanceof Error ? err.message : err}`,
          "VideoRenderer",
        );
      }
    }

    // Process other branding zones to cover
    const middleWatermarks = timedZones.filter(({ zone: z }) => {
      if (!z.id.startsWith("ai-branding-") && !z.id.startsWith("ocr-"))
        return false;
      if (
        z.type === "main_post_content" ||
        (z.type as string) === "original_captions"
      )
        return false;
      const box = z.boundingBox;

      const xRel = box.x * analysis.width;
      const yRel = box.y * analysis.height;
      const wRel = box.width * analysis.width;
      const hRel = box.height * analysis.height;

      // Check if it's inside the cropped region
      const insideX = xRel + wRel > xCropped && xRel < xCropped + wCropped;
      const insideY = yRel + hRel > yCropped && yRel < yCropped + hCropped;

      return insideX && insideY;
    });

    for (const { zone: z, from, to } of middleWatermarks) {
      const origX = z.boundingBox.x * analysis.width;
      const origY = z.boundingBox.y * analysis.height;
      const origW = z.boundingBox.width * analysis.width;
      const origH = z.boundingBox.height * analysis.height;

      const cropX = origX - xCropped;
      const cropY = origY - yCropped;

      const safeX = Math.max(0, Math.min(wCropped - 10, cropX));
      const safeY = Math.max(0, Math.min(hCropped - 10, cropY));
      const safeW = Math.max(10, Math.min(wCropped - safeX, origW));
      const safeH = Math.max(10, Math.min(hCropped - safeY, origH));

      blurRegions.push({ x: safeX, y: safeY, width: safeW, height: safeH, from, to });
    }

    pipelineLogger.info(
      `Total blur regions prepared: ${blurRegions.length}`,
      "VideoRenderer",
    );

    // 6. Build FFmpeg filter complex for cropping, scaling, and blurring regions
    let filterChain = "";
    if (!requireSideCrop) {
      filterChain = `[0:v]crop=${wCropped}:${hCropped}:${xCropped}:${yCropped},scale=1080:${hScaled},pad=1080:1920:0:${yOffset}:black[scaled]`;
    } else {
      filterChain = `[0:v]crop=${wCropped}:${hCropped}:${xCropped}:${yCropped},scale=1080:1920[scaled]`;
    }

    let currentLabel = "scaled";
    const badgeInputPaths: string[] = [];
    for (let i = 0; i < blurRegions.length; i++) {
      const region = blurRegions[i];

      // Add padding around the detected text zone to ensure full coverage of text edges and symbols.
      // We expand the horizontal padding to 15px to ensure OCR-shifted '@' symbols are fully covered.
      const paddingX = 15;
      const paddingY = 5;

      const X_px = Math.round(region.x * (1080 / wCropped)) - paddingX;
      const Y_px =
        Math.round(region.y * (hScaled / hCropped)) + yOffset - paddingY;
      const W_px = Math.round(region.width * (1080 / wCropped)) + paddingX * 2;
      const H_px =
        Math.round(region.height * (hScaled / hCropped)) + paddingY * 2;

      let safeW = Math.max(40, Math.min(1080, W_px));
      let safeH = Math.max(20, Math.min(1920, H_px));

      // Enforce even dimensions to prevent YUV420p size mismatches
      if (safeW % 2 !== 0) safeW = safeW + 1 > 1080 ? safeW - 1 : safeW + 1;
      if (safeH % 2 !== 0) safeH = safeH + 1 > 1920 ? safeH - 1 : safeH + 1;

      let safeX = Math.max(0, Math.min(1080 - safeW, X_px));
      let safeY = Math.max(0, Math.min(1920 - safeH, Y_px));

      // Enforce even offsets to prevent alignment issues in overlay
      if (safeX % 2 !== 0) safeX = Math.max(0, safeX - 1);
      if (safeY % 2 !== 0) safeY = Math.max(0, safeY - 1);

      // Instead of blurring, cover the watermark with a brand badge:
      // dark rounded pill (#0B0B0B) with yellow (#FFB800) border and the channel handle
      const label = this.brandHandle;
      const fontSize = Math.floor(
        Math.min(safeH * 0.6, (safeW * 0.85) / (label.length * 0.62)),
      );
      const rx = Math.min(safeH / 2, 14);
      const textY = Math.round(safeH / 2 + fontSize * 0.35);
      const badgeSvg = `<svg width="${safeW}" height="${safeH}" viewBox="0 0 ${safeW} ${safeH}" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1" width="${safeW - 2}" height="${safeH - 2}" rx="${rx}" fill="#0B0B0B" fill-opacity="0.95" stroke="#FFB800" stroke-width="1.5" stroke-opacity="0.85"/>
        <text x="${safeW / 2}" y="${textY}" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif" font-size="${fontSize}" font-weight="800" fill="#FFB800" text-anchor="middle" letter-spacing="0.5">${label}</text>
      </svg>`;

      const badgePath = path.join(
        path.dirname(outputPath),
        `brand_badge_${i}.png`,
      );
      await sharp(Buffer.from(badgeSvg)).png().toFile(badgePath);
      badgeInputPaths.push(badgePath);

      const nextLabel = `brand_${i}`;
      // Badge inputs start at ffmpeg input index 1 (0 is the video).
      // Time-gated regions (e.g. Snapchat's animated watermark) only show
      // their badge during the segment where the watermark was detected.
      const enable =
        region.from !== undefined && region.to !== undefined
          ? `:enable='between(t,${region.from.toFixed(2)},${region.to.toFixed(2)})'`
          : "";
      filterChain += `; [${currentLabel}][${i + 1}:v]overlay=${safeX}:${safeY}${enable}[${nextLabel}]`;
      currentLabel = nextLabel;
    }

    // 7. Brand watermark asset (per channel profile, generated on first use)
    let watermarkPath = "";
    try {
      watermarkPath = await this.ensureBrandWatermark();
    } catch (err) {
      pipelineLogger.warn(
        `Brand watermark generation failed: ${err instanceof Error ? err.message : err}`,
        "VideoRenderer",
      );
    }
    const hasWatermark = watermarkPath !== "" && fs.existsSync(watermarkPath);

    // 8. Execute FFmpeg
    const fps = options.fps;
    const badgeInputArgs = badgeInputPaths
      .map((p) => `-i "${p}"`)
      .join(" ");
    const watermarkInputIndex = 1 + badgeInputPaths.length;
    let finalCmd = "";
    if (hasWatermark) {
      finalCmd = `ffmpeg -y -i "${videoPath}" ${badgeInputArgs} -i "${watermarkPath}" -filter_complex "${filterChain}; [${currentLabel}][${watermarkInputIndex}:v]overlay=W-w-40:H-h-40[out]" -map "[out]" -map 0:a? -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r ${fps} -c:a copy "${outputPath}"`;
    } else {
      finalCmd = `ffmpeg -y -i "${videoPath}" ${badgeInputArgs} -filter_complex "${filterChain}" -map "[${currentLabel}]" -map 0:a? -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r ${fps} -c:a copy "${outputPath}"`;
    }

    pipelineLogger.info(
      `Executing FFmpeg video processing command: ${finalCmd}`,
      "VideoRenderer",
    );

    return new Promise<string>((resolve, reject) => {
      exec(
        finalCmd,
        { maxBuffer: 20 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error) {
            pipelineLogger.error(
              `FFmpeg video processing failed: ${stderr}`,
              error,
              "VideoRenderer",
            );
            reject(error);
          } else {
            pipelineLogger.checkpoint(
              "Video processing complete",
              true,
              `Output saved to ${outputPath}`,
            );
            resolve(outputPath);
          }
        },
      );
    });
  }
}
