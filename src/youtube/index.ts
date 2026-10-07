import { google } from "googleapis";
import fs from "fs";
import { VideoMetadata } from "../types";
import { config, YoutubeChannel, YoutubeConfig } from "../config";
import { pipelineLogger } from "../utils/logger";

export interface UploadOptions {
  /** upload progress 0..100 (best channel so far) */
  onProgress?: (pct: number) => void;
  /** long-form video: return a /watch URL instead of /shorts */
  isLong?: boolean;
}

/** Abort an upload when no bytes move for this long (a stalled connection would otherwise hang forever). */
const UPLOAD_STALL_MS = 5 * 60 * 1000;

export interface UploadResult {
  channelName: string;
  url: string;
  videoId: string;
}

export class YouTubeService {
  // Per-channel-profile YouTube credentials (defaults to the primary profile)
  private ytConfig: YoutubeConfig;
  /** per-channel failure reasons from the last upload, so callers can report why nothing was published */
  public lastErrors: string[] = [];

  constructor(ytConfig: YoutubeConfig = config.youtube) {
    this.ytConfig = ytConfig;
  }

  // Upload to a single channel, returns result or null on failure
  private async uploadToChannel(
    channel: YoutubeChannel,
    videoPath: string,
    metadata: VideoMetadata,
    opts: UploadOptions = {},
  ): Promise<UploadResult | null> {
    const { clientId, clientSecret, redirectUri } = this.ytConfig;

    if (!clientId || !clientSecret || !channel.refreshToken) {
      // Missing credentials – cannot upload. Throw error to force proper configuration.
      throw new Error('YouTube OAuth credentials or channel refresh token missing. Configure YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and channel refresh tokens in .env.');
    }

    try {
      const oauth2 = new google.auth.OAuth2(
        clientId,
        clientSecret,
        redirectUri,
      );
      oauth2.setCredentials({ refresh_token: channel.refreshToken });

      const yt = google.youtube({ version: "v3", auth: oauth2 });

      const fileSize = fs.statSync(videoPath).size;

      // YouTube rejects angle brackets in titles/descriptions (invalidTitle 400)
      const sanitize = (text: string): string =>
        (text || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
      const safeTitle =
        sanitize(metadata.title).substring(0, 100) || "YouTube Shorts Video";

      let lastErr: any = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          pipelineLogger.info(
            `[${channel.name}] Starting upload (attempt ${attempt}/3)…`,
            "YouTubeService",
          );

          const mediaStream = fs.createReadStream(videoPath);
          const abort = new AbortController();
          let stallTimer = setTimeout(() => abort.abort(), UPLOAD_STALL_MS);
          const poke = () => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => abort.abort(), UPLOAD_STALL_MS);
          };
          // Track last logged milestone to avoid flooding logs with every progress tick
          let lastLoggedPct = -1;

          const response = await yt.videos.insert(
            {
              part: ["snippet", "status"],
              requestBody: {
                snippet: {
                  title: safeTitle,
                  description: (metadata.description || "").replace(/[<>]/g, ""),
                  tags: metadata.tags,
                  categoryId: "28",
                  defaultLanguage: "en",
                },
                status: {
                  privacyStatus: "public",
                  selfDeclaredMadeForKids: false,
                },
              },
              media: { body: mediaStream },
            },
            {
              retry: false, // Handle retries in our loop so a fresh stream is provided
              signal: abort.signal,
              onUploadProgress: (evt: { bytesRead: number }) => {
                poke();
                const pct = Math.floor((evt.bytesRead / fileSize) * 100);
                opts.onProgress?.(Math.min(100, pct));
                // Log only at every 10% milestone to prevent flooding the log
                const milestone = Math.floor(pct / 10) * 10;
                if (milestone > lastLoggedPct) {
                  lastLoggedPct = milestone;
                  pipelineLogger.info(
                    `[${channel.name}] Upload ${milestone}%`,
                    "YouTubeService",
                  );
                }
              },
            },
          ).finally(() => clearTimeout(stallTimer));

          const videoId = response.data.id;
          if (!videoId) throw new Error("YouTube did not return a video ID");

          const isLandscapeOrLong =
            opts.isLong ||
            (metadata.description || "").includes("Produced for") ||
            (metadata.tags || []).includes("guide") ||
            (metadata.tags || []).includes("tutorial");
          const url = isLandscapeOrLong
            ? `https://www.youtube.com/watch?v=${videoId}`
            : `https://youtube.com/shorts/${videoId}`;
          pipelineLogger.checkpoint(`[${channel.name}] Uploaded`, true, url);
          return { channelName: channel.name, url, videoId };
        } catch (err: any) {
          lastErr = err;
          const status = err.status || err.response?.status;
          const isRetryable =
            status === 408 ||
            status === 429 ||
            (status >= 500 && status < 600) ||
            err.code === "ECONNRESET" ||
            err.code === "ETIMEDOUT" ||
            String(err.message || "").includes("timeout");

          if (attempt < 3 && isRetryable) {
            const delayMs = attempt * 5000;
            pipelineLogger.warn(
              `[${channel.name}] Upload attempt ${attempt} failed (${err.message || status}) — retrying in ${delayMs / 1000}s with fresh stream...`,
              "YouTubeService",
            );
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
          break;
        }
      }

