import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { IMusicService } from "../types";
import { getTrackForEmotion, downloadAudio } from "../audio/emotionAudio";
import type { Emotion } from "../audio/emotionAudio";
import { extractVocals } from "../audio/vocalExtractor";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";

export class MusicService implements IMusicService {
  public async addBackgroundMusic(
    videoPath: string,
    musicFolder: string,
    outputPath: string,
    mood?: "funny" | "sad" | "other",
    emotion?: Emotion,
    forceReplace: boolean = false,
  ): Promise<string> {
    pipelineLogger.info(
      `Adding background music to video ${videoPath} (Mood: ${mood || "unspecified"})`,
      "MusicService",
    );

    try {
      let selectedTrack = "";
      const targetEmotion: Emotion = emotion || (mood as Emotion) || 'energetic';
      const freeTrack = getTrackForEmotion(targetEmotion);

      try {
        pipelineLogger.info(
          `Fetching music from YouTube: ${freeTrack.title} (${freeTrack.videoId})`,
          'MusicService',
        );
        selectedTrack = await downloadAudio(freeTrack);
      } catch (downloadErr) {
        pipelineLogger.warn(
          `Failed to download YouTube track. Falling back to local music. Error: ${downloadErr instanceof Error ? downloadErr.message : downloadErr}`,
          'MusicService',
        );

        // Fallback to local files
        let audioTracks: string[] = [];
        const foldersToTry = [musicFolder];

        if (mood && ["funny", "sad", "other"].includes(mood)) {
          foldersToTry.unshift(path.join(musicFolder, mood));
          if (mood !== "other") {
            foldersToTry.push(path.join(musicFolder, "other"));
          }
        } else {
          foldersToTry.unshift(path.join(musicFolder, "other"));
        }

        for (const folder of foldersToTry) {
          if (fs.existsSync(folder)) {
            const files = fs
              .readdirSync(folder)
              .filter((file) => {
                const ext = path.extname(file).toLowerCase();
                return [".mp3", ".wav", ".m4a", ".aac", ".ogg"].includes(ext);
              })
              .map((file) => path.join(folder, file));

            if (files.length > 0) {
              audioTracks = files;
              pipelineLogger.info(
                `Found ${files.length} tracks in folder: ${folder}`,
                "MusicService",
              );
              break;
            }
          }
        }

        if (audioTracks.length > 0) {
          const randomIndex = Math.floor(Math.random() * audioTracks.length);
          selectedTrack = audioTracks[randomIndex];
          pipelineLogger.info(
            `Randomly selected background track from local files: ${path.basename(selectedTrack)}`,
            "MusicService",
          );
        } else {
          throw new Error("No local or YouTube music available.");
        }
      }

      // Helper functions to get video details
      // Helper to fetch video duration (same as before)
const getVideoDuration = (pathStr: string): Promise<number> => {
        return new Promise((resolve) => {
          const ffprobeBin = config.binaries.ffprobe;
          const durationCmd = `"${ffprobeBin}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${pathStr}"`;
          exec(durationCmd, (error, stdout) => {
            if (error || !stdout.trim()) {
              resolve(config.rendering.videoDurationSeconds);
            } else {
              const val = parseFloat(stdout.trim());
              resolve(isNaN(val) ? config.rendering.videoDurationSeconds : val);
            }
          });
        });
      };

      const hasAudioStream = (pathStr: string): Promise<boolean> => {
        return new Promise((resolve) => {
          const ffprobeBin = config.binaries.ffprobe;
          const audioCmd = `"${ffprobeBin}" -v error -select_streams a -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${pathStr}"`;
          exec(audioCmd, (error, stdout) => {
            if (error || !stdout.trim()) {
              resolve(false);
            } else {
              resolve(stdout.trim() === "audio");
            }
          });
        });
      };

      // 2. Fetch video duration and audio presence
      const duration = await getVideoDuration(videoPath);
      const hasAudio = await hasAudioStream(videoPath);

      let vocalOnlyPath: string | null = null;
      if (hasAudio) {
        if (!forceReplace) {
          pipelineLogger.info(
            `Video already has audio and forceReplace is false. Keeping original audio.`,
            "MusicService"
          );
          fs.copyFileSync(videoPath, outputPath);
          return outputPath;
        }
        const tempDir = path.dirname(outputPath);
        vocalOnlyPath = await extractVocals(videoPath, tempDir);
      }

      const fadeDuration = 1.5; // seconds
      const fadeOutStart = duration - fadeDuration;
      const volume = config.rendering.musicVolume;
      const startOffset = config.rendering.musicStartOffset;

      let filterComplex = "";
      let cmd = "";

      if (forceReplace || !hasAudio) {
        filterComplex = `[1:a]volume=${volume},afade=t=in:ss=0:d=${fadeDuration},afade=t=out:st=${fadeOutStart}:d=${fadeDuration}[a]`;
        cmd = `ffmpeg -y -i "${videoPath}" -ss ${startOffset} -i "${selectedTrack}" -filter_complex "${filterComplex}" -map 0:v -map "[a]" -vcodec libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -shortest "${outputPath}"`;
      } else if (vocalOnlyPath) {
        // [0:v] video, [1:a] bg music, [2:a] vocals
        filterComplex =
          `[1:a]volume=${volume},afade=t=in:ss=0:d=${fadeDuration},afade=t=out:st=${fadeOutStart}:d=${fadeDuration}[bg];` +
          `[bg][2:a]sidechaincompress=threshold=0.08:ratio=12:attack=20:release=350[bg_ducked];` +
          `[2:a][bg_ducked]amix=inputs=2:duration=first:dropout_transition=2[a]`;
        
        cmd = `ffmpeg -y -i "${videoPath}" -ss ${startOffset} -i "${selectedTrack}" -i "${vocalOnlyPath}" -filter_complex "${filterComplex}" -map 0:v -map "[a]" -vcodec libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -shortest "${outputPath}"`;
      } else if (hasAudio) {
        // Apply sidechain compression to automatically duck background music when voiceover speech is detected
        filterComplex =
          `[1:a]volume=${volume},afade=t=in:ss=0:d=${fadeDuration},afade=t=out:st=${fadeOutStart}:d=${fadeDuration}[bg];` +
          `[bg][0:a]sidechaincompress=threshold=0.08:ratio=12:attack=20:release=350[bg_ducked];` +
          `[0:a][bg_ducked]amix=inputs=2:duration=first:dropout_transition=2[a]`;
        
        cmd = `ffmpeg -y -i "${videoPath}" -ss ${startOffset} -i "${selectedTrack}" -filter_complex "${filterComplex}" -map 0:v -map "[a]" -vcodec libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -shortest "${outputPath}"`;
      } else {
        filterComplex = `[1:a]volume=${volume},afade=t=in:ss=0:d=${fadeDuration},afade=t=out:st=${fadeOutStart}:d=${fadeDuration}[a]`;
        cmd = `ffmpeg -y -i "${videoPath}" -ss ${startOffset} -i "${selectedTrack}" -filter_complex "${filterComplex}" -map 0:v -map "[a]" -vcodec libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -shortest "${outputPath}"`;
      }

      pipelineLogger.info(
        `Executing FFmpeg audio mixing command: ${cmd}`,
        "MusicService",
      );

      return new Promise<string>((resolve, reject) => {
        exec(cmd, (error, _stdout, stderr) => {
          if (error) {
            pipelineLogger.error(
              `FFmpeg audio overlay failed: ${stderr}`,
              error,
              "MusicService",
            );
            reject(error);
          } else {
            pipelineLogger.checkpoint(
              "Background music added",
              true,
              `Merged ${path.basename(selectedTrack)} into ${outputPath}`,
            );
            resolve(outputPath);
          }
        });
      });
    } catch (err) {
      pipelineLogger.error(
        `Failed to overlay music on video`,
        err,
        "MusicService",
      );
      throw err;
    }
  }
}
