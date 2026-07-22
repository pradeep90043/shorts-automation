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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reel_history (
      shortcode     TEXT NOT NULL,
      profile_key   TEXT NOT NULL DEFAULT 'default',
      channel       TEXT NOT NULL,
      picked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at  TIMESTAMPTZ,
      youtube_url   TEXT,
      instagram_url TEXT,
      failed        BOOLEAN,
      failed_reason TEXT,
      PRIMARY KEY (shortcode, profile_key)
    );

    CREATE TABLE IF NOT EXISTS watch_state (
      profile_key     TEXT PRIMARY KEY,
      queue           JSONB NOT NULL DEFAULT '[]',
      last_batch_date TEXT NOT NULL DEFAULT ''
    );
  `);
  pipelineLogger.info("Supabase schema ready (reel_history, watch_state)", "Supabase");
}
