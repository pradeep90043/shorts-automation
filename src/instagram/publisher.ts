import fs from "fs";
import { config, InstagramAccount } from "../config";
import { pipelineLogger } from "../utils/logger";
import { VideoMetadata } from "../types";

export interface InstagramUploadResult {
  accountName: string;
  url: string;
  mediaId: string;
}

export class InstagramPublisher {
  // Per-channel-profile Instagram accounts (defaults to the primary profile)
  private accounts: InstagramAccount[];

  constructor(accounts: InstagramAccount[] = config.instagram.accounts) {
    this.accounts = accounts;
  }

  private async uploadToAccount(
    account: InstagramAccount,
    videoPath: string,
    metadata: VideoMetadata,
  ): Promise<InstagramUploadResult | null> {
    if (!account.accessToken || !account.igUserId) {
      pipelineLogger.error(
        `[${account.name}] Missing Instagram credentials`,
        "InstagramPublisher",
      );
      return null;
    }

    const MAX_UPLOAD_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
      try {
        pipelineLogger.info(
          `[${account.name}] Starting Instagram Reel upload (Attempt ${attempt}/${MAX_UPLOAD_ATTEMPTS})...`,
          "InstagramPublisher",
        );

        const API_VERSION = "v21.0";
        const token = account.accessToken;
        const igUserId = account.igUserId;

        // Prepare caption with hashtags
        const captionText = `${metadata.title}\n\n${metadata.description}\n\n${metadata.tags.map(t => '#' + t.replace(/\s+/g, '')).join(' ')}`;

        // Step 1: Initialize Resumable Upload Container
        pipelineLogger.info(`[${account.name}] Initializing upload container...`, "InstagramPublisher");
        const initRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${igUserId}/media?access_token=${token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            media_type: 'REELS',
            upload_type: 'resumable',
            caption: captionText,
          })
        });
        
        const initData = (await initRes.json()) as any;
        if (!initRes.ok || !initData.id || !initData.uri) {
          throw new Error(`Failed to initialize container: ${JSON.stringify(initData)}`);
        }
        
        const containerId = initData.id;
        const ruploadUri = initData.uri;

        // Step 2: Upload Binary Data
        pipelineLogger.info(`[${account.name}] Uploading video binary to container ${containerId}...`, "InstagramPublisher");
        const fileStats = fs.statSync(videoPath);
        const fileBuffer = fs.readFileSync(videoPath);

        const uploadRes = await fetch(ruploadUri, {
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
          throw new Error(`Failed to upload binary data: ${uploadData}`);
        }

        // Step 3: Poll Container Status
        pipelineLogger.info(`[${account.name}] Waiting for Instagram to process the video...`, "InstagramPublisher");
        let isReady = false;
        let retries = 0;
        const MAX_RETRIES = 30; // 30 * 5s = 150 seconds max wait
        
        while (!isReady && retries < MAX_RETRIES) {
          const statusRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${containerId}?fields=status_code&access_token=${token}`);
          const statusData = (await statusRes.json()) as any;
          
          if (statusData.status_code === 'FINISHED') {
            isReady = true;
            break;
          } else if (statusData.status_code === 'ERROR') {
            throw new Error(`Instagram processing error on container ${containerId}: ${JSON.stringify(statusData)}`);
          }
          
          retries++;
          await new Promise(resolve => setTimeout(resolve, 5000));
        }

        if (!isReady) {
          throw new Error("Timed out waiting for Instagram to process the video container.");
        }

        // Step 4: Publish Container
        pipelineLogger.info(`[${account.name}] Publishing Reel...`, "InstagramPublisher");
        const publishRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${igUserId}/media_publish?access_token=${token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            creation_id: containerId
          })
        });

        const publishData = (await publishRes.json()) as any;
        if (!publishRes.ok || !publishData.id) {
          throw new Error(`Failed to publish media: ${JSON.stringify(publishData)}`);
        }

        const mediaId = publishData.id;
        // Get the shortcode to generate a URL
        const mediaRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${mediaId}?fields=shortcode&access_token=${token}`);
        const mediaData = (await mediaRes.json()) as any;
        
        let url = "";
        if (mediaData.shortcode) {
          url = `https://instagram.com/reel/${mediaData.shortcode}/`;
        } else {
          url = `https://instagram.com/p/${mediaId}/`;
        }

        pipelineLogger.checkpoint(`[${account.name}] Uploaded to Instagram`, true, url);
        return { accountName: account.name, url, mediaId };

      } catch (err) {
        pipelineLogger.warn(
          `[${account.name}] Instagram upload attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`,
          "InstagramPublisher"
        );
        if (attempt < MAX_UPLOAD_ATTEMPTS) {
          const delay = 10000; // 10s wait before retry
          pipelineLogger.info(`[${account.name}] Waiting ${delay / 1000}s before retrying...`, "InstagramPublisher");
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          pipelineLogger.error(
            `[${account.name}] Instagram upload failed after ${MAX_UPLOAD_ATTEMPTS} attempts`,
            err,
            "InstagramPublisher",
          );
        }
      }
    }
    return null;
  }

  public async uploadToAllAccounts(
    videoPath: string,
    metadata: VideoMetadata,
  ): Promise<InstagramUploadResult[]> {
    const accounts = this.accounts;

    if (accounts.length === 0) {
      pipelineLogger.warn(
        "No Instagram accounts configured — running in SIMULATED mode",
        "InstagramPublisher",
      );
      // Simulate upload
      await new Promise((r) => setTimeout(r, 2000));
      return [
        {
          accountName: "Simulated Instagram",
          url: "https://instagram.com/reel/simulated/",
          mediaId: "simulated_id",
        },
      ];
    }

    const promises = accounts.map((account) =>
      this.uploadToAccount(account, videoPath, metadata),
    );
    const results = await Promise.all(promises);

    return results.filter((r): r is InstagramUploadResult => r !== null);
  }
}
