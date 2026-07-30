import fs from "fs";
import { FacebookConfig } from "../config";
import { pipelineLogger } from "../utils/logger";
import { VideoMetadata } from "../types";

export interface FacebookUploadResult {
  pageName: string;
  url: string;
  videoId: string;
}

export class FacebookPublisher {
  private pageConfig: FacebookConfig | null = null;
  private brandName: string;

  constructor(brandName: string, pageConfig: FacebookConfig | null = null) {
    this.brandName = brandName;
    this.pageConfig = pageConfig;
  }

  public async uploadReel(
    videoPath: string,
    metadata: VideoMetadata,
  ): Promise<FacebookUploadResult | null> {
    const config = this.pageConfig;
    if (!config || !config.accessToken || !config.pageId) {
      pipelineLogger.warn(
        `[${this.brandName}] Facebook Page is not configured — running in SIMULATED mode`,
        "FacebookPublisher",
      );
      // Simulate upload
      await new Promise((r) => setTimeout(r, 2000));
      return {
        pageName: `${this.brandName} Simulated FB Page`,
        url: "https://facebook.com/watch/?v=simulated_fb_id",
        videoId: "simulated_fb_id",
      };
    }

    const MAX_UPLOAD_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
      try {
        pipelineLogger.info(
          `[${this.brandName}] Starting Facebook Reel upload to Page ${config.pageId} (Attempt ${attempt}/${MAX_UPLOAD_ATTEMPTS})...`,
          "FacebookPublisher",
        );

        const API_VERSION = "v21.0";
        const token = config.accessToken;
        const pageId = config.pageId;

        // Prepare caption with hashtags
        const captionText = `${metadata.title}\n\n${metadata.description}\n\n${metadata.tags.map(t => '#' + t.replace(/\s+/g, '')).join(' ')}`;

        // Step 1: Initialize Resumable Upload Session
        pipelineLogger.info(`[${this.brandName}] Initializing Facebook Reel container...`, "FacebookPublisher");
        const initRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${pageId}/video_reels?access_token=${token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            upload_phase: 'start',
          })
        });

        const initData = (await initRes.json()) as any;
        if (!initRes.ok || !initData.video_id || !initData.upload_url) {
          throw new Error(`Failed to initialize Facebook container: ${JSON.stringify(initData)}`);
        }

        const videoId = initData.video_id;
        const uploadUrl = initData.upload_url;

        // Step 2: Upload Binary Data
        pipelineLogger.info(`[${this.brandName}] Uploading video binary to Facebook...`, "FacebookPublisher");
        const fileStats = fs.statSync(videoPath);
        const fileBuffer = fs.readFileSync(videoPath);

        const uploadRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'Authorization': `OAuth ${token}`,
            'offset': '0',
            'file_size': fileStats.size.toString(),
            'Content-Type': 'application/octet-stream',
            'Content-Length': fileStats.size.toString(),
          },
          body: fileBuffer
        });

        const uploadData = await uploadRes.text();
        if (!uploadRes.ok) {
          throw new Error(`Failed to upload binary data to Facebook: ${uploadData}`);
        }

        // Step 3: Finish and Publish
        pipelineLogger.info(`[${this.brandName}] Finalizing Facebook Reel publish...`, "FacebookPublisher");
        const publishRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${pageId}/video_reels?access_token=${token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            upload_phase: 'finish',
            video_id: videoId,
            video_state: 'PUBLISHED',
            description: captionText,
          })
        });

        const publishData = (await publishRes.json()) as any;
        if (!publishRes.ok || !publishData.success) {
          throw new Error(`Failed to publish Facebook Reel: ${JSON.stringify(publishData)}`);
        }

        const url = `https://www.facebook.com/watch/?v=${videoId}`;
        pipelineLogger.checkpoint(`[${this.brandName}] Uploaded to Facebook`, true, url);
        return { pageName: this.brandName, url, videoId };

      } catch (err) {
        pipelineLogger.warn(
          `[${this.brandName}] Facebook upload attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`,
          "FacebookPublisher"
        );
        if (attempt < MAX_UPLOAD_ATTEMPTS) {
          const delay = 10000;
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          pipelineLogger.error(
            `[${this.brandName}] Facebook upload failed after ${MAX_UPLOAD_ATTEMPTS} attempts`,
            err,
            "FacebookPublisher",
          );
        }
      }
    }
    return null;
  }
}
