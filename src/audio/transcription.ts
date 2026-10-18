import { exec, execFile, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { OpenAI } from "openai";
import { config } from "../config";
import { PipelineContext } from "../types";
import { pipelineLogger } from "../utils/logger";

const WHISPER_SCRIPT = path.resolve(__dirname, "../../scripts/transcribe_whisper.py");

export class TranscriptionService {
  /**
   * Transcribes a specific audio or video file and returns text and word-level timings.
   */
  public static async transcribeFile(
    filePath: string,
    tempDir: string,
    opts?: { language?: string },
  ): Promise<{ text: string; words: Array<{ word: string; start: number; end: number }> } | null> {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    const audioWavPath = path.join(tempDir, `audio_${path.basename(filePath, path.extname(filePath))}.wav`);

    // 1. Extract audio using FFmpeg
    const ffmpegCmd = `"${config.binaries.ffmpeg || "ffmpeg"}" -y -i "${filePath}" -vn -ar 16000 -ac 1 -c:a pcm_s16le "${audioWavPath}"`;
    
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
      if (
        errMsg.includes("does not contain any stream") ||
        errMsg.includes("matches no streams") ||
        errMsg.includes("Output file does not contain any stream")
      ) {
        return null;
      }
      pipelineLogger.error("FFmpeg audio extraction failed", ffmpegErr as Error, "TranscriptionService");
      return null;
    }

    if (!fs.existsSync(audioWavPath)) {
      return null;
    }

    // 2. Run Cloud Whisper transcription (Groq / Custom Endpoint / OpenAI)
    const groqKey = process.env.GROQ_API_KEY || process.env.GROQ_WHISPER_API_KEY;
    const customKey = process.env.WHISPER_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    const extractWords = (res: any): Array<{ word: string; start: number; end: number }> => {
      let words = ((res as any).words || [])
        .map((w: any) => ({
          word: (w.word || "").trim(),
          start: typeof w.start === "number" ? w.start : 0,
          end: typeof w.end === "number" ? w.end : 0,
        }))
        .filter((w: any) => Boolean(w.word));

      if (words.length === 0 && Array.isArray((res as any).segments)) {
        for (const seg of (res as any).segments) {
          if (Array.isArray(seg.words)) {
            for (const w of seg.words) {
              if (w.word && w.word.trim()) {
                words.push({
                  word: w.word.trim(),
                  start: typeof w.start === "number" ? w.start : 0,
                  end: typeof w.end === "number" ? w.end : 0,
                });
              }
            }
          }
        }
      }
      return words;
    };

    // 2A. Groq Cloud Whisper (Free tier: ultra-fast ~216x realtime, word-level timestamps)
    if (groqKey) {
      try {
        const groq = new OpenAI({
          apiKey: groqKey,
          baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
        });
        const groqModel = process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo";
        pipelineLogger.info(
          `Running Groq Cloud Whisper API (${groqModel}) on ${audioWavPath}...`,
          "TranscriptionService",
        );

        const response = await groq.audio.transcriptions.create({
          file: fs.createReadStream(audioWavPath),
          model: groqModel,
          response_format: "verbose_json",
          timestamp_granularities: ["word"],
          ...(opts?.language ? { language: opts.language } : {}),
        });

        const text = response.text || "";
        const words = extractWords(response);

        try {
          fs.unlinkSync(audioWavPath);
        } catch (_) {}

        pipelineLogger.info(
          `✓ Groq Cloud Whisper transcription completed (${words.length} words, text: "${text.slice(0, 60)}...")`,
          "TranscriptionService",
        );
        return { text, words };
      } catch (groqErr) {
        pipelineLogger.warn(
          `Groq Cloud Whisper transcription failed: ${groqErr instanceof Error ? groqErr.message : groqErr}. Trying next provider...`,
          "TranscriptionService",
        );
      }
    }

    // 2B. Custom OpenAI-compatible Cloud Whisper endpoint
    if (customKey && process.env.WHISPER_API_URL) {
      try {
        const client = new OpenAI({
          apiKey: customKey,
          baseURL: process.env.WHISPER_API_URL,
        });
        const model = process.env.WHISPER_MODEL || "whisper-large-v3";
        pipelineLogger.info(
          `Running Custom Cloud Whisper API (${model}) on ${audioWavPath}...`,
          "TranscriptionService",
        );

        const response = await client.audio.transcriptions.create({
          file: fs.createReadStream(audioWavPath),
          model: model,
          response_format: "verbose_json",
          timestamp_granularities: ["word"],
          ...(opts?.language ? { language: opts.language } : {}),
        });

        const text = response.text || "";
        const words = extractWords(response);

        try {
          fs.unlinkSync(audioWavPath);
        } catch (_) {}

        return { text, words };
      } catch (customErr) {
        pipelineLogger.warn(
          `Custom Cloud Whisper API transcription failed: ${customErr instanceof Error ? customErr.message : customErr}. Trying next provider...`,
          "TranscriptionService",
        );
      }
    }

    // 2C. OpenAI Whisper API
    if (openaiKey) {
      try {
        const openai = new OpenAI({ apiKey: openaiKey });
        pipelineLogger.info(`Running OpenAI Whisper API transcription on ${audioWavPath}...`, "TranscriptionService");
        
        const response = await openai.audio.transcriptions.create({
          file: fs.createReadStream(audioWavPath),
          model: "whisper-1",
          response_format: "verbose_json",
          timestamp_granularities: ["word"],
          ...(opts?.language ? { language: opts.language } : {}),
        });

        const text = response.text || "";
        const words = extractWords(response);

        try {
          fs.unlinkSync(audioWavPath);
        } catch (_) {}

        return { text, words };
      } catch (whisperErr) {
        pipelineLogger.warn(
          `OpenAI Whisper API transcription failed: ${whisperErr instanceof Error ? whisperErr.message : whisperErr}. Trying local Whisper fallback...`,
          "TranscriptionService"
        );
      }
    }

    // Local Whisper Fallback
    try {
      pipelineLogger.info(`Running local Whisper (faster-whisper) transcription on ${audioWavPath}...`, "TranscriptionService");
      
      const audioDir = path.dirname(audioWavPath);
      const audioStem = path.basename(audioWavPath, path.extname(audioWavPath));
      const outputJsonPath = path.join(audioDir, `${audioStem}.json`);

      // faster-whisper via scripts/transcribe_whisper.py (CPU, int8); writes the same JSON shape as the whisper CLI.
      await new Promise<void>((resolve, reject) => {
        execFile(
          config.binaries.python3 || "python3",
          [WHISPER_SCRIPT, audioWavPath, outputJsonPath],
          { timeout: 10 * 60 * 1000, maxBuffer: 5 * 1024 * 1024 },
          (err, _stdout, stderr) => {
            if (err) {
              reject(new Error(`Local Whisper failed: ${stderr.trim().split("\n").slice(-3).join(" | ") || err.message}`));
            } else {
              resolve();
            }
          },
        );
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

        try {
          fs.unlinkSync(audioWavPath);
          fs.unlinkSync(outputJsonPath);
          for (const ext of ["txt", "srt", "vtt", "tsv"]) {
            const extraFile = path.join(audioDir, `${audioStem}.${ext}`);
            if (fs.existsSync(extraFile)) {
              fs.unlinkSync(extraFile);
            }
          }
        } catch (_) {}

        return { text, words };
      } else {
        throw new Error("Local Whisper did not generate a JSON output file.");
      }
    } catch (localErr) {
      pipelineLogger.warn(
        `Local Whisper transcription failed: ${localErr instanceof Error ? localErr.message : localErr}`,
        "TranscriptionService"
      );
      try {
        if (fs.existsSync(audioWavPath)) {
          fs.unlinkSync(audioWavPath);
        }
      } catch (_) {}
      return null;
    }
  }

  /**
   * Extracts audio and transcribes it using OpenAI Whisper.
   * If there is no audio track, skips silently and sets context.transcript to null.
   */
  public static async transcribe(context: PipelineContext): Promise<void> {
    if (context.transcript !== undefined) {
      pipelineLogger.info("Reusing existing transcript in context", "TranscriptionService");
      return;
    }
    const videoPath = context.originalVideoPath;
    if (!videoPath || !fs.existsSync(videoPath)) {
      pipelineLogger.warn("No original video path found for transcription", "TranscriptionService");
      context.transcript = null;
      return;
    }

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

    const result = await this.transcribeFile(videoPath, context.tempDir);
    context.transcript = result;
    if (result) {
      pipelineLogger.info(`Successfully transcribed original video audio. Word count: ${result.words.length}`, "TranscriptionService");
    }
  }
}
