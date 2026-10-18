// src/test/pipeline_reel_test.ts
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { DirectUploader } from '../direct-uploader';
import { AssetKind, PipelineContext } from '../types';
import { UploadResult } from '../youtube';

// -------------------------------------------------------------------
// Mock NotifyService – logs instead of sending anything to Telegram
// -------------------------------------------------------------------
class MockNotifyService {
  async sendVideoForReview(chatId: number, videoPath: string, caption: string, id: string, _replyToMessageId?: number): Promise<number> {
    console.log('[MOCK] sendVideoForReview', { chatId, videoPath, caption, id });
    return 1;
  }
  async sendRawVideo(chatId: number, videoPath: string, caption: string): Promise<number> {
    console.log('[MOCK] sendRawVideo', { chatId, videoPath, caption });
    return 2;
  }
  async sendSuccessMessageWithRevoke(chatId: number, text: string, id: string, _replyToMessageId?: number): Promise<number> {
    console.log('[MOCK] sendSuccessMessageWithRevoke', { chatId, text, id });
    return 3;
  }
  async sendMessage(chatId: number, text: string, _replyToMessageId?: number): Promise<void> {
    console.log('[MOCK] sendMessage', { chatId, text });
  }
  async deleteMessage(_: number, __: number): Promise<void> {}
  async removeInlineButtons(_: number, __: number): Promise<void> {}
  async sendSettingsReview(chatId: number, text: string, id: string, _settings: any, _replyToMessageId?: number): Promise<number> {
    console.log('[MOCK] sendSettingsReview', { chatId, text, id });
    return 4;
  }
  async updateSettingsReview(_: number, __: number, ___: string, ____: string, _____: any): Promise<void> {}
  registerReviewCallback(_: any) {}
  registerRevokeCallback(_: any) {}
  registerSettingsReviewCallback(_: any) {}
  registerAudioUploadCallback(_: any) {}
  registerTextPromptCallback(_: any) {}
  registerApprovalTrigger(_: any) {}
  registerPipelineTrigger(_: any) {}
}

// -------------------------------------------------------------------
// Mock YouTubeService – returns a dummy upload result
// -------------------------------------------------------------------
class MockYouTubeService {
  async uploadToAllChannels(videoPath: string, metadata: any): Promise<UploadResult[]> {
    console.log('[MOCK] uploadToAllChannels', { videoPath, metadata });
    return [{ channelName: 'MockChannel', url: 'https://youtube.com/mockvideo', videoId: 'mock123' }];
  }
}

// Helper to create a dummy Reel context
function createFakeContext(tempDir: string, dummyVideoPath: string): PipelineContext {
  return {
    id: 'reel-test-001',
    tempDir,
    sourceMeta: {
      messageId: 0,
      chatId: 12345,
      userId: 999,
      username: 'tester',
      firstName: 'Test',
      timestamp: Math.floor(Date.now() / 1000),
      fileId: '',
    },
    originalImagePath: '',
    originalVideoPath: dummyVideoPath,
    isVideo: true,
    status: 'received',
    instagramSource: false,
    instagramSourceType: 'video',
    assetKind: AssetKind.Reel,
  };
}

(async () => {
  console.log('=== Starting Reel pipeline dry‑run test ===');

  const tempDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const dummyVideo = path.join(tempDir, 'dummy_reel.mp4');
  if (!fs.existsSync(dummyVideo)) {
    console.log('[MOCK] Generating dummy video...');
    execSync(`ffmpeg -f lavfi -i color=c=black:s=640x360:d=1 -c:v libx264 -pix_fmt yuv420p "${dummyVideo}"`);
  }

  const mockTelegram = new MockNotifyService();
  const uploader = new DirectUploader(mockTelegram as any);
  // Replace YouTube service with mock
  (uploader as any).youtube = new MockYouTubeService();

  const pendingId = 'reel-test-001';
  const pending = {
    id: pendingId,
    chatId: 12345,
    messageId: 0,
    reviewMessageId: 0,
    metadata: { title: 'Test Reel Title', description: 'Test Reel Description', tags: ['test'] },
    finalVideoPath: dummyVideo,
    outputFilePath: dummyVideo,
    outputFileName: 'dummy_reel.mp4',
    originalImagePath: '',
    timer: setTimeout(() => {}, 0),
    context: createFakeContext(tempDir, dummyVideo),
  } as any;

  // Insert into private pending map
  (uploader as any).pending.set(pendingId, pending);

  // Run the full uploadAndReport flow (private method) for the test
  // @ts-ignore – accessing private method for testing purposes
  await uploader.uploadAndReport(pending);

  console.log('=== Reel pipeline test finished ===');
})();
