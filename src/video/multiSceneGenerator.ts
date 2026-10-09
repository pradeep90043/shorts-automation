import fs from "fs";
import path from "path";
import sharp from "sharp";
import { exec } from "child_process";
import { promisify } from "util";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { FreeLlmApiClient } from "../ai/freellmapi";
import { GeminiClient } from "../ai/gemini";
import { TTSService } from "../audio/tts";
import { estimateWordTimings, groupWordsIntoLines, generateASSFile, SubtitleStyle } from "../audio/subtitles";
import { PexelsService } from "./pexelsService";
import { MusicService, ambientBedPath } from "../music";
import { parseAiJson } from "../utils/json";
import { VideoMetadata } from "../types";

const execAsync = promisify(exec);

export interface SceneSpec {
  sentence: string;
  keywords: string[];
  durationEstimate?: number;
}

export interface MultiSceneScriptResult {
  title: string;
  description: string;
  tags: string[];
  scenes: SceneSpec[];
  fullScript: string;
}

export interface GenerateFacelessOptions {
  topic?: string;
  script?: string;
  channelKey: string;
  brandName: string;
  handle: string;
  niche: string;
  voice?: string;
  subtitleStyle?: SubtitleStyle;
  aspectRatio?: "9:16" | "16:9";
  durationTarget?: "short" | "3min" | "5min" | "10min";
  outputDir?: string;
  musicFile?: string;
}

export interface GenerateFacelessResult {
  success: boolean;
  videoPath: string;
  metadata: VideoMetadata;
  fullScript: string;
  scenesCount: number;
  duration: number;
  aspectRatio: "9:16" | "16:9";
}

export class MultiSceneGenerator {
  private tts: TTSService;
  private pexels: PexelsService;
  private music: MusicService;
  private freellmapi?: FreeLlmApiClient;
  private gemini?: GeminiClient;

  constructor() {
    this.tts = new TTSService();
    this.pexels = new PexelsService();
    this.music = new MusicService();
    if (config.ai.provider === "freellmapi" || process.env.FREELLMAPI_KEY) {
      this.freellmapi = new FreeLlmApiClient();
    }
    if (process.env.GEMINI_API_KEY) {
      this.gemini = new GeminiClient();
    }
  }

