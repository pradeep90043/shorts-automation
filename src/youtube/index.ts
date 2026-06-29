import { google } from 'googleapis';
import fs from 'fs';
import { VideoMetadata } from '../types';
import { config, YoutubeChannel } from '../config';
import { pipelineLogger } from '../utils/logger';

export interface UploadResult {
  channelName: string;
  url: string;
  videoId: string;
}

export class YouTubeService {

  // Upload to a single channel, returns result or null on failure
  private async uploadToChannel(
    channel: YoutubeChannel,
    videoPath: string,
    metadata: VideoMetadata
  ): Promise<UploadResult | null> {
    const { clientId, clientSecret, redirectUri } = config.youtube;

    if (!clientId || !clientSecret || !channel.refreshToken) {
      pipelineLogger.warn(
        `[${channel.name}] Missing OAuth credentials — skipping (SIMULATED)`,
        'YouTubeService'
      );
      const mockId = `sim-${Date.now()}`;
      return { channelName: channel.name, url: `https://youtube.com/shorts/${mockId}`, videoId: mockId };
    }

    try {
      const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      oauth2.setCredentials({ refresh_token: channel.refreshToken });

      const yt = google.youtube({ version: 'v3', auth: oauth2 });

      const fileSize   = fs.statSync(videoPath).size;
      const mediaStream = fs.createReadStream(videoPath);

      pipelineLogger.info(`[${channel.name}] Starting upload…`, 'YouTubeService');

      const response = await yt.videos.insert(
        {
          part: ['snippet', 'status'],
          requestBody: {
            snippet: {
              title: metadata.title.substring(0, 100),
              description: metadata.description,
              tags: metadata.tags,
              categoryId: '28',
              defaultLanguage: 'en',
            },
            status: {
              privacyStatus: 'public',
              selfDeclaredMadeForKids: false,
            },
          },
          media: { body: mediaStream },
        },
        {
          onUploadProgress: (evt: { bytesRead: number }) => {
            const pct = ((evt.bytesRead / fileSize) * 100).toFixed(0);
            pipelineLogger.info(`[${channel.name}] Upload ${pct}%`, 'YouTubeService');
          },
        }
      );

      const videoId = response.data.id;
      if (!videoId) throw new Error('YouTube did not return a video ID');

      const url = `https://youtube.com/shorts/${videoId}`;
      pipelineLogger.checkpoint(`[${channel.name}] Uploaded`, true, url);
      return { channelName: channel.name, url, videoId };

    } catch (err) {
      pipelineLogger.error(`[${channel.name}] Upload failed`, err, 'YouTubeService');
      return null;
    }
  }

  // Upload to ALL configured channels in parallel
  public async uploadToAllChannels(
    videoPath: string,
    metadata: VideoMetadata
  ): Promise<UploadResult[]> {
    const { channels } = config.youtube;

    if (channels.length === 0) {
      pipelineLogger.warn('No YouTube channels configured — running in SIMULATED mode', 'YouTubeService');
      const mockId = `sim-${Date.now()}`;
      return [{ channelName: 'Simulated', url: `https://youtube.com/shorts/${mockId}`, videoId: mockId }];
    }

    pipelineLogger.info(`Uploading to ${channels.length} channel(s) in parallel…`, 'YouTubeService');

    const results = await Promise.all(
      channels.map(ch => this.uploadToChannel(ch, videoPath, metadata))
    );

    return results.filter((r): r is UploadResult => r !== null);
  }

  // Legacy single-upload shim (keeps old code working)
  public async uploadShort(
    videoPath: string,
    metadata: VideoMetadata
  ): Promise<{ url: string; videoId: string }> {
    const results = await this.uploadToAllChannels(videoPath, metadata);
    if (results.length === 0) throw new Error('All channel uploads failed');
    return { url: results[0].url, videoId: results[0].videoId };
  }
}