      throw lastErr;
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      this.lastErrors.push(`${channel.name}: ${errMsg.slice(0, 300)}`);
      pipelineLogger.error(
        `[${channel.name}] Upload failed: ${errMsg.slice(0, 300)}`,
        err,
        "YouTubeService",
      );
      return null;
    }
  }

  // Upload to ALL configured channels in parallel
  public async uploadToAllChannels(
    videoPath: string,
    metadata: VideoMetadata,
    opts: UploadOptions = {},
  ): Promise<UploadResult[]> {
    const { channels } = this.ytConfig;
    this.lastErrors = [];

    if (channels.length === 0) {
      pipelineLogger.warn(
        "No YouTube channels configured — running in SIMULATED mode",
        "YouTubeService",
      );
      const mockId = `sim-${Date.now()}`;
      return [
        {
          channelName: "Simulated",
          url: `https://youtube.com/shorts/${mockId}`,
          videoId: mockId,
        },
      ];
    }

    pipelineLogger.info(
      `Uploading to ${channels.length} channel(s) in parallel…`,
      "YouTubeService",
    );

    const results = await Promise.all(
      channels.map((ch) => this.uploadToChannel(ch, videoPath, metadata, opts)),
    );

    return results.filter((r): r is UploadResult => r !== null);
  }

  // Legacy single-upload shim (keeps old code working)
  public async uploadShort(
    videoPath: string,
    metadata: VideoMetadata,
  ): Promise<{ url: string; videoId: string }> {
    const results = await this.uploadToAllChannels(videoPath, metadata);
    if (results.length === 0) throw new Error("All channel uploads failed");
    return { url: results[0].url, videoId: results[0].videoId };
  }

  // Delete a video from a configured YouTube channel
  public async deleteFromChannel(
    channelName: string,
    videoId: string,
  ): Promise<boolean> {
    const { clientId, clientSecret, redirectUri } = this.ytConfig;
    const channel = this.ytConfig.channels.find(
      (ch) => ch.name === channelName,
    );

    // Support simulation deletion
    if (
      videoId.startsWith("sim-") ||
      !clientId ||
      !clientSecret ||
      !channel ||
      !channel.refreshToken
    ) {
      pipelineLogger.info(
        `[${channelName}] Simulating video deletion for ID: ${videoId}`,
        "YouTubeService",
      );
      return true;
    }

    try {
      const oauth2 = new google.auth.OAuth2(
        clientId,
        clientSecret,
        redirectUri,
      );
      oauth2.setCredentials({ refresh_token: channel.refreshToken });

      const yt = google.youtube({ version: "v3", auth: oauth2 });

      pipelineLogger.info(
        `[${channelName}] Deleting video ID: ${videoId}…`,
        "YouTubeService",
      );
      await yt.videos.delete({ id: videoId });
      pipelineLogger.checkpoint(
        `[${channelName}] Deleted video ID: ${videoId}`,
        true,
        videoId,
      );
      return true;
    } catch (err) {
      pipelineLogger.error(
        `[${channelName}] Failed to delete video ${videoId}`,
        err,
        "YouTubeService",
      );
      return false;
    }
  }

  /**
   * Fetch statistics (views, likes, comments) for a YouTube video.
   * Runs actual YouTube list query or returns simulated statistics in test modes.
   */
  public async getVideoMetrics(
    channelName: string,
    videoId: string,
  ): Promise<{ views: number; likes: number; comments: number } | null> {
    const { clientId, clientSecret, redirectUri } = this.ytConfig;
    const channel = this.ytConfig.channels.find(
      (ch) => ch.name === channelName,
    );

    if (
      videoId.startsWith("sim-") ||
      !clientId ||
      !clientSecret ||
      !channel ||
      !channel.refreshToken
    ) {
      // Simulation mode fallback
      const fakeViews = Math.floor(Math.random() * 4500) + 100;
      return {
        views: fakeViews,
        likes: Math.floor(fakeViews * 0.07),
        comments: Math.floor(fakeViews * 0.008),
      };
    }

    try {
      const oauth2 = new google.auth.OAuth2(
        clientId,
        clientSecret,
        redirectUri,
      );
      oauth2.setCredentials({ refresh_token: channel.refreshToken });

      const yt = google.youtube({ version: "v3", auth: oauth2 });
      const response = await yt.videos.list({
        id: [videoId],
        part: ["statistics"],
      });

      const stats = response.data.items?.[0]?.statistics;
      if (!stats) return null;

      return {
        views: parseInt(stats.viewCount || "0", 10),
        likes: parseInt(stats.likeCount || "0", 10),
        comments: parseInt(stats.commentCount || "0", 10),
      };
    } catch (err) {
      pipelineLogger.error(
        `[${channelName}] Failed to fetch metrics for video ${videoId}`,
        err,
        "YouTubeService",
      );
      return null;
    }
  }
}
