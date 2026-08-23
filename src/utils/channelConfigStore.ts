import { getPool } from "./pgClient";
import { config } from "../config";
import { pipelineLogger } from "./logger";

export interface StoredInstagramAccount {
  name: string;
  igUserId: string;
  accessToken: string;
}

export interface StoredYoutubeChannel {
  name: string;
  refreshToken: string;
}

export interface StoredChannelConfig {
  key: string;
  brandName: string;
  handle: string;
  niche: string;
  isDefault?: boolean;
  isWatchOnly?: boolean;
  
  // Multi-account publishing credentials
  instagramAccounts?: StoredInstagramAccount[];
  youtubeChannels?: StoredYoutubeChannel[];
  
  // Single/Primary credentials
  instagramUserId?: string;
  instagramAccessToken?: string;
  instagramUsername?: string;
  instagramPassword?: string;
  instagramSessionId?: string;
  
  youtubeRefreshToken?: string;
  youtubeClientId?: string;
  youtubeClientSecret?: string;
  youtubeRedirectUri?: string;
  
  facebookPageId?: string;
  facebookAccessToken?: string;
  
  // Watcher / Automation
  watchChannels?: string[];
  searchMode?: "channels" | "hashtags" | "both";
  dailyCount?: number;
  scheduleTime?: string;
  gapHours?: number;
  viralThreshold?: number;
  outroVersion?: "v1" | "v2";
  videoMode?: "curator" | "faceless_ai" | "hybrid";
  subtitleStyle?: "classic" | "animated_pop" | "minimal" | "none";
  ttsVoice?: string;
  adminChatId?: number;
  
  createdAt?: Date;
  updatedAt?: Date;
}

let tableInitialized = false;

