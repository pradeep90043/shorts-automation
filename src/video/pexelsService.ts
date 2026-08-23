import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import fs from "fs";
import path from "path";
import { exec } from "child_process";

export interface PexelsVideoFile {
  id: number;
  quality: string;
  file_type: string;
  width: number;
  height: number;
  fps?: number;
  link: string;
}

export interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number;
  url: string;
  image: string;
  video_files: PexelsVideoFile[];
}

export interface PexelsSearchResponse {
  page: number;
  per_page: number;
  total_results: number;
  url: string;
  videos: PexelsVideo[];
}

/**
 * PexelsService — searches and downloads high-definition vertical stock video clips (MoneyPrinterTurbo style)
 * to serve as cinematic moving b-roll backgrounds for the "How It Works" transition sequence.
 */
export class PexelsService {
  private apiKey: string;
  private defaultQueries = [
    "coding",
    "programming",
    "matrix code",
    "software developer",
    "computer code",
    "artificial intelligence",
    "cyberpunk terminal",
    "technology data",
    "hacker terminal",
    "web developer typing",
  ];

  constructor(apiKey?: string) {
    this.apiKey = (apiKey || "").trim();
  }

  public getApiKey(): string {
    return (
      this.apiKey ||
      process.env.PEXELS_API_KEY ||
      process.env.PIXELS_API_KEY ||
      process.env.PEXEL_API_KEY ||
      config.ai?.pexelsApiKey ||
      ""
    ).trim();
  }

  public isAvailable(): boolean {
    const key = this.getApiKey();
    return !!key && key.length > 0;
  }

  /**
   * Searches Pexels Video API for stock videos matching the query (MoneyPrinterTurbo style).
   */
  public async searchVideos(
    query: string,
    orientation: "portrait" | "landscape" = "portrait",
    perPage = 15,
  ): Promise<PexelsVideo[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      pipelineLogger.warn(
        "Pexels API key not configured. Set PEXELS_API_KEY in .env to enable stock b-roll clips.",
        "PexelsService",
      );
      return [];
    }

    try {
      const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(
        query,
      )}&orientation=${orientation}&per_page=${perPage}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(url, {
        headers: {
          Authorization: apiKey,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        pipelineLogger.warn(
          `Pexels search failed (${res.status}): ${errText.slice(0, 100)}`,
          "PexelsService",
        );
        return [];
      }

      const data = (await res.json()) as PexelsSearchResponse;
      return data.videos || [];
    } catch (err: any) {
      pipelineLogger.warn(
        `Pexels request error: ${err.message || err}`,
        "PexelsService",
      );
      return [];
    }
  }

  /**
   * Selects the highest quality video file, favoring 9:16 vertical resolution.
   */
  public getBestVideoFile(video: PexelsVideo): PexelsVideoFile | null {
    if (!video.video_files || video.video_files.length === 0) return null;

    // 1. Prefer 1080x1920 (HD portrait)
    const exact1080 = video.video_files.find(
      (f) => f.width === 1080 && f.height === 1920 && f.link,
    );
    if (exact1080) return exact1080;

    // 2. Prefer any vertical file with height >= 1080
    const highVert = video.video_files.find(
      (f) => f.height > f.width && f.height >= 1080 && f.link,
    );
    if (highVert) return highVert;

    // 3. Any vertical file
    const anyVert = video.video_files.find(
      (f) => f.height > f.width && f.link,
    );
    if (anyVert) return anyVert;

    // 4. Fall back to highest resolution file (to be cropped to 9:16)
    const sorted = [...video.video_files]
      .filter((f) => f.link)
      .sort((a, b) => (b.width * b.height) - (a.width * a.height));

    return sorted[0] || null;
  }

