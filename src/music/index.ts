import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { IMusicService } from "../types";
import { extractVocals } from "../audio/vocalExtractor";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";

const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".ogg"];

// Each mood maps to a sub-folder of the music dir; unknown moods use "other".
const KNOWN_MOODS = [
  "funny",
  "sad",
  "horror",
  "emotional",
  "romantic",
  "motivational",
  "serious",
  "technical",
  "other",
] as const;
type Mood = (typeof KNOWN_MOODS)[number];

function normalizeMood(mood?: string): Mood {
  const m = (mood || "").toLowerCase().trim() as Mood;
  return KNOWN_MOODS.includes(m) ? m : "other";
}

export class MusicService implements IMusicService {
  /** Track used by the most recent addBackgroundMusic call */
  public lastSelectedTrack: string | null = null;

  public async addBackgroundMusic(
    videoPath: string,
    musicFolder: string,
    outputPath: string,
    mood?: string,
    forceReplace: boolean = false,
    excludeTrack?: string,
    specificTrack?: string,
    voiceoverPath?: string,
  ): Promise<string> {
    pipelineLogger.info(
      `Adding background music to video ${videoPath} (Mood: ${mood || "unspecified"})`,
      "MusicService",
    );

    try {
      this.lastSelectedTrack = null;

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

      let vocalOnlyPath: string | null = voiceoverPath || null;
      if (hasAudio && !vocalOnlyPath) {
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

      const selectedTrack = specificTrack || this.selectLocalTrack(
        musicFolder,
        mood,
        excludeTrack,
      );
      this.lastSelectedTrack = selectedTrack;

      const fadeDuration = 1.5; // seconds
      const fadeOutStart = duration - fadeDuration;
      const volume = config.rendering.musicVolume;
      const startOffset = config.rendering.musicStartOffset;

      let filterComplex = "";
      let cmd = "";

      // The output must ALWAYS be exactly as long as the video. The music
      // input is looped infinitely (so a short track or the start offset can
      // never truncate the video via -shortest) and the final audio is
      // trimmed/padded to the video duration.
      const musicInput = `-stream_loop -1 -ss ${startOffset} -i "${selectedTrack}"`;

      if (!hasAudio && !vocalOnlyPath) {
        filterComplex = `[1:a]volume=${volume},afade=t=in:ss=0:d=${fadeDuration},afade=t=out:st=${fadeOutStart}:d=${fadeDuration},atrim=0:${duration}[a]`;
        cmd = `ffmpeg -y -i "${videoPath}" ${musicInput} -filter_complex "${filterComplex}" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${outputPath}"`;
      } else if (vocalOnlyPath) {
        // [0:v] video, [1:a] bg music, [2:a] vocals/voiceover.
        // Voice must always win over music: music runs at half the configured
        // volume and is sidechain-ducked under the voice; the voice is boosted
        // and amix runs with normalize=0 so it doesn't attenuate the inputs.
        // The voice is padded with silence to the full video duration so
        // amix (duration=first) always yields video-length audio — a short
        // TTS voiceover must never cut the video down to its own length.
        const duckedMusicVolume = Math.min(volume, 0.08);
        filterComplex =
          `[2:a]asplit=2[vokey][vomix];` +
          `[1:a]volume=${duckedMusicVolume},afade=t=in:ss=0:d=${fadeDuration},afade=t=out:st=${fadeOutStart}:d=${fadeDuration}[bg];` +
          `[bg][vokey]sidechaincompress=threshold=0.05:ratio=15:attack=10:release=300[bg_ducked];` +
          `[vomix]volume=2.0,apad=whole_dur=${duration}[vo];` +
          `[vo][bg_ducked]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,atrim=0:${duration}[a]`;

        cmd = `ffmpeg -y -i "${videoPath}" ${musicInput} -i "${vocalOnlyPath}" -filter_complex "${filterComplex}" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${outputPath}"`;
      } else {
        // forceReplace requested but vocals could not be isolated (demucs not
        // installed) — drop the original audio entirely so the original song is
        // fully replaced by our track, played at full volume.
        pipelineLogger.info(
          "Vocal isolation unavailable — replacing original audio entirely with background music",
          "MusicService",
        );
        filterComplex = `[1:a]volume=1.0,afade=t=in:ss=0:d=${fadeDuration},afade=t=out:st=${fadeOutStart}:d=${fadeDuration},atrim=0:${duration}[a]`;
        cmd = `ffmpeg -y -i "${videoPath}" ${musicInput} -filter_complex "${filterComplex}" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${outputPath}"`;
      }

      pipelineLogger.info(
        `Executing FFmpeg audio mixing command: ${cmd}`,
        "MusicService",
      );

      return new Promise<string>((resolve, reject) => {
        // Hard timeout so a stuck ffmpeg can never pin the CPU for hours
        exec(cmd, { timeout: 10 * 60 * 1000, killSignal: "SIGKILL" }, (error, _stdout, stderr) => {
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

  /**
   * Pick a random track from the local library, preferring the mood folder,
   * then "other", then loose files at the library root. `excludeTrack` (the
   * previously used track) is skipped whenever another candidate exists so
   * that "Replace Music" always produces an audible change.
   */
  public selectLocalTrack(
    musicFolder: string,
    mood?: string,
    excludeTrack?: string,
  ): string {
    const normalizedMood = normalizeMood(mood);
    const foldersToTry = [path.join(musicFolder, normalizedMood)];
    if (normalizedMood !== "other") {
      foldersToTry.push(path.join(musicFolder, "other"));
    }
    foldersToTry.push(musicFolder);

    let audioTracks: string[] = [];
    for (const folder of foldersToTry) {
      if (!fs.existsSync(folder)) continue;
      const files = fs
        .readdirSync(folder)
        .filter((file) =>
          AUDIO_EXTENSIONS.includes(path.extname(file).toLowerCase()),
        )
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

    if (audioTracks.length === 0) {
      throw new Error(`No music tracks found in ${musicFolder}`);
    }

    if (excludeTrack && audioTracks.length > 1) {
      const excludeName = path.basename(excludeTrack);
      const filtered = audioTracks.filter(
        (track) => path.basename(track) !== excludeName,
      );
      if (filtered.length > 0) audioTracks = filtered;
    }

    const selected =
      audioTracks[Math.floor(Math.random() * audioTracks.length)];
    pipelineLogger.info(
      `Selected background track: ${path.basename(selected)}`,
      "MusicService",
    );
    return selected;
  }
}
