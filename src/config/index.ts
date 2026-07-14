import dotenv from "dotenv";
import path from "path";
import { ContentTheme, CONTENT_THEMES } from "./themes";

// Load environmental variables
dotenv.config();

export { ContentTheme, CONTENT_THEMES } from "./themes";

export interface YoutubeChannel {
  name: string;
  refreshToken: string;
}

export interface InstagramAccount {
  name: string;
  accessToken: string;
  igUserId: string;
}

export interface YoutubeConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  channels: YoutubeChannel[]; // one entry per channel
}

// A full brand/channel profile: one Telegram bot + its own YouTube/Instagram credentials.
// The primary profile comes from the classic env vars (TELEGRAM_BOT_TOKEN, YOUTUBE_*, INSTAGRAM_*).
// Extra profiles are auto-detected from prefixed vars, e.g. STORIYUM_TELEGRAM_BOT_TOKEN_LOCAL,
// STORIYUM_YOUTUBE_REFRESH_TOKEN, STORIYUM_INSTAGRAM_ACCESS_TOKEN, ...
export interface ChannelProfile {
  key: string; // short id, e.g. "codeorcap", "storiyum"
  brandName: string; // used in AI prompts, e.g. "CodeOrCap"
  handle: string; // social handle used on branding overlays, e.g. "@codeorcap"
  theme: ContentTheme; // niche-specific prompt fragments (NICHE / <PREFIX>_NICHE env)
  isDefault: boolean;
  telegramToken: string;
  youtube: YoutubeConfig;
  instagram: {
    accounts: InstagramAccount[];
  };
}

export interface AppConfig {
  telegramToken: string;
  youtube: YoutubeConfig;
  instagram: {
    accounts: InstagramAccount[];
  };
  profiles: ChannelProfile[];
  ai: {
    provider: "claude" | "antigravity" | "freellmapi" | "mock";
    claudePath: string;
    antigravityPath: string;

    freellmapiUrl: string;
    freellmapiKey: string;
    freellmapiModel: string;
    freellmapiVisionModel: string;
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
  binaries: {
    ffmpeg: string;
    ffprobe: string;
    ytdlp: string;
    python3: string;
    chrome: string;
    fpcalc: string;
  };
  copyright: {
    enabled: boolean;
    acoustidApiKey: string;
  };
}

const rootDir = path.resolve(__dirname, "../../");

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
    channels.push({
      name: "Channel 1",
      refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
    });
  }
  return channels;
}

function loadInstagramAccounts(): InstagramAccount[] {
  const accounts: InstagramAccount[] = [];
  for (let i = 1; i <= 10; i++) {
    const token = process.env[`INSTAGRAM_ACCOUNT_${i}_ACCESS_TOKEN`];
    const userId = process.env[`INSTAGRAM_ACCOUNT_${i}_USER_ID`];
    if (!token || !userId) break;
    const name = process.env[`INSTAGRAM_ACCOUNT_${i}_NAME`] || `Instagram ${i}`;
    accounts.push({ name, accessToken: token, igUserId: userId });
  }
  // Also support the legacy single-account token
  if (accounts.length === 0 && process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_USER_ID) {
    accounts.push({
      name: "Instagram 1",
      accessToken: process.env.INSTAGRAM_ACCESS_TOKEN,
      igUserId: process.env.INSTAGRAM_USER_ID,
    });
  }
  return accounts;
}

// ── Multi-channel profiles ────────────────────────────────────────────────────
// BOT_ENV selects between <PREFIX>_TELEGRAM_BOT_TOKEN_LOCAL and _PROD (default: local)
const BOT_ENV = (process.env.BOT_ENV || "local").toUpperCase();

function titleCase(prefix: string): string {
  return prefix.charAt(0) + prefix.slice(1).toLowerCase();
}

// Resolve a content theme from a NICHE env value; unknown/missing values fall back to "tech"
function resolveTheme(nicheEnv: string | undefined, label: string): ContentTheme {
  const niche = (nicheEnv || "tech").toLowerCase();
  const theme = CONTENT_THEMES[niche];
  if (!theme) {
    console.warn(
      `Warning: [${label}] Unknown NICHE "${nicheEnv}". Valid values: ${Object.keys(CONTENT_THEMES).join(", ")}. Falling back to "tech".`,
    );
    return CONTENT_THEMES.tech;
  }
  return theme;
}

