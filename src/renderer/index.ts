import { exec } from 'child_process';
import { IVideoRenderer, RenderOptions } from '../types';
import { pipelineLogger } from '../utils/logger';

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

    const cmd = `ffmpeg -y -loop 1 -i "${imagePath}" -t ${duration} ${filterString} -c:v libx264 -pix_fmt yuv420p -r ${fps} "${outputPath}"`;

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
}
