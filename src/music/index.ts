import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { IMusicService } from "../types";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";

export class MusicService implements IMusicService {
  public async addBackgroundMusic(
    videoPath: string,
    musicFolder: string,
    outputPath: string,
    mood?: "funny" | "sad" | "other",
  ): Promise<string> {
    pipelineLogger.info(
      `Adding background music to video ${videoPath} (Mood: ${mood || "unspecified"})`,
      "MusicService",
    );

    try {
      // 1. Find all available music tracks in target mood folder or fallbacks
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

      let selectedTrack = "";

      if (audioTracks.length > 0) {
        // Randomly pick a track
        const randomIndex = Math.floor(Math.random() * audioTracks.length);
        selectedTrack = audioTracks[randomIndex];
        pipelineLogger.info(
          `Randomly selected background track: ${path.basename(selectedTrack)}`,
          "MusicService",
        );
      } else {
        // Fallback to our synthesized default track in the assets directory
        const defaultTrackPath = path.join(
          config.paths.assetsDir,
          "ambient_synth.aac",
        );
        if (fs.existsSync(defaultTrackPath)) {
          selectedTrack = defaultTrackPath;
          pipelineLogger.warn(
            `No tracks found in music folder. Falling back to default synthesized track: ${defaultTrackPath}`,
            "MusicService",
          );
        } else {
          throw new Error(
            `No audio tracks available in ${musicFolder} and no default synthesized track exists.`,
          );
        }
      }

      // Helper functions to get video details
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

      const fadeDuration = 1.5; // seconds
      const fadeOutStart = duration - fadeDuration;
      const volume = config.rendering.musicVolume;
      const startOffset = config.rendering.musicStartOffset;

      // 3. Construct FFmpeg command with conditional audio mixing
      let filterComplex = "";
      if (hasAudio) {
        filterComplex = `[1:a]volume=${volume},afade=t=in:ss=0:d=${fadeDuration},afade=t=out:st=${fadeOutStart}:d=${fadeDuration}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[a]`;
      } else {
        filterComplex = `[1:a]volume=${volume},afade=t=in:ss=0:d=${fadeDuration},afade=t=out:st=${fadeOutStart}:d=${fadeDuration}[a]`;
      }

      const cmd = `ffmpeg -y -i "${videoPath}" -ss ${startOffset} -i "${selectedTrack}" -filter_complex "${filterComplex}" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${outputPath}"`;

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