function loadPrefixedYoutube(prefix: string, brandName: string): YoutubeConfig {
  const env = (key: string) => process.env[`${prefix}_${key}`];

  const channels: YoutubeChannel[] = [];
  for (let i = 1; i <= 10; i++) {
    const token = env(`YOUTUBE_CHANNEL_${i}_REFRESH_TOKEN`);
    if (!token) break;
    channels.push({
      name: env(`YOUTUBE_CHANNEL_${i}_NAME`) || `${brandName} ${i}`,
      refreshToken: token,
    });
  }
  if (channels.length === 0 && env("YOUTUBE_REFRESH_TOKEN")) {
    channels.push({
      name: brandName,
      refreshToken: env("YOUTUBE_REFRESH_TOKEN")!,
    });
  }

  return {
    // Fall back to the shared OAuth app if the profile doesn't have its own
    clientId: env("YOUTUBE_CLIENT_ID") || process.env.YOUTUBE_CLIENT_ID || "",
    clientSecret:
      env("YOUTUBE_CLIENT_SECRET") || process.env.YOUTUBE_CLIENT_SECRET || "",
    redirectUri:
      env("YOUTUBE_REDIRECT_URI") ||
      process.env.YOUTUBE_REDIRECT_URI ||
      "http://localhost:3000/oauth2callback",
    channels,
  };
}

function loadPrefixedInstagram(
  prefix: string,
  brandName: string,
): InstagramAccount[] {
  const env = (key: string) => process.env[`${prefix}_${key}`];
  const accounts: InstagramAccount[] = [];
  for (let i = 1; i <= 10; i++) {
    const token = env(`INSTAGRAM_ACCOUNT_${i}_ACCESS_TOKEN`);
    const userId = env(`INSTAGRAM_ACCOUNT_${i}_USER_ID`);
    if (!token || !userId) break;
    accounts.push({
      name: env(`INSTAGRAM_ACCOUNT_${i}_NAME`) || `${brandName} IG ${i}`,
      accessToken: token,
      igUserId: userId,
    });
  }
  if (
    accounts.length === 0 &&
    env("INSTAGRAM_ACCESS_TOKEN") &&
    env("INSTAGRAM_USER_ID")
  ) {
    accounts.push({
      name: `${brandName} Instagram`,
      accessToken: env("INSTAGRAM_ACCESS_TOKEN")!,
      igUserId: env("INSTAGRAM_USER_ID")!,
    });
  }
  return accounts;
}

// Detect extra channel prefixes from env vars like STORIYUM_TELEGRAM_BOT_TOKEN[_LOCAL|_PROD]
function loadExtraProfiles(): ChannelProfile[] {
  const prefixes = new Set<string>();
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^([A-Z0-9]+)_TELEGRAM_BOT_TOKEN(?:_LOCAL|_PROD)?$/);
    if (m) prefixes.add(m[1]);
  }

  const profiles: ChannelProfile[] = [];
  for (const prefix of prefixes) {
    const env = (key: string) => process.env[`${prefix}_${key}`];
    const telegramToken =
      env(`TELEGRAM_BOT_TOKEN_${BOT_ENV}`) ||
      env("TELEGRAM_BOT_TOKEN") ||
      env("TELEGRAM_BOT_TOKEN_LOCAL") ||
      env("TELEGRAM_BOT_TOKEN_PROD") ||
      "";
    if (!telegramToken) continue;

    const brandName = env("BRAND_NAME") || titleCase(prefix);
    profiles.push({
      key: prefix.toLowerCase(),
      brandName,
      handle: env("BRAND_HANDLE") || `@${prefix.toLowerCase()}`,
      theme: resolveTheme(env("NICHE"), brandName),
      isDefault: false,
      telegramToken,
      youtube: loadPrefixedYoutube(prefix, brandName),
      instagram: { accounts: loadPrefixedInstagram(prefix, brandName) },
    });
  }
  return profiles;
}

function loadPrimaryProfile(): ChannelProfile {
  return {
    key: "codeorcap",
    brandName: process.env.BRAND_NAME || "CodeOrCap",
    handle: process.env.BRAND_HANDLE || "@codeorcap",
    theme: resolveTheme(process.env.NICHE, "primary profile"),
    isDefault: true,
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    youtube: {
      clientId: process.env.YOUTUBE_CLIENT_ID || "",
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET || "",
      redirectUri:
        process.env.YOUTUBE_REDIRECT_URI ||
        "http://localhost:3000/oauth2callback",
      channels: loadChannels(),
    },
    instagram: {
      accounts: loadInstagramAccounts(),
    },
  };
}

