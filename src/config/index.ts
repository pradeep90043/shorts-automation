import dotenv from "dotenv";
import os from "os";
import path from "path";
import fs from "fs";
import { ContentTheme, CONTENT_THEMES, createCustomTheme } from "./themes";

// Load environmental variables
dotenv.config();

export { ContentTheme, CONTENT_THEMES, createCustomTheme } from "./themes";

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

// Recurring Instagram-channel-watch automation: pick a random batch of
// not-yet-processed reels from a pool of watched accounts once a day and
// auto-publish them spaced apart, with no manual URL pasting required.
export interface WatchConfig {
  channels: string[]; // Instagram usernames (no leading @), lowercase
  dailyCount: number; // how many reels to pick per day, across all channels combined
  scheduleTime: string; // "HH:MM" 24h, local time — when the daily batch is selected
  gapHours: number; // spacing between each of the day's picks being published
  adminChatId: number; // Telegram chat that receives the auto-published results; 0 = feature disabled
  // Niche + viral search (optional — defaults to 'hashtags' mode)
  searchMode: "channels" | "hashtags" | "both"; // default: 'hashtags'
  nicheHashtags?: string[]; // override auto-generated hashtags from niche/mood mapping
  moodFilter?: string[]; // preferred moods as a hint to the AI metadata prompt
  viralThreshold: number; // 0-100 minimum viral score to include (default: 50, fail-open)
  excludeChannels?: string[]; // list of channels to ignore/exclude
  outroVersion?: "v1" | "v2"; // Outro version: v1 (old) or v2 (with middle transition clip)
}

export interface FacebookConfig {
  pageId: string;
  accessToken: string;
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
  isWatchOnly?: boolean;
  igFollowers?: number;
  ytSubscribers?: number;
  youtube: YoutubeConfig;
  instagram: {
    accounts: InstagramAccount[];
  };
  facebook?: FacebookConfig;
  watch: WatchConfig;
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

