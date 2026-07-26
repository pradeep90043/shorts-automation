import { Pool } from "pg";
import { pipelineLogger } from "./logger";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
});

export async function getPool(): Promise<Pool> {
  return pool;
}

export async function closePg(): Promise<void> {
  await pool.end();
}

/** Auto-creates tables on first startup so no manual SQL step is needed. */
export async function initSchema(): Promise<void> {
  const maxRetries = 5;
  let attempt = 1;
  while (attempt <= maxRetries) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS reel_history (
          shortcode           TEXT NOT NULL,
          profile_key         TEXT NOT NULL DEFAULT 'default',
          channel             TEXT NOT NULL,
          picked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          published_at        TIMESTAMPTZ,
          youtube_url         TEXT,
          instagram_url       TEXT,
          facebook_url        TEXT,
          youtube_video_id    TEXT,
          instagram_media_id  TEXT,
          facebook_video_id   TEXT,
          failed              BOOLEAN,
          failed_reason       TEXT,
          PRIMARY KEY (shortcode, profile_key)
        );

        CREATE TABLE IF NOT EXISTS watch_state (
          profile_key      TEXT PRIMARY KEY,
          queue            JSONB NOT NULL DEFAULT '[]',
          last_batch_date  TEXT NOT NULL DEFAULT '',
          channel_sequence JSONB NOT NULL DEFAULT '[]',
          current_slot     INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS reel_insights (
          shortcode              TEXT NOT NULL,
          profile_key            TEXT NOT NULL,
          platform               TEXT NOT NULL,
          published_at           TIMESTAMPTZ,
          views                  INTEGER NOT NULL DEFAULT 0,
          likes                  INTEGER NOT NULL DEFAULT 0,
          comments               INTEGER NOT NULL DEFAULT 0,
          shares                 INTEGER NOT NULL DEFAULT 0,
          saves                  INTEGER NOT NULL DEFAULT 0,
          average_watch_time     REAL,
          retention_percentage   REAL,
          three_second_views     INTEGER,
          last_updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (shortcode, profile_key, platform)
        );
      `);
      // Add columns for existing rows (no-op if they already exist)
      await pool.query(`
        ALTER TABLE watch_state ADD COLUMN IF NOT EXISTS channel_sequence JSONB NOT NULL DEFAULT '[]';
        ALTER TABLE watch_state ADD COLUMN IF NOT EXISTS current_slot INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE reel_history ADD COLUMN IF NOT EXISTS facebook_url TEXT;
        ALTER TABLE reel_history ADD COLUMN IF NOT EXISTS youtube_video_id TEXT;
        ALTER TABLE reel_history ADD COLUMN IF NOT EXISTS instagram_media_id TEXT;
        ALTER TABLE reel_history ADD COLUMN IF NOT EXISTS facebook_video_id TEXT;
      `);
      pipelineLogger.info("Supabase schema ready (reel_history, watch_state, reel_insights)", "Supabase");
      return;
    } catch (err) {
      if (attempt === maxRetries) {
        throw err;
      }
      pipelineLogger.warn(
        `Failed to connect/initialize Supabase schema (Attempt ${attempt}/${maxRetries}): ${err instanceof Error ? err.message : String(err)}. Retrying in 5s...`,
        "Supabase"
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
      attempt++;
    }
  }
}
