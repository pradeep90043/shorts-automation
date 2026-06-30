import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { IVideoRenderer, RenderOptions, PipelineContext } from '../types';
import { pipelineLogger } from '../utils/logger';
import { config } from '../config';
import { ImageAnalyzer } from '../image-analysis';
import { BrandingDetector } from '../branding-detector';
import { OcrService } from '../ocr';

export class VideoRenderer implements IVideoRenderer {
  public async renderImageToVideo(
    imagePath: string,
    outputPath: string,
    options: RenderOptions
  ): Promise<string> {
    pipelineLogger.info(
      `Rendering image ${imagePath} to video ${outputPath} (Duration: ${options.durationSeconds}s, FPS: ${options.fps}, Effect: ${options.effect})`,
      'VideoRenderer'
    );

    const duration = options.durationSeconds;
    const fps = options.fps;
    const totalFrames = duration * fps;

    let filterString = '';

    if (options.effect === 'zoom') {
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

      const p1 = Math.round(fps * 0.7);          // frames in phase 1
      const p2 = Math.round(fps * 13.5);          // last frame of phase 2
      const T  = totalFrames;

      // z expression — zoom level per frame
      const zExpr =
        `if(lte(on,${p1}),` +
          `1.3-0.3*(on-1)/${p1},` +           // phase 1: 1.3 → 1.0
          `if(lte(on,${p2}),` +
            `1.0+0.08*(on-${p1})/${p2 - p1},`+ // phase 2: 1.0 → 1.08
            `1.08))`;                            // phase 3: hold

      // x drift: one full sine cycle across the whole video length
      const xExpr =
        `iw/2-(iw/zoom/2)+` +
        `if(lte(on,${p1}),0,38*sin(3.14159*on/${T}))`;

      // y drift: two cycles (double frequency) for figure-8 feel
      const yExpr =
        `ih/2-(ih/zoom/2)+` +
        `if(lte(on,${p1}),0,20*sin(6.28318*on/${T}))`;

      filterString =
        `-vf "zoompan=` +
          `z='${zExpr}':` +
          `x='${xExpr}':` +
          `y='${yExpr}':` +
          `d=1:s=1080x1920:fps=${fps},` +
        `eq=saturation=1.25:contrast=1.05,` +
        `fade=t=in:st=0:d=0.4"`;

    } else if (options.effect === 'fade') {
      filterString = `-vf "fade=t=in:st=0:d=1,fade=t=out:st=${duration - 1}:d=1"`;

    } else if (options.effect === 'slide') {
      filterString = `-vf "crop=1080:1920:0:'min(y+n*0.3, ih-1920)',fade=t=in:st=0:d=1,fade=t=out:st=${duration - 1}:d=1"`;

    } else {
      filterString = '';
    }

    const cmd = `ffmpeg -y -loop 1 -i "${imagePath}" -t ${duration} ${filterString} -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r ${fps} "${outputPath}"`;

    pipelineLogger.info(`Executing FFmpeg command: ${cmd}`, 'VideoRenderer');

    return new Promise<string>((resolve, reject) => {
      exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) {
          pipelineLogger.error(`FFmpeg video rendering failed: ${stderr}`, error, 'VideoRenderer');
          reject(error);
        } else {
          pipelineLogger.checkpoint('Video rendered', true, `Output saved to ${outputPath}`);
          resolve(outputPath);
        }
      });
    });
  }

  public async processVideo(
    videoPath: string,
    outputPath: string,
    context: PipelineContext,
    options: RenderOptions
  ): Promise<string> {
    const framePath = context.originalImagePath;

    pipelineLogger.info(`Processing video source: ${videoPath}`, 'VideoRenderer');

    // 1. Extract a frame from the video at 1.0 seconds (for analysis) if it doesn't exist
    if (!fs.existsSync(framePath)) {
      const extractCmd = `ffmpeg -y -ss 00:00:01 -i "${videoPath}" -vframes 1 -q:v 2 "${framePath}"`;
      await new Promise<void>((resolve, reject) => {
        exec(extractCmd, (err, _stdout, stderr) => {
          if (err) {
            pipelineLogger.warn(`Failed to extract frame at 1s, attempting 0s: ${stderr}`, 'VideoRenderer');
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
    if (!context.brandingDetection) {
      const detector = new BrandingDetector();
      context.brandingDetection = await detector.detect(framePath, analysis);
    }
    const detection = context.brandingDetection;

    if (!context.ocr) {
      const ocrService = new OcrService();
      context.ocr = await ocrService.extractText(framePath);
    }

    // 4. Calculate cropping dynamically based on AI detected zones to crop out edge watermarks/profiles completely
    const zones = [...detection.zones];
    
    let hCropped = 0;
    let wCropped = 0;
    let xCropped = 0;
    let yCropped = 0;

    let cropTop = 0;
    let cropBottom = 0;

    // Check system status bar / header / footer edge zones first
    const edgeTopZones = zones.filter(z => !z.id.startsWith('ai-branding-') && z.boundingBox.y === 0 && z.boundingBox.height <= 0.12);
    const edgeBottomZones = zones.filter(z => !z.id.startsWith('ai-branding-') && z.boundingBox.y >= 0.88 && z.boundingBox.height <= 0.12);
    
    if (edgeTopZones.length > 0) {
      cropTop = Math.max(...edgeTopZones.map(z => z.boundingBox.height));
    }
    if (edgeBottomZones.length > 0) {
      cropBottom = Math.max(...edgeBottomZones.map(z => z.boundingBox.height));
    }

    // Process AI-detected branding zones: instead of over-cropping the video, 
    // we keep the crops minimal (status bars only) and blur the watermark/handle zones.
    // So we do not expand cropTop/cropBottom based on aiZones here.

    // For Instagram Reels, enforce a minimum crop of 8% to clear status bars even if AI missed them
    if (context.instagramSource) {
      cropTop = Math.max(cropTop, 0.08);
      cropBottom = Math.max(cropBottom, 0.08);
    }

    // Limit crop to prevent over-cropping (max 35% from top or bottom)
    cropTop = Math.min(cropTop, 0.35);
    cropBottom = Math.min(cropBottom, 0.35);

    // To prevent distortion, we crop a 9:16 region centered on the width and scale it to 1080x1920
    hCropped = Math.round(analysis.height * (1 - cropTop - cropBottom));
    if (hCropped % 2 !== 0) hCropped -= 1;

    wCropped = Math.round(hCropped * 9 / 16);
    if (wCropped % 2 !== 0) wCropped -= 1;

    xCropped = Math.round((analysis.width - wCropped) / 2);
    if (xCropped % 2 !== 0) xCropped -= 1;
    if (xCropped < 0) xCropped = 0;

    yCropped = Math.round(analysis.height * cropTop);
    if (yCropped % 2 !== 0) yCropped -= 1;

    pipelineLogger.info(
      `Dynamic AI Video cropping: original=${analysis.width}x${analysis.height}, cropBounds=[w=${wCropped}, h=${hCropped}, x=${xCropped}, y=${yCropped}], cropTop=${cropTop.toFixed(3)}, cropBottom=${cropBottom.toFixed(3)}`,
      'VideoRenderer'
    );

    const blurRegions: Array<{ x: number; y: number; width: number; height: number }> = [];

    // Process other branding zones to blur
    const middleWatermarks = zones.filter(z => {
      if (!z.id.startsWith('ai-branding-')) return false;
      if (z.type === 'main_post_content') return false;
      const box = z.boundingBox;

      const xRel = box.x * analysis.width;
      const yRel = box.y * analysis.height;
      const wRel = box.width * analysis.width;
      const hRel = box.height * analysis.height;

      // Check if it's inside the cropped region
      const insideX = (xRel + wRel) > xCropped && xRel < (xCropped + wCropped);
      const insideY = (yRel + hRel) > yCropped && yRel < (yCropped + hCropped);

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

    pipelineLogger.info(`Total blur regions prepared: ${blurRegions.length}`, 'VideoRenderer');

    // 6. Build FFmpeg filter complex for cropping, scaling, and blurring regions
    let filterChain = `[0:v]crop=${wCropped}:${hCropped}:${xCropped}:${yCropped},scale=1080:1920[scaled]`;
    
    let currentLabel = 'scaled';
    for (let i = 0; i < blurRegions.length; i++) {
      const region = blurRegions[i];
      
      const X_px = Math.round(region.x * (1080 / wCropped));
      const Y_px = Math.round(region.y * (1920 / hCropped));
      const W_px = Math.round(region.width * (1080 / wCropped));
      const H_px = Math.round(region.height * (1920 / hCropped));

      const safeX = Math.max(0, Math.min(1080 - W_px, X_px));
      const safeY = Math.max(0, Math.min(1920 - H_px, Y_px));
      const safeW = Math.max(10, Math.min(1080, W_px));
      const safeH = Math.max(10, Math.min(1920, H_px));
      
      // Calculate a safe blur radius to prevent FFmpeg failures (radius must not exceed min(safeW, safeH) / 4)
      const safeRadius = Math.max(1, Math.min(15, Math.floor(safeW / 4), Math.floor(safeH / 4)));
      
      const nextLabel = `blur_${i}`;
      filterChain += `; [${currentLabel}]split[v1_${i}][v2_${i}]; [v2_${i}]crop=${safeW}:${safeH}:${safeX}:${safeY},boxblur=luma_radius=${safeRadius}:luma_power=3[blurred_${i}]; [v1_${i}][blurred_${i}]overlay=${safeX}:${safeY}[${nextLabel}]`;
      currentLabel = nextLabel;
    }

    // 7. Define watermark path
    const watermarkPath = path.join(config.paths.assetsDir, 'watermark.png');
    const hasWatermark = fs.existsSync(watermarkPath);

    // 8. Execute FFmpeg
    const fps = options.fps;
    let finalCmd = '';
    if (hasWatermark) {
      finalCmd = `ffmpeg -y -i "${videoPath}" -i "${watermarkPath}" -filter_complex "${filterChain}; [${currentLabel}][1:v]overlay=(W-w)/2:(H-h)/2[out]" -map "[out]" -map 0:a? -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r ${fps} -c:a copy "${outputPath}"`;
    } else {
      finalCmd = `ffmpeg -y -i "${videoPath}" -filter_complex "${filterChain}" -map "[${currentLabel}]" -map 0:a? -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r ${fps} -c:a copy "${outputPath}"`;
    }
    
    pipelineLogger.info(`Executing FFmpeg video processing command: ${finalCmd}`, 'VideoRenderer');

    return new Promise<string>((resolve, reject) => {
      exec(finalCmd, { maxBuffer: 20 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) {
          pipelineLogger.error(`FFmpeg video processing failed: ${stderr}`, error, 'VideoRenderer');
          reject(error);
        } else {
          pipelineLogger.checkpoint('Video processing complete', true, `Output saved to ${outputPath}`);
          resolve(outputPath);
        }
      });
    });
  }
}