  /**
   * Downloads a video from a direct URL to destPath.
   */
  public async downloadVideoFile(
    downloadUrl: string,
    destPath: string,
  ): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      const res = await fetch(downloadUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) return false;

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(destPath, buffer);
      return true;
    } catch (err: any) {
      pipelineLogger.warn(
        `Failed to download Pexels video: ${err.message || err}`,
        "PexelsService",
      );
      return false;
    }
  }

  /**
   * Formats and trims/loops the downloaded video into an exact 1080x1920 @ 30fps clip.
   */
  public async formatBrollClip(
    rawVideoPath: string,
    targetDurationSec: number,
    outputPath: string,
  ): Promise<boolean> {
    try {
      const cmd = `${config.binaries.ffmpeg} -y -stream_loop -1 -i "${rawVideoPath}" -t ${targetDurationSec.toFixed(
        2,
      )} -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" -c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p -an "${outputPath}"`;

      await new Promise<void>((resolve, reject) => {
        exec(cmd, (err) => (err ? reject(err) : resolve()));
      });

      return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
    } catch (err: any) {
      pipelineLogger.warn(
        `FFmpeg broll format failed: ${err.message || err}`,
        "PexelsService",
      );
      return false;
    }
  }

  /**
   * Primary helper: searches tech b-roll, downloads and formats it for the transition clip.
   */
  public async fetchTechBroll(
    context: { title?: string; tags?: string[]; howItWorks?: string },
    durationSec: number,
    outputPath: string,
  ): Promise<string | null> {
    // 1. Extract search term
    const candidates: string[] = [];

    if (context.title) {
      const cleanTitle = context.title.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
      const techKeywords = cleanTitle
        .split(/\s+/)
        .filter((w) =>
          /python|javascript|typescript|react|rust|golang|docker|kubernetes|ai|database|sql|api|backend|frontend|linux|terminal|algorithm|git|cloud|security/i.test(
            w,
          ),
        );
      if (techKeywords.length) {
        candidates.push(`${techKeywords.slice(0, 2).join(" ")} coding`);
      }
    }

    if (context.tags && context.tags.length) {
      const cleanTag = context.tags[0].replace(/#/g, "").trim();
      if (cleanTag.length > 2) candidates.push(`${cleanTag} programming`);
    }

    // Add randomized defaults to avoid repeating identical b-roll
    const shuffled = [...this.defaultQueries].sort(() => 0.5 - Math.random());
    candidates.push(...shuffled);

    // Try queries in order until one returns videos
    for (const query of candidates.slice(0, 3)) {
      pipelineLogger.info(
        `Searching Pexels API for tech b-roll: "${query}"...`,
        "PexelsService",
      );

      // Try portrait first
      let videos = await this.searchVideos(query, "portrait", 10);
      if (!videos.length) {
        // Fallback to landscape
        videos = await this.searchVideos(query, "landscape", 10);
      }

      if (videos.length > 0) {
        // Pick a random video from the top 5 to keep variety high
        const chosen = videos[Math.floor(Math.random() * Math.min(videos.length, 5))];
        const bestFile = this.getBestVideoFile(chosen);

        if (bestFile && bestFile.link) {
          const rawTemp = path.join(
            path.dirname(outputPath),
            `pexels_raw_${Date.now()}.mp4`,
          );

          pipelineLogger.info(
            `Downloading Pexels video (${chosen.width}x${chosen.height}, ${chosen.duration}s)...`,
            "PexelsService",
          );

          const downloaded = await this.downloadVideoFile(bestFile.link, rawTemp);
          if (downloaded) {
            const formatted = await this.formatBrollClip(
              rawTemp,
              durationSec,
              outputPath,
            );
            try {
              if (fs.existsSync(rawTemp)) fs.unlinkSync(rawTemp);
            } catch (_) {}

            if (formatted) {
              pipelineLogger.checkpoint(
                `✓ Pexels stock video b-roll prepared for "${query}"`,
                true,
                outputPath,
              );
              return outputPath;
            }
          }
        }
      }
    }

    return null;
  }
}