  /**
   * Generates a structured multi-scene script breakdown from a topic.
   */
  public async generateScriptAndScenes(
    topic: string,
    niche: string,
    brandName: string,
    durationTarget: "short" | "3min" | "5min" | "10min" = "short",
  ): Promise<MultiSceneScriptResult> {
    const isLong = durationTarget !== "short";
    const targetWords = durationTarget === "5min" ? 700 : durationTarget === "3min" ? 450 : durationTarget === "10min" ? 1300 : 90;
    const sceneCount = durationTarget === "5min" ? 16 : durationTarget === "3min" ? 10 : durationTarget === "10min" ? 25 : 4;

    const prompt = isLong
      ? `You are an expert YouTube content creator, educator, and technical scriptwriter for "${brandName}" (Niche: ${niche}).
Write a comprehensive, highly engaging, structured ~${targetWords}-word full-length YouTube video script about: "${topic}".
Break the script down into exactly ${sceneCount} narrative scenes across clear chapters (Intro, Core Concepts, In-Depth Breakdown, Practical Examples, Best Practices, and Conclusion/Subscribe).

Return ONLY valid JSON with this exact schema:
{
  "title": "Compelling YouTube Video Title under 70 chars with high CTR",
  "description": "Full YouTube description with timestamps/chapters, key takeaways, and hashtags",
  "tags": ["tutorial", "${niche}", "guide", "deep dive", "youtube"],
  "scenes": [
    {
      "sentence": "Hook and introductory statement explaining what viewers will learn in this video.",
      "keywords": ["software architecture diagram", "developer typing terminal"]
    },
    {
      "sentence": "Next educational sentence explaining point 1 in depth.",
      "keywords": ["cloud computing server rack", "data analytics glowing"]
    }
  ]
}`
      : `You are a viral YouTube Shorts and Instagram Reels scriptwriter for "${brandName}" (Niche: ${niche}).
Write an engaging, high-retention 35-45 second video script about: "${topic}".

Return ONLY valid JSON with this exact schema:
{
  "title": "Catchy YouTube Shorts title under 60 chars with 2 hashtags",
  "description": "Engaging description with 4-5 relevant hashtags",
  "tags": ["shorts", "reels", "viral", "${niche}"],
  "scenes": [
    {
      "sentence": "Hook line that grabs attention immediately.",
      "keywords": ["fast tech server", "matrix code glowing"]
    },
    {
      "sentence": "Second sentence explaining the core concept.",
      "keywords": ["cyberpunk artificial intelligence", "programmer typing"]
    },
    {
      "sentence": "Third sentence providing a surprising fact or twist.",
      "keywords": ["futuristic robotics", "digital data stream"]
    },
    {
      "sentence": "Call to action or closing thought.",
      "keywords": ["neon futuristic city", "modern abstract technology"]
    }
  ]
}`;

    let jsonText = "";
    if (this.freellmapi) {
      try {
        jsonText = await this.freellmapi.generateText(prompt);
      } catch (err: any) {
        pipelineLogger.warn(`FreeLLMAPI failed for script generation: ${err.message}`, "MultiSceneGenerator");
      }
    }

    if (!jsonText && this.gemini) {
      try {
        jsonText = await this.gemini.generateText(prompt);
      } catch (err: any) {
        pipelineLogger.warn(`Gemini failed for script generation: ${err.message}`, "MultiSceneGenerator");
      }
    }

    if (!jsonText) {
      // Fallback default script structure
      return {
        title: `${topic.slice(0, 50)} - Full Guide #${niche}`,
        description: `Here is everything you need to know about ${topic}. #${niche} #Tutorial #Guide`,
        tags: ["tutorial", "guide", niche],
        scenes: [
          { sentence: `Welcome to our comprehensive guide on ${topic}. Let's dive right in.`, keywords: [niche, "technology"] },
          { sentence: `First, let's understand why this concept matters so much today.`, keywords: ["data", "abstract"] },
          { sentence: `Here is how the underlying architecture works in practice.`, keywords: ["futuristic", "digital"] },
          { sentence: `Make sure to implement these patterns in your next production build.`, keywords: ["programmer", "code"] },
        ],
        fullScript: `Welcome to our comprehensive guide on ${topic}. Let's dive right in. First, let's understand why this concept matters so much today. Here is how the underlying architecture works in practice. Make sure to implement these patterns in your next production build.`,
      };
    }

    const parsed = parseAiJson<any>(jsonText);
    const scenes: SceneSpec[] = (parsed.scenes || []).map((s: any) => ({
      sentence: String(s.sentence || "").trim(),
      keywords: Array.isArray(s.keywords) ? s.keywords.map(String) : [niche],
    })).filter((s: SceneSpec) => s.sentence.length > 0);

    const fullScript = scenes.map((s) => s.sentence).join(" ");

    return {
      title: parsed.title || `${topic} | Complete Guide`,
      description: parsed.description || `${topic} - Explained in detail. #${niche}`,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [niche, "youtube", "guide"],
      scenes,
      fullScript,
    };
  }

  /**
   * Main entry point to build an entire faceless multi-scene short.
   */
  public async generateFacelessShort(
    options: GenerateFacelessOptions,
  ): Promise<GenerateFacelessResult> {
    const tempDir = path.join(
      config.paths.tempDir,
      `faceless-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    fs.mkdirSync(tempDir, { recursive: true });

    const isLandscape = options.aspectRatio === "16:9" || options.durationTarget === "5min" || options.durationTarget === "3min" || options.durationTarget === "10min";
    const aspectRatio: "9:16" | "16:9" = isLandscape ? "16:9" : "9:16";
    const pexelsOrientation: "portrait" | "landscape" = isLandscape ? "landscape" : "portrait";
    const width = isLandscape ? 1920 : 1080;
    const height = isLandscape ? 1080 : 1920;

    pipelineLogger.info(`[MultiScene] Generating ${aspectRatio} video (${options.durationTarget || 'short'}) in ${tempDir}`, "MultiSceneGenerator");

    try {
      // 1. Script & Scene breakdown
      let scriptData: MultiSceneScriptResult;
      if (options.script) {
        // User provided exact script
        const sentences = options.script.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);
        scriptData = {
          title: `${options.topic || options.brandName} ${isLandscape ? '| Full Video' : '#Shorts'}`,
          description: `${options.script.slice(0, 100)}... #${options.niche}`,
          tags: [options.niche, isLandscape ? "guide" : "shorts", "tutorial"],
          scenes: sentences.map((sent) => ({ sentence: sent, keywords: [options.niche, "technology", "abstract"] })),
          fullScript: options.script,
        };
      } else {
        scriptData = await this.generateScriptAndScenes(
          options.topic || options.niche,
          options.niche,
          options.brandName,
          options.durationTarget || "short",
        );
      }

