import dotenv from 'dotenv';
import path from 'path';

// Load environmental variables
dotenv.config();

export interface YoutubeChannel {
  name: string;
  refreshToken: string;
}

export interface AppConfig {
  telegramToken: string;
  youtube: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    channels: YoutubeChannel[];   // one entry per channel
  };
  ai: {
    provider: 'claude' | 'antigravity' | 'gemini' | 'mock';
    claudePath: string;
    antigravityPath: string;
    geminiApiKey: string;
  };
  paths: {
    assetsDir: string;
    musicDir: string;
    tempDir: string;
    outputDir: string;
    logDir: string;
  };
  rendering: {
    videoDurationSeconds: number;
    fps: number;
    musicVolume: number;
    musicStartOffset: number;
    beautifyCode: boolean;
  };
}

const rootDir = path.resolve(__dirname, '../../');

// Collect all YOUTUBE_CHANNEL_N_REFRESH_TOKEN entries from env
function loadChannels(): YoutubeChannel[] {
  const channels: YoutubeChannel[] = [];
  for (let i = 1; i <= 10; i++) {
    const token = process.env[`YOUTUBE_CHANNEL_${i}_REFRESH_TOKEN`];
    if (!token) break;
    const name = process.env[`YOUTUBE_CHANNEL_${i}_NAME`] || `Channel ${i}`;
    channels.push({ name, refreshToken: token });
  }
  // Also support the legacy single-channel token
  if (channels.length === 0 && process.env.YOUTUBE_REFRESH_TOKEN) {
    channels.push({ name: 'Channel 1', refreshToken: process.env.YOUTUBE_REFRESH_TOKEN });
  }
  return channels;
}

export const config: AppConfig = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  youtube: {
    clientId: process.env.YOUTUBE_CLIENT_ID || '',
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || '',
    redirectUri: process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3000/oauth2callback',
    channels: loadChannels(),
  },
  ai: {
    provider: (process.env.AI_PROVIDER || 'mock') as 'claude' | 'antigravity' | 'gemini' | 'mock',
    claudePath: process.env.CLAUDE_CLI_PATH || 'claude',
    antigravityPath: process.env.ANTIGRAVITY_CLI_PATH || 'agy',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
  },
  paths: {
    assetsDir: process.env.ASSETS_DIR 
      ? path.resolve(rootDir, process.env.ASSETS_DIR) 
      : path.resolve(rootDir, 'assets'),
    musicDir: process.env.MUSIC_DIR 
      ? path.resolve(rootDir, process.env.MUSIC_DIR) 
      : path.resolve(rootDir, 'assets/music'),
    tempDir: process.env.TEMP_DIR 
      ? path.resolve(rootDir, process.env.TEMP_DIR) 
      : path.resolve(rootDir, 'temp'),
    outputDir: process.env.OUTPUT_DIR 
      ? path.resolve(rootDir, process.env.OUTPUT_DIR) 
      : path.resolve(rootDir, 'output'),
    logDir: process.env.LOG_DIR 
      ? path.resolve(rootDir, process.env.LOG_DIR) 
      : path.resolve(rootDir, 'logs'),
  },
  rendering: {
    videoDurationSeconds: parseInt(process.env.VIDEO_DURATION_SECONDS || '15', 10),
    fps: parseInt(process.env.VIDEO_FPS || '30', 10),
    musicVolume: parseFloat(process.env.MUSIC_VOLUME || '0.15'),
    musicStartOffset: parseInt(process.env.MUSIC_START_OFFSET || '20', 10),
    beautifyCode: process.env.BEAUTIFY_CODE !== 'false',
  }
};

// Simple configuration checker
export function validateConfig(): void {
  const warnings: string[] = [];
  
  if (!config.telegramToken) {
    warnings.push('Warning: TELEGRAM_BOT_TOKEN is not configured. Bot will fail to start.');
  }
  
  if (!config.youtube.clientId || config.youtube.channels.length === 0) {
    warnings.push('Warning: YouTube API credentials are not fully configured. Upload will fall back to simulation mode.');
  }

  if (config.ai.provider !== 'mock' && !process.env.CLAUDE_CLI_PATH && !process.env.ANTIGRAVITY_CLI_PATH) {
    warnings.push(`Warning: AI_PROVIDER is set to '${config.ai.provider}' but its CLI path is not set. It will try to use the binary in PATH.`);
  }

  if (warnings.length > 0) {
    console.warn('\n--- CONFIGURATION WARNINGS ---');
    warnings.forEach(w => console.warn(w));
    console.warn('------------------------------\n');
  }
}
