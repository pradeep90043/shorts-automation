import { exec, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { OpenAI } from "openai";
import { config } from "../config";
import { PipelineContext } from "../types";
import { pipelineLogger } from "../utils/logger";

export class TranscriptionService {
  /**
   * Extracts audio and transcribes it using OpenAI Whisper.
   * If there is no audio track, skips silently and sets context.transcript to null.
   */
  public static async transcribe(context: PipelineContext): Promise<void> {
    const videoPath = context.originalVideoPath;
    if (!videoPath || !fs.existsSync(videoPath)) {
      pipelineLogger.warn("No original video path found for transcription", "TranscriptionService");
      context.transcript = null;
      return;
    }

    const audioWavPath = path.join(context.tempDir, "audio.wav");

    // 1. Check if the video has an audio stream using ffprobe
    let hasAudio = false;
    try {
      const ffprobeCmd = `"${config.binaries.ffprobe || "ffprobe"}" -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${videoPath}"`;
      const ffprobeCheck = execSync(ffprobeCmd).toString().trim();
      hasAudio = ffprobeCheck === "audio";
    } catch (probeErr) {
      pipelineLogger.warn(
        `Failed to check video audio stream via ffprobe: ${probeErr instanceof Error ? probeErr.message : probeErr}`,
        "TranscriptionService"
      );
      // Fallback: we will try to extract anyway, and if it fails, check the error message.
      hasAudio = true;
    }

    context.hasOriginalAudio = hasAudio;

    if (!hasAudio) {
      pipelineLogger.info("No audio track detected in video, skipping transcription.", "TranscriptionService");
      context.transcript = null;
      return;
    }

    // 2. Extract audio using FFmpeg
    // ffmpeg -i [videoPath] -vn -ar 16000 -ac 1 -c:a pcm_s16le [audioWavPath]
    const ffmpegCmd = `"${config.binaries.ffmpeg || "ffmpeg"}" -y -i "${videoPath}" -vn -ar 16000 -ac 1 -c:a pcm_s16le "${audioWavPath}"`;
    
    try {
      await new Promise<void>((resolve, reject) => {
        exec(ffmpegCmd, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    } catch (ffmpegErr) {
      const errMsg = ffmpegErr instanceof Error ? ffmpegErr.message : String(ffmpegErr);
      // If it fails because of no audio stream, skip silently
      if (
        errMsg.includes("does not contain any stream") ||
        errMsg.includes("matches no streams") ||
        errMsg.includes("Output file does not contain any stream")
      ) {
        pipelineLogger.info("Silently skipping transcription: no audio stream found during extraction", "TranscriptionService");
        context.hasOriginalAudio = false;
        context.transcript = null;
        return;
      }
      pipelineLogger.error("FFmpeg audio extraction failed", ffmpegErr as Error, "TranscriptionService");
      context.transcript = null;
      return;
    }

    if (!fs.existsSync(audioWavPath)) {
      pipelineLogger.warn("Extracted audio file does not exist, skipping transcription.", "TranscriptionService");
      context.transcript = null;
      return;
    }

    // 3. Run Whisper transcription
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      try {
        const openai = new OpenAI({ apiKey });
        pipelineLogger.info(`Running OpenAI Whisper API transcription on ${audioWavPath}...`, "TranscriptionService");
        
        const response = await openai.audio.transcriptions.create({
          file: fs.createReadStream(audioWavPath),
          model: "whisper-1",
          response_format: "verbose_json",
          timestamp_granularities: ["word"],
        });

        const text = response.text || "";
        const words = ((response as any).words || []).map((w: any) => ({
          word: w.word,
          start: w.start,
          end: w.end,
        }));

        context.transcript = { text, words };
        pipelineLogger.info(`Successfully transcribed audio via OpenAI API. Word count: ${words.length}`, "TranscriptionService");
        return;
      } catch (whisperErr) {
        pipelineLogger.warn(
          `OpenAI Whisper API transcription failed: ${whisperErr instanceof Error ? whisperErr.message : whisperErr}. Trying local Whisper fallback...`,
          "TranscriptionService"
        );
      }
    }

    // Local Whisper Fallback
    try {
      pipelineLogger.info(`Running local Whisper CLI transcription on ${audioWavPath}...`, "TranscriptionService");
      
      const audioDir = path.dirname(audioWavPath);
      const audioStem = path.basename(audioWavPath, path.extname(audioWavPath));
      const outputJsonPath = path.join(audioDir, `${audioStem}.json`);

      // Run local whisper CLI command
      const whisperCmd = `whisper "${audioWavPath}" --model base --output_format json --output_dir "${audioDir}" --word_timestamps True`;
      await new Promise<void>((resolve, reject) => {
        exec(whisperCmd, (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`Whisper CLI failed: ${err.message}\nStdout: ${stdout}\nStderr: ${stderr}`));
          } else {
            resolve();
          }
        });
      });

      if (fs.existsSync(outputJsonPath)) {
        const jsonContent = fs.readFileSync(outputJsonPath, "utf8");
        const rawJson = JSON.parse(jsonContent);
        const text = rawJson.text || "";
        const words: Array<{ word: string; start: number; end: number }> = [];
        if (Array.isArray(rawJson.segments)) {
          for (const seg of rawJson.segments) {
            if (Array.isArray(seg.words)) {
              for (const w of seg.words) {
                words.push({
                  word: w.word || "",
                  start: w.start || 0,
                  end: w.end || 0,
                });
              }
            }
          }
        }

        context.transcript = { text, words };
        pipelineLogger.info(`Successfully transcribed audio via local Whisper CLI. Word count: ${words.length}`, "TranscriptionService");

        // Clean up the output JSON and any other output files generated by default
        try {
          fs.unlinkSync(outputJsonPath);
          for (const ext of ["txt", "srt", "vtt", "tsv"]) {
            const extraFile = path.join(audioDir, `${audioStem}.${ext}`);
            if (fs.existsSync(extraFile)) {
              fs.unlinkSync(extraFile);
            }
          }
        } catch (_) {}
      } else {
        throw new Error("Whisper CLI did not generate a JSON output file.");
      }
    } catch (localErr) {
      pipelineLogger.warn(
        `Local Whisper transcription failed: ${localErr instanceof Error ? localErr.message : localErr}`,
        "TranscriptionService"
      );
      context.transcript = null;
    }
  }
}