      pipelineLogger.info(`[MultiScene] Script generated with ${scriptData.scenes.length} scenes`, "MultiSceneGenerator");

      // 2. Synthesize TTS voiceover
      const voiceoverPath = path.join(tempDir, "voiceover.mp3");
      const duration = await this.tts.generateVoiceover(
        scriptData.fullScript,
        voiceoverPath,
        options.channelKey,
      );

      pipelineLogger.info(`[MultiScene] Voiceover duration: ${duration.toFixed(1)}s`, "MultiSceneGenerator");

      // 3. Generate Subtitles
      const wordTimings = estimateWordTimings(scriptData.fullScript, duration);
      const subtitleLines = groupWordsIntoLines(wordTimings, isLandscape ? 50 : 32, isLandscape ? 10 : 6);
      const assPath = path.join(tempDir, "subtitles.ass");
      generateASSFile(subtitleLines, assPath, options.subtitleStyle || "classic");

      // 4. Download B-roll clips for each scene
      const sceneClips: string[] = [];
      const sceneDuration = duration / Math.max(1, scriptData.scenes.length);

      for (let i = 0; i < scriptData.scenes.length; i++) {
        const scene = scriptData.scenes[i];
        const clipTarget = path.join(tempDir, `scene_${i}.mp4`);
        const query = scene.keywords[0] || options.niche;

        pipelineLogger.info(`[MultiScene] Fetching B-roll for scene ${i + 1}/${scriptData.scenes.length}: "${query}"`, "MultiSceneGenerator");
        let downloaded = false;

        if (this.pexels.isAvailable()) {
          try {
            const videos = await this.pexels.searchVideos(query, pexelsOrientation, 6);
            if (videos.length > 0) {
              const chosen = videos[i % videos.length];
              const fileLink = chosen.video_files.find((f) => (isLandscape ? f.width >= 1280 : f.height >= 1280))?.link || chosen.video_files[0]?.link;
              if (fileLink) {
                const rawScenePath = path.join(tempDir, `raw_scene_${i}.mp4`);
                await this.pexels.downloadVideoFile(fileLink, rawScenePath);
                // Standardize to exact resolution at 30fps
                await execAsync(
                  `ffmpeg -y -i "${rawScenePath}" -t ${Math.ceil(sceneDuration + 1)} -vf "scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -an "${clipTarget}"`
                );
                downloaded = fs.existsSync(clipTarget);
              }
            }
          } catch (err: any) {
            pipelineLogger.warn(`[MultiScene] Scene ${i} stock download failed: ${err.message}`, "MultiSceneGenerator");
          }
        }

        // Fallback: Generate colored gradient background if no stock video
        if (!downloaded) {
          await execAsync(
            `ffmpeg -y -f lavfi -i "color=c=0x0f172a:s=${width}x${height}:d=${Math.ceil(sceneDuration + 1)}" -vf "fps=30" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${clipTarget}"`
          );
        }

        if (fs.existsSync(clipTarget)) {
          sceneClips.push(clipTarget);
        }
      }

      // 5. Concatenate scenes
      const concatListFile = path.join(tempDir, "concat.txt");
      fs.writeFileSync(
        concatListFile,
        sceneClips.map((c) => `file '${c}'`).join("\n"),
        "utf8",
      );

      const mergedVideoPath = path.join(tempDir, "merged_broll.mp4");
      await execAsync(
        `ffmpeg -y -f concat -safe 0 -i "${concatListFile}" -t ${duration.toFixed(2)} -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${mergedVideoPath}"`
      );