const primaryProfile = loadPrimaryProfile();

export const config: AppConfig = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  youtube: primaryProfile.youtube,
  instagram: primaryProfile.instagram,
  profiles: [primaryProfile, ...loadExtraProfiles()].filter(
    (p) => p.telegramToken,
  ),
  ai: {
    provider: (process.env.AI_PROVIDER || "mock") as
      | "claude"
      | "antigravity"
      | "freellmapi"
      | "mock",
    claudePath: process.env.CLAUDE_CLI_PATH || "claude",
    antigravityPath: process.env.ANTIGRAVITY_CLI_PATH || "agy",

    freellmapiUrl: process.env.FREELLMAPI_URL || "http://localhost:3001",
    freellmapiKey: process.env.FREELLMAPI_KEY || "",
    freellmapiModel: process.env.FREELLMAPI_MODEL || "auto",
    freellmapiVisionModel: process.env.FREELLMAPI_VISION_MODEL || "auto",
  },
  paths: {
    assetsDir: process.env.ASSETS_DIR
      ? path.resolve(rootDir, process.env.ASSETS_DIR)
      : path.resolve(rootDir, "assets"),
    musicDir: process.env.MUSIC_DIR
      ? path.resolve(rootDir, process.env.MUSIC_DIR)
      : path.resolve(rootDir, "assets/music"),
    tempDir: process.env.TEMP_DIR
      ? path.resolve(rootDir, process.env.TEMP_DIR)
      : path.resolve(rootDir, "temp"),
    outputDir: process.env.OUTPUT_DIR
      ? path.resolve(rootDir, process.env.OUTPUT_DIR)
      : path.resolve(rootDir, "output"),
    logDir: process.env.LOG_DIR
      ? path.resolve(rootDir, process.env.LOG_DIR)
      : path.resolve(rootDir, "logs"),
  },
  rendering: {
    videoDurationSeconds: parseInt(
      process.env.VIDEO_DURATION_SECONDS || "15",
      10,
    ),
    fps: parseInt(process.env.VIDEO_FPS || "30", 10),
    musicVolume: parseFloat(process.env.MUSIC_VOLUME || "0.15"),
    musicStartOffset: parseInt(process.env.MUSIC_START_OFFSET || "20", 10),
    beautifyCode: process.env.BEAUTIFY_CODE !== "false",
  },
  binaries: {
    ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
    ffprobe: process.env.FFPROBE_PATH || "ffprobe",
    ytdlp: process.env.YTDLP_PATH || "yt-dlp",
    python3: process.env.PYTHON_PATH || "python3",
    chrome:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    fpcalc: process.env.FPCALC_PATH || "fpcalc",
  },
  copyright: {
    enabled: process.env.COPYRIGHT_CHECK_ENABLED !== "false",
    acoustidApiKey: process.env.ACOUSTID_API_KEY || "",
  },
};

// Simple configuration checker
export function validateConfig(): void {
  const warnings: string[] = [];

  if (config.profiles.length === 0) {
    warnings.push(
      "Warning: No Telegram bot tokens configured (TELEGRAM_BOT_TOKEN or <PREFIX>_TELEGRAM_BOT_TOKEN_*). Bot will fail to start.",
    );
  }

  for (const p of config.profiles) {
    if (!p.youtube.clientId || p.youtube.channels.length === 0) {
      warnings.push(
        `Warning: [${p.brandName}] YouTube API credentials are not fully configured. Upload will fall back to simulation mode.`,
      );
    }
    if (p.instagram.accounts.length === 0) {
      warnings.push(
        `Warning: [${p.brandName}] No Instagram account configured. Instagram upload will be simulated.`,
      );
    }
  }

  if (
    config.ai.provider !== "mock" &&
    !process.env.CLAUDE_CLI_PATH &&
    !process.env.ANTIGRAVITY_CLI_PATH
  ) {
    warnings.push(
      `Warning: AI_PROVIDER is set to '${config.ai.provider}' but its CLI path is not set. It will try to use the binary in PATH.`,
    );
  }

  if (config.copyright.enabled && !config.copyright.acoustidApiKey) {
    warnings.push(
      "Warning: ACOUSTID_API_KEY is not set. Music copyright risk will show as 'unverified'. Get a free key at https://acoustid.org/new-application",
    );
  }

  if (warnings.length > 0) {
    console.warn("\n--- CONFIGURATION WARNINGS ---");
    warnings.forEach((w) => console.warn(w));
    console.warn("------------------------------\n");
  }
}