    geminiApiKey: string; // fallback AI provider used only when FreeLLMAPI fails
    pexelsApiKey: string; // Pexels / MoneyPrinterTurbo stock video b-roll API key
  };
  paths: {
    assetsDir: string;
    musicDir: string;
    tempDir: string;
    outputDir: string;
    logDir: string;
    /** Persistent data dir outside the project — survives fresh clones/deployments. */
    dataDir: string;
  };
  rendering: {
    videoDurationSeconds: number;
    fps: number;
    musicVolume: number;
    musicStartOffset: number;
    /** Background music from the library. OFF by default: videos carry voice only (Content ID claims). */
    backgroundMusicEnabled: boolean;
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
  /** Final pre-publish gate: strip any recognisable music still in the video's audio. */
  audioClearance: {
    enabled: boolean;
  };
  instagramScraper: {
    /**
     * "session_only" (default): the server never performs a username/password
     * login — only the sessionid cookie / persisted device settings are used.
     * A password login from a datacenter IP reliably trips an Instagram
     * challenge that can lock the account, so when the cookie dies we alert an
     * admin instead of thrashing. Set INSTAGRAM_LOGIN_MODE=full to re-enable
     * password fallback (only safe behind a residential IP / proxy).
     */
    /**
     * When true (or LOGIN_FREE_MODE=true / INSTAGRAM_LOGIN_MODE=login_free),
     * bypasses Instagram login/sessions entirely and uses public search-engine
     * discovery to find viral reels. Zero cookies/credentials required.
     */
    loginFreeMode: boolean;
    sessionOnly: boolean;
    /** Delay between polling consecutive channels during batch selection (ms). */
    interChannelDelayMs: number;
    /** How long a profile pauses ingestion after a 429 (ms). */
    rateLimitCooldownMs: number;
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

// Resolve a content theme from a NICHE env value; supports pre-defined or arbitrary custom niches
export function resolveTheme(nicheEnv: string | undefined, label: string): ContentTheme {
  const niche = (nicheEnv || "tech").toLowerCase().trim();
  const theme = CONTENT_THEMES[niche];
  if (theme) return theme;
  return createCustomTheme(niche, label);
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

// Shared by both the primary profile (unprefixed WATCH_*) and extra profiles
// (<PREFIX>_WATCH_*). An empty channel list leaves the feature disabled.
function loadWatchConfig(prefix?: string): WatchConfig {
  const env = (key: string) =>
    prefix ? process.env[`${prefix}_${key}`] : process.env[key];
  const channelsStr = env("WATCH_CHANNELS") || (prefix ? process.env[`${prefix}_INSTAGRAM_CHANNELS`] : "") || "";
  const channels = [
    ...new Set(
      channelsStr
        .split(",")
        .map((c) => c.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean),
    ),
  ];
  const searchModeRaw = (env("WATCH_SEARCH_MODE") || "hashtags").toLowerCase();
  const searchMode = (["channels", "hashtags", "both"].includes(searchModeRaw)
    ? searchModeRaw
    : "hashtags") as WatchConfig["searchMode"];

  const excludeChannelsRaw = env("WATCH_EXCLUDE_CHANNELS") || "";
  const excludeChannels = excludeChannelsRaw
    ? excludeChannelsRaw.split(",").map((c) => c.trim().replace(/^@/, "").toLowerCase()).filter(Boolean)
    : [];

  const nicheHashtagsRaw = env("WATCH_NICHE_HASHTAGS") || "";
  const nicheHashtags = nicheHashtagsRaw
    ? nicheHashtagsRaw.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean)
    : undefined;

  const moodFilterRaw = env("WATCH_MOOD_FILTER") || "";
  const moodFilter = moodFilterRaw
    ? moodFilterRaw.split(",").map((m) => m.trim().toLowerCase()).filter(Boolean)
    : undefined;

  const viralThreshold = Math.min(
    100,
    Math.max(0, parseInt(env("WATCH_VIRAL_THRESHOLD") || "50", 10)),
  );

  const outroVersionRaw = (env("WATCH_OUTRO_VERSION") || "v2").toLowerCase();
  const outroVersion = (["v1", "v2"].includes(outroVersionRaw)
    ? outroVersionRaw
    : "v2") as "v1" | "v2";

  const primaryAdminChatId = process.env.WATCH_ADMIN_CHAT_ID ? parseInt(process.env.WATCH_ADMIN_CHAT_ID, 10) : 0;
  const adminChatId = parseInt(env("WATCH_ADMIN_CHAT_ID") || "0", 10) || primaryAdminChatId;

  return {
    channels,
    dailyCount: parseInt(env("WATCH_DAILY_COUNT") || "5", 10),
    scheduleTime: env("WATCH_SCHEDULE_TIME") || "09:00",
    gapHours: parseFloat(env("WATCH_GAP_HOURS") || "2"),
    adminChatId,
    searchMode,
    nicheHashtags,
    moodFilter,
    viralThreshold,
    excludeChannels,
    outroVersion,
  };
}

function getMasterTelegramToken(): string {
  if (BOT_ENV === "prod") {
    return (
      process.env.TELEGRAM_BOT_TOKEN_PROD ||
      process.env.CODEORCAP_TELEGRAM_BOT_TOKEN_PROD ||
      process.env.TELEGRAM_BOT_TOKEN ||
      process.env.TELEGRAM_BOT_TOKEN_LOCAL ||
      ""
    ).trim();
  }
  return (
    process.env.TELEGRAM_BOT_TOKEN_LOCAL ||
    process.env.CODEORCAP_TELEGRAM_BOT_TOKEN_LOCAL ||
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.TELEGRAM_BOT_TOKEN_PROD ||
    ""
  ).trim();
}

// Detect extra channel prefixes from env vars like STORIYUM_INSTAGRAM_CHANNELS, etc.
function loadExtraProfiles(): ChannelProfile[] {
  const prefixes = new Set<string>();
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^([A-Z0-9_]+)_(?:TELEGRAM_BOT_TOKEN|INSTAGRAM_CHANNELS|YOUTUBE_REFRESH_TOKEN|INSTAGRAM_ACCESS_TOKEN|INSTAGRAM_USER_ID)(?:_LOCAL|_PROD)?$/);
    if (m) {
      prefixes.add(m[1].toUpperCase());
    }
  }

  // Always ensure STORIYUM, PROMPT_GAG, and INFOONSPOT are considered as prefixes
  prefixes.add("STORIYUM");
  prefixes.add("PROMPT_GAG");
  prefixes.add("INFOONSPOT");
  // Primary profile is CodeOrCap — never generate a duplicate extra profile for it
  prefixes.delete("CODEORCAP");

  const masterToken = getMasterTelegramToken();
  const profiles: ChannelProfile[] = [];
  for (const prefix of prefixes) {
    const env = (key: string) => process.env[`${prefix}_${key}`];
    
    // Single shared Telegram bot token for all channels (CodeOrCap prod/local bot)
    const telegramToken = masterToken;
    const isWatchOnly = true;
    if (!telegramToken) continue;

    let brandName = env("BRAND_NAME");
    if (!brandName) {
      if (prefix === "PROMPT_GAG") brandName = "PromptGag";
      else if (prefix === "INFOONSPOT") brandName = "InfoOnSpot";
      else brandName = titleCase(prefix);
    }
    
    let fbPageId = env("FACEBOOK_PAGE_ID") || "";
    let fbAccessToken = env("FACEBOOK_ACCESS_TOKEN") || env("INSTAGRAM_ACCESS_TOKEN") || "";
    if (prefix === "STORIYUM") {
      if (!fbPageId) fbPageId = "1244228672098266";
    }

    const nicheEnv = env("NICHE") || (prefix === "PROMPT_GAG" ? "finance" : prefix === "INFOONSPOT" ? "infoonspot" : undefined);

    profiles.push({
      key: prefix.toLowerCase(),
      brandName,
      handle: env("BRAND_HANDLE") || (prefix === "PROMPT_GAG" ? "@prompt_gag" : `@${prefix.toLowerCase()}`),
      theme: resolveTheme(nicheEnv, brandName),
      isDefault: false,
      telegramToken,
      isWatchOnly,
      youtube: loadPrefixedYoutube(prefix, brandName),
      instagram: { accounts: loadPrefixedInstagram(prefix, brandName) },
      facebook: fbPageId && fbAccessToken ? { pageId: fbPageId, accessToken: fbAccessToken } : undefined,
      watch: loadWatchConfig(prefix),
    });
  }
  return profiles;
}