      // 6. Background Music
      let musicFile = options.musicFile || "";
      if (!musicFile) {
        if (config.rendering.backgroundMusicEnabled) {
          try {
            musicFile = this.music.selectLocalTrack(config.paths.musicDir, options.niche);
          } catch (_) {}
        } else {
          musicFile = ambientBedPath(); // non-musical ambient bed only
        }
      }

      // 7. Render Subtitle Overlay Images
      let inputArgs = `-i "${mergedVideoPath}" -i "${voiceoverPath}"`;
      if (musicFile && fs.existsSync(musicFile)) {
        inputArgs += ` -stream_loop -1 -i "${musicFile}"`;
      }

      const subInputCount = subtitleLines.length;
      let lastVLabel = "[0:v]";
      let subFilters = "";

      if (options.subtitleStyle !== "none") {
        for (let i = 0; i < subInputCount; i++) {
          const line = subtitleLines[i];
          if (!line.text.trim()) continue;
          const subPngPath = path.join(tempDir, `sub_${i}.png`);
          
          const subW = width;
          const subH = isLandscape ? 120 : 180;
          const fontSize = isLandscape ? 40 : 54;
          const escapedText = line.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const bgW = Math.min(subW - 80, Math.max(300, line.text.length * (fontSize * 0.58) + 60));
          const bgX = (subW - bgW) / 2;
          const textY = Math.round(subH / 2 + fontSize * 0.35);

          const subSvg = `<svg width="${subW}" height="${subH}" xmlns="http://www.w3.org/2000/svg">
            <rect x="${bgX}" y="10" width="${bgW}" height="${subH - 20}" rx="16" fill="#000000" fill-opacity="0.75" stroke="#FFD700" stroke-width="2"/>
            <text x="${subW / 2}" y="${textY}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900" fill="#FFFFFF" text-anchor="middle">${escapedText}</text>
          </svg>`;

          await sharp(Buffer.from(subSvg)).png().toFile(subPngPath);
          const inIdx = (musicFile && fs.existsSync(musicFile) ? 3 : 2) + i;
          inputArgs += ` -i "${subPngPath}"`;

          const subY = isLandscape ? height - subH - 60 : height - subH - 260;
          const outLabel = `[vsub_${i}]`;
          subFilters += `${lastVLabel}[${inIdx}:v]overlay=0:${subY}:enable='between(t,${line.start.toFixed(2)},${line.end.toFixed(2)})'${outLabel}; `;
          lastVLabel = outLabel;
        }
      }

      // 8. Final Composite
      const outDir = options.outputDir || config.paths.outputDir;
      fs.mkdirSync(outDir, { recursive: true });
      const prefix = isLandscape ? "video" : "short";
      const finalVideoPath = path.join(outDir, `${prefix}-${options.channelKey}-${Date.now()}.mp4`);

      let audioFilter = `[1:a]volume=1.2[vox]`;
      if (musicFile && fs.existsSync(musicFile)) {
        audioFilter = `[1:a]volume=1.2[vox];[2:a]volume=0.10[bgm];[vox][bgm]amix=inputs=2:duration=first[aout]`;
      } else {
        audioFilter = `[1:a]volume=1.2[aout]`;
      }

      const videoFilter = subFilters ? `${subFilters}${lastVLabel}format=yuv420p[vout]` : `[0:v]format=yuv420p[vout]`;
      const filterComplex = `${videoFilter}; ${audioFilter}`;

      await execAsync(
        `ffmpeg -y ${inputArgs} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -shortest "${finalVideoPath}"`
      );

      pipelineLogger.info(`[MultiScene] Final ${aspectRatio} video rendered successfully: ${finalVideoPath}`, "MultiSceneGenerator");

      return {
        success: true,
        videoPath: finalVideoPath,
        metadata: {
          title: scriptData.title,
          description: `${scriptData.description}\n\nProduced for ${options.brandName} (${options.handle})`,
          tags: scriptData.tags,
        },
        fullScript: scriptData.fullScript,
        scenesCount: scriptData.scenes.length,
        duration,
        aspectRatio,
      };
    } finally {
      // Clean up temp scratch folder
      fs.rm(tempDir, { recursive: true, force: true }, () => {});
    }
  }
}
