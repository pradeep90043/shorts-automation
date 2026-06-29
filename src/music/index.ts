import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { IMusicService } from '../types';
import { config } from '../config';
import { pipelineLogger } from '../utils/logger';

export class MusicService implements IMusicService {
  public async addBackgroundMusic(
    videoPath: string,
    musicFolder: string,
    outputPath: string
  ): Promise<string> {
    pipelineLogger.info(`Adding background music to video ${videoPath}`, 'MusicService');

    try {
      // 1. Find all available music tracks
      let audioTracks: string[] = [];
      
      if (fs.existsSync(musicFolder)) {
        audioTracks = fs.readdirSync(musicFolder)
          .filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.mp3', '.wav', '.m4a', '.aac', '.ogg'].includes(ext);
          })
          .map(file => path.join(musicFolder, file));
      }

      let selectedTrack = '';

      if (audioTracks.length > 0) {
        // Randomly pick a track
        const randomIndex = Math.floor(Math.random() * audioTracks.length);
        selectedTrack = audioTracks[randomIndex];
        pipelineLogger.info(`Randomly selected background track: ${path.basename(selectedTrack)}`, 'MusicService');
      } else {
        // Fallback to our synthesized default track in the assets directory
        const defaultTrackPath = path.join(config.paths.assetsDir, 'ambient_synth.aac');
        if (fs.existsSync(defaultTrackPath)) {
          selectedTrack = defaultTrackPath;
          pipelineLogger.warn(`No tracks found in music folder. Falling back to default synthesized track: ${defaultTrackPath}`, 'MusicService');
        } else {
          throw new Error(`No audio tracks available in ${musicFolder} and no default synthesized track exists.`);
        }
      }

      // 2. Fetch video duration to calculate fade-out timing
      const duration = config.rendering.videoDurationSeconds;
      const fadeDuration = 1.5; // seconds
      const fadeOutStart = duration - fadeDuration;
      const volume = config.rendering.musicVolume;
      const startOffset = config.rendering.musicStartOffset;

      // 3. Construct FFmpeg command
      // -ss before -i audio: fast input seek — skips the intro, lands on the drop
      // -map 0:v / -map [a]: video from file 0, processed audio from filter
      // -c:v copy: no re-encode of video frames
      // -shortest: trim to video length
      const cmd = `ffmpeg -y -i "${videoPath}" -ss ${startOffset} -i "${selectedTrack}" -filter_complex "[1:a]volume=${volume},afade=t=in:ss=0:d=${fadeDuration},afade=t=out:st=${fadeOutStart}:d=${fadeDuration}[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${outputPath}"`;

      pipelineLogger.info(`Executing FFmpeg audio mixing command: ${cmd}`, 'MusicService');

      return new Promise<string>((resolve, reject) => {
        exec(cmd, (error, _stdout, stderr) => {
          if (error) {
            pipelineLogger.error(`FFmpeg audio overlay failed: ${stderr}`, error, 'MusicService');
            reject(error);
          } else {
            pipelineLogger.checkpoint('Background music added', true, `Merged ${path.basename(selectedTrack)} into ${outputPath}`);
            resolve(outputPath);
          }
        });
      });

    } catch (err) {
      pipelineLogger.error(`Failed to overlay music on video`, err, 'MusicService');
      throw err;
    }
  }
}