export async function initChannelConfigsTable(): Promise<void> {
  if (tableInitialized) return;
  try {
    const pool = await getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channel_configs (
        key VARCHAR(64) PRIMARY KEY,
        brand_name VARCHAR(128) NOT NULL,
        handle VARCHAR(128) NOT NULL,
        niche VARCHAR(32) NOT NULL DEFAULT 'tech',
        is_default BOOLEAN DEFAULT FALSE,
        is_watch_only BOOLEAN DEFAULT TRUE,
        
        instagram_accounts JSONB DEFAULT '[]',
        youtube_channels JSONB DEFAULT '[]',
        
        instagram_user_id TEXT,
        instagram_access_token TEXT,
        instagram_username TEXT,
        instagram_password TEXT,
        instagram_session_id TEXT,
        
        youtube_refresh_token TEXT,
        youtube_client_id TEXT,
        youtube_client_secret TEXT,
        youtube_redirect_uri TEXT,
        
        facebook_page_id TEXT,
        facebook_access_token TEXT,
        
        watch_channels TEXT[] DEFAULT '{}',
        search_mode VARCHAR(32) DEFAULT 'channels',
        daily_count INT DEFAULT 5,
        schedule_time VARCHAR(16) DEFAULT '09:00',
        gap_hours REAL DEFAULT 2.0,
        viral_threshold INT DEFAULT 50,
        outro_version VARCHAR(16) DEFAULT 'v2',
        video_mode VARCHAR(32) DEFAULT 'curator',
        subtitle_style VARCHAR(32) DEFAULT 'classic',
        tts_voice VARCHAR(64) DEFAULT 'default',
        admin_chat_id BIGINT,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      
      ALTER TABLE channel_configs ADD COLUMN IF NOT EXISTS instagram_accounts JSONB DEFAULT '[]';
      ALTER TABLE channel_configs ADD COLUMN IF NOT EXISTS youtube_channels JSONB DEFAULT '[]';
      ALTER TABLE channel_configs ADD COLUMN IF NOT EXISTS video_mode VARCHAR(32) DEFAULT 'curator';
      ALTER TABLE channel_configs ADD COLUMN IF NOT EXISTS subtitle_style VARCHAR(32) DEFAULT 'classic';
      ALTER TABLE channel_configs ADD COLUMN IF NOT EXISTS tts_voice VARCHAR(64) DEFAULT 'default';
    `);

    tableInitialized = true;

    // Auto-seed initial profiles from in-memory / .env config if table is empty
    const countRes = await pool.query(`SELECT COUNT(*) FROM channel_configs`);
    if (parseInt(countRes.rows[0].count, 10) === 0) {
      pipelineLogger.info("Seeding channel_configs table with configured channels...", "ChannelStore");
      for (const p of config.profiles) {
        const key = p.key.toLowerCase();
        const prefix = key.toUpperCase().replace(/-/g, "_");
        const env = (k: string) => process.env[`${prefix}_${k}`] || (key === "codeorcap" ? process.env[k] : undefined);
        
        const igAccounts: StoredInstagramAccount[] = p.instagram.accounts.map((a) => ({
          name: a.name || `${p.brandName} Instagram`,
          igUserId: a.igUserId,
          accessToken: a.accessToken,
        }));
        
        const ytChannels: StoredYoutubeChannel[] = p.youtube.channels.map((c) => ({
          name: c.name || p.brandName,
          refreshToken: c.refreshToken,
        }));

        await saveChannelConfig({
          key,
          brandName: p.brandName,
          handle: p.handle,
          niche: (p.theme?.niche as any) || (key === "prompt_gag" ? "humor" : key === "storiyum" ? "stories" : "tech"),
          isDefault: p.isDefault,
          isWatchOnly: p.isWatchOnly ?? true,
          instagramAccounts: igAccounts,
          youtubeChannels: ytChannels,
          instagramUserId: igAccounts[0]?.igUserId || env("INSTAGRAM_USER_ID"),
          instagramAccessToken: igAccounts[0]?.accessToken || env("INSTAGRAM_ACCESS_TOKEN"),
          instagramUsername: env("INSTAGRAM_USERNAME"),
          instagramPassword: env("INSTAGRAM_PASSWORD"),
          instagramSessionId: env("INSTAGRAM_SESSION_ID"),
          youtubeRefreshToken: ytChannels[0]?.refreshToken || env("YOUTUBE_REFRESH_TOKEN"),
          youtubeClientId: p.youtube.clientId || env("YOUTUBE_CLIENT_ID"),
          youtubeClientSecret: p.youtube.clientSecret || env("YOUTUBE_CLIENT_SECRET"),
          facebookPageId: p.facebook?.pageId || env("FACEBOOK_PAGE_ID"),
          facebookAccessToken: p.facebook?.accessToken || env("FACEBOOK_ACCESS_TOKEN"),
          watchChannels: p.watch?.channels || [],
          searchMode: p.watch?.searchMode || "channels",
          dailyCount: p.watch?.dailyCount || 5,
          scheduleTime: p.watch?.scheduleTime || "09:00",
          gapHours: p.watch?.gapHours || 2,
          viralThreshold: p.watch?.viralThreshold || 50,
          outroVersion: p.watch?.outroVersion || "v2",
          adminChatId: p.watch?.adminChatId || (process.env.WATCH_ADMIN_CHAT_ID ? parseInt(process.env.WATCH_ADMIN_CHAT_ID, 10) : 0),
        });
      }
    }
  } catch (err) {
    pipelineLogger.warn(`Failed to initialize channel_configs table: ${err instanceof Error ? err.message : err}`, "ChannelStore");
  }
}

export async function getAllStoredChannelConfigs(): Promise<StoredChannelConfig[]> {
  await initChannelConfigsTable();
  try {
    const pool = await getPool();
    const res = await pool.query(`SELECT * FROM channel_configs ORDER BY is_default DESC, key ASC`);
    return res.rows.map((row) => {
      const prefix = row.key.toUpperCase().replace(/-/g, "_");
      const envYt = process.env[`${prefix}_YOUTUBE_REFRESH_TOKEN`] || (row.key === "codeorcap" ? process.env.YOUTUBE_CHANNEL_1_REFRESH_TOKEN || process.env.YOUTUBE_REFRESH_TOKEN : undefined);
      const envIgUser = process.env[`${prefix}_INSTAGRAM_USER_ID`] || (row.key === "codeorcap" ? process.env.INSTAGRAM_USER_ID : undefined);
      const envIgToken = process.env[`${prefix}_INSTAGRAM_ACCESS_TOKEN`] || (row.key === "codeorcap" ? process.env.INSTAGRAM_ACCESS_TOKEN : undefined);

      let igAccounts: StoredInstagramAccount[] = Array.isArray(row.instagram_accounts) ? row.instagram_accounts : [];
      if (igAccounts.length === 0 && (row.instagram_user_id || envIgUser) && (row.instagram_access_token || envIgToken)) {
        igAccounts = [{
          name: `${row.brand_name} Instagram`,
          igUserId: row.instagram_user_id || envIgUser || "",
          accessToken: row.instagram_access_token || envIgToken || "",
        }];
      }

      let ytChannels: StoredYoutubeChannel[] = Array.isArray(row.youtube_channels) ? row.youtube_channels : [];
      if (ytChannels.length === 0 && (row.youtube_refresh_token || envYt)) {
        ytChannels = [{
          name: row.brand_name,
          refreshToken: row.youtube_refresh_token || envYt || "",
        }];
      }

      return {
        key: row.key,
        brandName: row.brand_name,
        handle: row.handle,
        niche: row.niche,
        isDefault: row.is_default,
        isWatchOnly: row.is_watch_only,
        instagramAccounts: igAccounts,
        youtubeChannels: ytChannels,
        instagramUserId: row.instagram_user_id || igAccounts[0]?.igUserId || undefined,
        instagramAccessToken: row.instagram_access_token || igAccounts[0]?.accessToken || undefined,
        instagramUsername: row.instagram_username || undefined,
        instagramPassword: row.instagram_password || undefined,
        instagramSessionId: row.instagram_session_id || undefined,
        youtubeRefreshToken: row.youtube_refresh_token || ytChannels[0]?.refreshToken || undefined,
        youtubeClientId: row.youtube_client_id || undefined,
        youtubeClientSecret: row.youtube_client_secret || undefined,
        youtubeRedirectUri: row.youtube_redirect_uri || undefined,
        facebookPageId: row.facebook_page_id || undefined,
        facebookAccessToken: row.facebook_access_token || undefined,
        watchChannels: row.watch_channels || [],
        searchMode: row.search_mode || "channels",
        dailyCount: row.daily_count || 5,
        scheduleTime: row.schedule_time || "09:00",
        gapHours: row.gap_hours || 2.0,
        viralThreshold: row.viral_threshold || 50,
        outroVersion: row.outro_version || "v2",
        videoMode: row.video_mode || "curator",
        subtitleStyle: row.subtitle_style || "classic",
        ttsVoice: row.tts_voice || "default",
        adminChatId: row.admin_chat_id ? Number(row.admin_chat_id) : undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  } catch (err) {
    pipelineLogger.error("Failed to query channel_configs", err, "ChannelStore");
    return [];
  }
}

export async function getStoredChannelConfig(key: string): Promise<StoredChannelConfig | null> {
  const configs = await getAllStoredChannelConfigs();
  return configs.find((c) => c.key.toLowerCase() === key.toLowerCase().trim()) || null;
}

export async function saveChannelConfig(c: StoredChannelConfig): Promise<void> {
  await initChannelConfigsTable();
  const pool = await getPool();
  const key = c.key.toLowerCase().trim();

  // Normalize multi-account arrays
  let igAccounts: StoredInstagramAccount[] = c.instagramAccounts || [];
  if (igAccounts.length === 0 && c.instagramUserId && c.instagramAccessToken) {
    igAccounts = [{
      name: `${c.brandName} Instagram`,
      igUserId: c.instagramUserId,
      accessToken: c.instagramAccessToken,
    }];
  }

  let ytChannels: StoredYoutubeChannel[] = c.youtubeChannels || [];
  if (ytChannels.length === 0 && c.youtubeRefreshToken) {
    ytChannels = [{
      name: c.brandName,
      refreshToken: c.youtubeRefreshToken,
    }];
  }

  const primaryIg = igAccounts[0];
  const primaryYt = ytChannels[0];

  await pool.query(
    `INSERT INTO channel_configs (
      key, brand_name, handle, niche, is_default, is_watch_only,
      instagram_accounts, youtube_channels,
      instagram_user_id, instagram_access_token, instagram_username, instagram_password, instagram_session_id,
      youtube_refresh_token, youtube_client_id, youtube_client_secret, youtube_redirect_uri,
      facebook_page_id, facebook_access_token,
      watch_channels, search_mode, daily_count, schedule_time, gap_hours, viral_threshold, outro_version,
      video_mode, subtitle_style, tts_voice,
      admin_chat_id,
      updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8,
      $9, $10, $11, $12, $13,
      $14, $15, $16, $17,
      $18, $19,
      $20, $21, $22, $23, $24, $25, $26,
      $27, $28, $29,
      $30,
      NOW()
    )
    ON CONFLICT (key) DO UPDATE SET
      brand_name = EXCLUDED.brand_name,
      handle = EXCLUDED.handle,
      niche = EXCLUDED.niche,
      is_watch_only = EXCLUDED.is_watch_only,
      instagram_accounts = EXCLUDED.instagram_accounts,
      youtube_channels = EXCLUDED.youtube_channels,
      instagram_user_id = EXCLUDED.instagram_user_id,
      instagram_access_token = EXCLUDED.instagram_access_token,
      instagram_username = COALESCE(EXCLUDED.instagram_username, channel_configs.instagram_username),
      instagram_password = COALESCE(EXCLUDED.instagram_password, channel_configs.instagram_password),
      instagram_session_id = COALESCE(EXCLUDED.instagram_session_id, channel_configs.instagram_session_id),
      youtube_refresh_token = EXCLUDED.youtube_refresh_token,
      youtube_client_id = EXCLUDED.youtube_client_id,
      youtube_client_secret = EXCLUDED.youtube_client_secret,
      youtube_redirect_uri = EXCLUDED.youtube_redirect_uri,
      facebook_page_id = EXCLUDED.facebook_page_id,
      facebook_access_token = EXCLUDED.facebook_access_token,
      watch_channels = EXCLUDED.watch_channels,
      search_mode = EXCLUDED.search_mode,
      daily_count = EXCLUDED.daily_count,
      schedule_time = EXCLUDED.schedule_time,
      gap_hours = EXCLUDED.gap_hours,
      viral_threshold = EXCLUDED.viral_threshold,
      outro_version = EXCLUDED.outro_version,
      video_mode = EXCLUDED.video_mode,
      subtitle_style = EXCLUDED.subtitle_style,
      tts_voice = EXCLUDED.tts_voice,
      admin_chat_id = EXCLUDED.admin_chat_id,
      updated_at = NOW()`,
    [
      key,
      c.brandName,
      c.handle.startsWith("@") ? c.handle : `@${c.handle}`,
      c.niche || "tech",
      Boolean(c.isDefault),
      c.isWatchOnly ?? true,
      JSON.stringify(igAccounts),
      JSON.stringify(ytChannels),
      primaryIg?.igUserId || c.instagramUserId || null,
      primaryIg?.accessToken || c.instagramAccessToken || null,
      c.instagramUsername || null,
      c.instagramPassword || null,
      c.instagramSessionId || null,
      primaryYt?.refreshToken || c.youtubeRefreshToken || null,
      c.youtubeClientId || null,
      c.youtubeClientSecret || null,
      c.youtubeRedirectUri || null,
      c.facebookPageId || null,
      c.facebookAccessToken || null,
      c.watchChannels || [],
      c.searchMode || "channels",
      c.dailyCount || 5,
      c.scheduleTime || "09:00",
      c.gapHours || 2.0,
      c.viralThreshold || 50,
      c.outroVersion || "v2",
      c.videoMode || "curator",
      c.subtitleStyle || "classic",
      c.ttsVoice || "default",
      c.adminChatId || null,
    ]
  );

  // Synchronize process.env for this profile
  const prefix = key.toUpperCase().replace(/-/g, "_");
  if (primaryIg?.accessToken) process.env[`${prefix}_INSTAGRAM_ACCESS_TOKEN`] = primaryIg.accessToken;
  if (primaryIg?.igUserId) process.env[`${prefix}_INSTAGRAM_USER_ID`] = primaryIg.igUserId;
  if (primaryYt?.refreshToken) process.env[`${prefix}_YOUTUBE_REFRESH_TOKEN`] = primaryYt.refreshToken;
  if (c.facebookPageId) process.env[`${prefix}_FACEBOOK_PAGE_ID`] = c.facebookPageId;
  if (c.facebookAccessToken) process.env[`${prefix}_FACEBOOK_ACCESS_TOKEN`] = c.facebookAccessToken;
  if (c.watchChannels) process.env[`${prefix}_WATCH_CHANNELS`] = c.watchChannels.join(",");
  if (c.instagramUsername) process.env[`${prefix}_INSTAGRAM_USERNAME`] = c.instagramUsername;
  if (c.instagramPassword) process.env[`${prefix}_INSTAGRAM_PASSWORD`] = c.instagramPassword;
  if (c.instagramSessionId) process.env[`${prefix}_INSTAGRAM_SESSION_ID`] = c.instagramSessionId;
  process.env[`${prefix}_NICHE`] = c.niche;

  pipelineLogger.info(`Channel profile [${c.brandName}] (${key}) with ${igAccounts.length} IG account(s) and ${ytChannels.length} YT channel(s) saved to database.`, "ChannelStore");
}

export async function deleteChannelConfig(key: string): Promise<boolean> {
  await initChannelConfigsTable();
  const pool = await getPool();
  const k = key.toLowerCase().trim();
  if (k === "codeorcap") {
    throw new Error("Default channel profile (CodeOrCap) cannot be deleted.");
  }
  const res = await pool.query(`DELETE FROM channel_configs WHERE key = $1`, [k]);
  return (res.rowCount || 0) > 0;
}