function deduplicateProfiles(profiles: ChannelProfile[]): ChannelProfile[] {
  const seen = new Set<string>();
  const result: ChannelProfile[] = [];
  for (const p of profiles) {
    const k = (p.key || p.brandName || "").toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      result.push(p);
    }
  }
  return result;
}

function loadPrimaryProfile(): ChannelProfile {
  const fbPageId = process.env.FACEBOOK_PAGE_ID || "1155595804312771";
  const fbAccessToken = process.env.FACEBOOK_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN || "";

  return {
    key: "codeorcap",
    brandName: process.env.BRAND_NAME || "CodeOrCap",
    handle: process.env.BRAND_HANDLE || "@codeorcap",
    theme: resolveTheme(process.env.NICHE, "primary profile"),
    isDefault: true,
    telegramToken: getMasterTelegramToken(),
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
    facebook: fbPageId && fbAccessToken ? { pageId: fbPageId, accessToken: fbAccessToken } : undefined,
    watch: loadWatchConfig(),
  };
}

const primaryProfile = loadPrimaryProfile();

export const config: AppConfig = {
  telegramToken: primaryProfile.telegramToken,
  youtube: primaryProfile.youtube,
  instagram: primaryProfile.instagram,
  profiles: deduplicateProfiles(
    [primaryProfile, ...loadExtraProfiles()].filter((p) => p.telegramToken),
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

    geminiApiKey: process.env.GEMINI_API_KEY || "",
    pexelsApiKey:
      process.env.PEXELS_API_KEY ||
      process.env.PIXELS_API_KEY ||
      process.env.PEXEL_API_KEY ||
      "",
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
    dataDir: process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : path.join(os.homedir(), ".shorts-automation"),
  },
  rendering: {
    videoDurationSeconds: parseInt(
      process.env.VIDEO_DURATION_SECONDS || "15",
      10,
    ),
    fps: parseInt(process.env.VIDEO_FPS || "30", 10),
    musicVolume: parseFloat(process.env.MUSIC_VOLUME || "0.15"),
    musicStartOffset: parseInt(process.env.MUSIC_START_OFFSET || "20", 10),
    backgroundMusicEnabled: process.env.BACKGROUND_MUSIC_ENABLED === "true",
    beautifyCode: process.env.BEAUTIFY_CODE !== "false",
  },
  binaries: {
    ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
    ffprobe: process.env.FFPROBE_PATH || "ffprobe",
    ytdlp: process.env.YTDLP_PATH || "yt-dlp",
    python3:
      process.env.PYTHON_PATH && !(process.platform === "win32" && process.env.PYTHON_PATH === "python3")
        ? process.env.PYTHON_PATH
        : process.platform === "win32"
          ? "python"
          : "python3",
    chrome:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (process.platform === "win32"
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : "/usr/bin/google-chrome"),
    fpcalc: process.env.FPCALC_PATH || "fpcalc",
  },
  copyright: {
    enabled: process.env.COPYRIGHT_CHECK_ENABLED !== "false",
    acoustidApiKey: process.env.ACOUSTID_API_KEY || "",
  },
  audioClearance: {
    enabled: process.env.AUDIO_CLEARANCE_ENABLED !== "false",
  },
  instagramScraper: {
    loginFreeMode:
      process.env.LOGIN_FREE_MODE === "true" ||
      (process.env.INSTAGRAM_LOGIN_MODE || "").trim().toLowerCase() === "none" ||
      (process.env.INSTAGRAM_LOGIN_MODE || "").trim().toLowerCase() === "login_free",
    sessionOnly:
      (process.env.INSTAGRAM_LOGIN_MODE || "session_only").trim().toLowerCase() !==
      "full",
    interChannelDelayMs: parseInt(
      process.env.INSTAGRAM_INTER_CHANNEL_DELAY_MS || "25000",
      10,
    ),
    rateLimitCooldownMs: parseInt(
      process.env.INSTAGRAM_RATE_LIMIT_COOLDOWN_MS || "2700000", // 45 min
      10,
    ),
  },
};

// Resolve best ffmpeg binary dynamically on macOS if ffmpeg-full is installed
if (process.platform === "darwin") {
  const brewFfmpegFull = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
  const brewFfprobeFull = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";
  if (fs.existsSync(brewFfmpegFull)) {
    config.binaries.ffmpeg = brewFfmpegFull;
  }
  if (fs.existsSync(brewFfprobeFull)) {
    config.binaries.ffprobe = brewFfprobeFull;
  }
}

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
