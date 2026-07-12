import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { config } from "../config";

export type Emotion = 'energetic' | 'calm' | 'sad' | 'funny' | 'other';

/**
 * Get a free YouTube track based on emotion.
 * Returns an object with a title and a YouTube video ID.
 */
export function getTrackForEmotion(emotion: Emotion) {
  const dummyTracks: Record<Emotion, { title: string; videoId: string }[]> = {
    energetic: [
      { title: 'Cartoon - On & On (NCS)', videoId: 'K4DyBUG242c' },
      { title: 'Janji - Heroes Tonight (NCS)', videoId: '3nQNiWdeH2Q' },
      { title: 'Elektronomia - Sky High', videoId: 'TW9d8vYrVFQ' },
    ],
    calm: [
      { title: 'Lofi Study Music', videoId: '3gK_Q7JgU7M' },
      { title: 'Chillhop Yearming', videoId: '5qap5aO4i9A' },
    ],
    sad: [
      { title: 'Sad Piano', videoId: '8T04r7lYvD4' },
      { title: 'Emotional Violin', videoId: '1zHnB3R0T0Y' },
    ],
    funny: [
      { title: 'Funny Comedy Background', videoId: 'j1h8I3YF5K8' },
      { title: 'Sneaky Snitch', videoId: '-SjOkb3kVgI' },
    ],
    other: [
      { title: 'Disfigure - Blank (NCS)', videoId: 'p7ZsBPK656s' },
      { title: 'Ahrix - Nova', videoId: 'FjNdYp2gXRY' },
    ],
  };
  const list = dummyTracks[emotion] ?? dummyTracks['other'];
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Downloads audio from YouTube using yt-dlp.
 * Returns path to the downloaded audio file.
 */
export async function downloadAudio(track: { title: string; videoId: string }): Promise<string> {
  let ytdlpBin = config.binaries.ytdlp || "yt-dlp";
  if (ytdlpBin === "yt-dlp" && fs.existsSync("/opt/homebrew/bin/yt-dlp")) {
    ytdlpBin = "/opt/homebrew/bin/yt-dlp";
  }

  let ffmpegBin = config.binaries.ffmpeg || "ffmpeg";
  if (ffmpegBin === "ffmpeg" && fs.existsSync("/opt/homebrew/bin/ffmpeg")) {
    ffmpegBin = "/opt/homebrew/bin/ffmpeg";
  }

  const tempDir = config.paths.tempDir || "temp";
  const outputDir = path.resolve(tempDir, "youtube-music");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, `${track.videoId}.mp3`);

  // If already downloaded, return it
  if (fs.existsSync(outputPath)) {
    return outputPath;
  }

  const videoUrl = `https://www.youtube.com/watch?v=${track.videoId}`;
  const ffmpegLocation = `--ffmpeg-location "${ffmpegBin}"`;
  const cmd = `"${ytdlpBin}" ${ffmpegLocation} -x --audio-format mp3 -o "${outputPath}" "${videoUrl}"`;

  return new Promise((resolve, reject) => {
    exec(cmd, (err, _stdout, stderr) => {
      if (err) {
        console.error(`Failed to download audio from YouTube: ${stderr || err.message}`);
        reject(new Error(`yt-dlp failed: ${stderr || err.message}`));
      } else {
        resolve(outputPath);
      }
    });
  });
}
