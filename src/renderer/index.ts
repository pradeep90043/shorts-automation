import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { IVideoRenderer, RenderOptions, PipelineContext } from "../types";
import { pipelineLogger } from "../utils/logger";
import { config } from "../config";
import { ImageAnalyzer } from "../image-analysis";
import { BrandingDetector, SocialHandleDetector } from "../branding-detector";
import { OcrService } from "../ocr";

export class VideoRenderer implements IVideoRenderer {
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

    // 4. Calculate cropping dynamically based on AI detected zones to crop out edge watermarks/profiles completely
    const zones = [...detection.zones];

    let hCropped = 0;
    let wCropped = 0;
    let xCropped = 0;
    let yCropped = 0;
    let hScaled = 1920;
    let yOffset = 0;

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

    // Process AI-detected branding zones: instead of over-cropping the video,
    // we keep the crops minimal (status bars only) and blur the watermark/handle zones.
    // So we do not expand cropTop/cropBottom based on aiZones here.

    // Check if the user prompt requests manual cropping or frame expansion
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
          pipelineLogger.info(
            `Parsed manual cropTop from prompt: ${cropTop}`,
            "VideoRenderer",
          );
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
          pipelineLogger.info(
            `Parsed manual cropBottom from prompt: ${cropBottom}`,
            "VideoRenderer",
          );
        }
      }

      // general crop fallback: "crop XX%"
      if (!topMatch && !bottomMatch) {
        const generalMatch = p.match(/crop\s+(\d+)\s*%/);
        if (generalMatch) {
          const percent = parseInt(generalMatch[1], 10);
          if (!isNaN(percent)) {
            cropTop = percent / 100;
            cropBottom = percent / 100;
            hasManualCrop = true;
            pipelineLogger.info(
              `Parsed general manual crop from prompt: ${percent}%`,
              "VideoRenderer",
            );
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
          pipelineLogger.info(
            "User prompt requests frame expansion/less cropping. Disabling minimum crop constraints.",
            "VideoRenderer",
          );
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

    // Limit crop to prevent over-cropping (max 35% normally, but up to 45% if manually specified)
    const maxCrop = hasManualCrop ? 0.45 : 0.35;
    cropTop = Math.min(cropTop, maxCrop);
    cropBottom = Math.min(cropBottom, maxCrop);

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
    }> = [];

    // Process other branding zones to blur
    const middleWatermarks = zones.filter((z) => {
      if (!z.id.startsWith("ai-branding-") && !z.id.startsWith("ocr-"))
        return false;
      if (z.type === "main_post_content") return false;
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

    for (const z of middleWatermarks) {
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

      blurRegions.push({ x: safeX, y: safeY, width: safeW, height: safeH });
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

      let safeW = Math.max(10, Math.min(1080, W_px));
      let safeH = Math.max(10, Math.min(1920, H_px));

      // Enforce even dimensions to prevent YUV420p size mismatches in alphamerge
      if (safeW % 2 !== 0) safeW = safeW + 1 > 1080 ? safeW - 1 : safeW + 1;
      if (safeH % 2 !== 0) safeH = safeH + 1 > 1920 ? safeH - 1 : safeH + 1;

      let safeX = Math.max(0, Math.min(1080 - safeW, X_px));
      let safeY = Math.max(0, Math.min(1920 - safeH, Y_px));

      // Enforce even offsets to prevent alignment issues in crop/overlay
      if (safeX % 2 !== 0) safeX = Math.max(0, safeX - 1);
      if (safeY % 2 !== 0) safeY = Math.max(0, safeY - 1);

      // By applying a stronger Gaussian blur ( sigma=50 ) through a smoothly feathered alpha mask, the watermark is completely hidden
      const marginX = Math.max(2, Math.floor(safeW * 0.1));
      const marginY = Math.max(2, Math.floor(safeH * 0.1));
      const maskW = safeW - 2 * marginX;
      const maskH = safeH - 2 * marginY;

      const nextLabel = `blur_${i}`;
      filterChain += `; [${currentLabel}]split[v1_${i}][v2_${i}]; [v2_${i}]crop=${safeW}:${safeH}:${safeX}:${safeY},split[blurred_${i}][mask_src_${i}]; [blurred_${i}]gblur=sigma=50[blurred_out_${i}]; [mask_src_${i}]format=rgba,drawbox=x=0:y=0:w=iw:h=ih:color=black@0:t=fill,drawbox=x=${marginX}:y=${marginY}:w=${maskW}:h=${maskH}:color=white:t=fill,gblur=sigma=10[mask_${i}]; [blurred_out_${i}][mask_${i}]alphamerge[masked_${i}]; [v1_${i}][masked_${i}]overlay=${safeX}:${safeY}[${nextLabel}]`;
      currentLabel = nextLabel;
    }

    // 7. Define watermark path
    const watermarkPath = path.join(config.paths.assetsDir, "watermark.png");
    const hasWatermark = fs.existsSync(watermarkPath);

    // 8. Execute FFmpeg
    const fps = options.fps;
    let finalCmd = "";
    if (hasWatermark) {
      finalCmd = `ffmpeg -y -i "${videoPath}" -i "${watermarkPath}" -filter_complex "${filterChain}; [${currentLabel}][1:v]overlay=(W-w)/2:(H-h)/2[out]" -map "[out]" -map 0:a? -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r ${fps} -c:a copy "${outputPath}"`;
    } else {
      finalCmd = `ffmpeg -y -i "${videoPath}" -filter_complex "${filterChain}" -map "[${currentLabel}]" -map 0:a? -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r ${fps} -c:a copy "${outputPath}"`;
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
