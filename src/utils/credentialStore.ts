import path from "path";
import { execFile } from "child_process";
import { getPool } from "./pgClient";
import { config } from "../config";
import { pipelineLogger } from "./logger";

export interface ChannelCredentials {
  profileKey: string;
  instagramSessionId?: string;
  instagramUsername?: string;
  instagramPassword?: string;
  instagramEmail?: string;
  instagramTotpSecret?: string;
  /** Base64-encoded instagrapi settings blob (device UUIDs + cookies) — persisted so
   *  re-logins reuse the same device fingerprint and survive container redeploys. */
  instagramSettingsJson?: string;
  /** Optional proxy URL routed through for all Instagram calls for this profile. */
  instagramProxy?: string;
  /** Set when Instagram last rejected the stored cookie; null/undefined = healthy. */
  sessionDeadAt?: Date | null;
  updatedAt?: Date;
}

export async function getChannelCredentials(profileKey: string): Promise<ChannelCredentials | null> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT profile_key, instagram_session_id, instagram_username, instagram_password,
            instagram_email, instagram_totp_secret, instagram_settings_json, instagram_proxy,
            session_dead_at, updated_at
     FROM channel_credentials WHERE profile_key = $1`,
    [profileKey.toLowerCase()],
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    profileKey: row.profile_key,
    instagramSessionId: row.instagram_session_id || undefined,
    instagramUsername: row.instagram_username || undefined,
    instagramPassword: row.instagram_password || undefined,
    instagramEmail: row.instagram_email || undefined,
    instagramTotpSecret: row.instagram_totp_secret || undefined,
    instagramSettingsJson: row.instagram_settings_json || undefined,
    instagramProxy: row.instagram_proxy || undefined,
    sessionDeadAt: row.session_dead_at || null,
    updatedAt: row.updated_at,
  };
}

export async function saveChannelCredentials(creds: ChannelCredentials): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO channel_credentials
       (profile_key, instagram_session_id, instagram_username, instagram_password,
        instagram_email, instagram_totp_secret, instagram_settings_json, instagram_proxy, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (profile_key) DO UPDATE SET
       instagram_session_id    = EXCLUDED.instagram_session_id,
       instagram_username      = EXCLUDED.instagram_username,
       instagram_password      = EXCLUDED.instagram_password,
       instagram_email         = EXCLUDED.instagram_email,
       instagram_totp_secret   = EXCLUDED.instagram_totp_secret,
       instagram_settings_json = EXCLUDED.instagram_settings_json,
       instagram_proxy         = EXCLUDED.instagram_proxy,
       updated_at              = NOW()`,
    [
      creds.profileKey.toLowerCase(),
      creds.instagramSessionId || null,
      creds.instagramUsername || null,
      creds.instagramPassword || null,
      creds.instagramEmail || null,
      creds.instagramTotpSecret || null,
      creds.instagramSettingsJson || null,
      creds.instagramProxy || null,
    ],
  );
}

const PATCH_COLUMN_MAP: Record<string, string> = {
  instagramSessionId: "instagram_session_id",
  instagramUsername: "instagram_username",
  instagramPassword: "instagram_password",
  instagramEmail: "instagram_email",
  instagramTotpSecret: "instagram_totp_secret",
  instagramSettingsJson: "instagram_settings_json",
  instagramProxy: "instagram_proxy",
  sessionDeadAt: "session_dead_at",
};

/**
 * Merge-persist just the fields provided, leaving the rest of the row intact.
 * Single atomic UPSERT (no read-modify-write) so concurrent patches — e.g. a
 * session-id refresh and a settings-blob refresh from the same scraper run —
 * can't clobber each other. Pass "" to explicitly clear a column.
 */
export async function patchChannelCredentials(
  profileKey: string,
  patch: Partial<Omit<ChannelCredentials, "profileKey" | "updatedAt">>,
): Promise<void> {
  const entries = Object.entries(patch).filter(([k]) => k in PATCH_COLUMN_MAP);
  if (entries.length === 0) return;
  const pool = await getPool();
  const cols = entries.map(([k]) => PATCH_COLUMN_MAP[k]);
  const vals = entries.map(([, v]) => (v ? v : null));
  const insertCols = ["profile_key", ...cols, "updated_at"];
  const insertPlaceholders = [
    "$1",
    ...cols.map((_, i) => `$${i + 2}`),
    "NOW()",
  ];
  const updateSet = [
    ...cols.map((c, i) => `${c} = $${i + 2}`),
    "updated_at = NOW()",
  ];
  await pool.query(
    `INSERT INTO channel_credentials (${insertCols.join(", ")})
     VALUES (${insertPlaceholders.join(", ")})
     ON CONFLICT (profile_key) DO UPDATE SET ${updateSet.join(", ")}`,
    [profileKey.toLowerCase(), ...vals],
  );
}

/**
 * Spawns get_session_id.py with stored username+password, saves the returned
 * session ID back to the DB and into process.env.  Returns the new session ID
 * on success, null if credentials are missing or login fails.
 *
 * NOTE: this performs a username/password login. In the default "session_only"
 * mode the server must never do that (a datacenter-IP password login trips an
 * Instagram challenge), so this is a no-op unless INSTAGRAM_LOGIN_MODE=full.
 */
export async function refreshSessionForProfile(profileKey: string): Promise<string | null> {
  if (config.instagramScraper.sessionOnly) {
    pipelineLogger.warn(
      `[${profileKey}] Skipping automatic session refresh — server is in session_only mode ` +
        `(a password login from this IP would trigger an Instagram challenge). ` +
        `Paste a fresh sessionid via the dashboard instead.`,
      "CredentialStore",
    );
    return null;
  }

  const creds = await getChannelCredentials(profileKey);
  if (!creds?.instagramUsername || !creds?.instagramPassword) return null;

  const python3 = (process.env.PYTHON_PATH && process.env.PYTHON_PATH !== "python3") ? process.env.PYTHON_PATH : "python3";
  const script = path.resolve(__dirname, "../../scripts/get_session_id.py");

  return new Promise((resolve) => {
    execFile(
      python3,
      [script],
      {
        timeout: 90000,
        env: {
          ...process.env,
          INSTAGRAM_USERNAME: creds.instagramUsername!,
          INSTAGRAM_PASSWORD: creds.instagramPassword!,
          INSTAGRAM_TOTP_SECRET: creds.instagramTotpSecret || process.env.INSTAGRAM_TOTP_SECRET || "",
        },
      },
      async (err, stdout) => {
        const sessionId = stdout.trim();
        if (err || !sessionId) { resolve(null); return; }
        try {
          await patchChannelCredentials(profileKey, { instagramSessionId: sessionId });
          // Update process.env immediately so in-memory candidates pick it up
          const prefix = profileKey.toUpperCase().replace(/-/g, "_");
          process.env[`${prefix}_INSTAGRAM_SESSION_ID`] = sessionId;
          process.env.INSTAGRAM_SESSION_ID = sessionId;
          resolve(sessionId);
        } catch { resolve(null); }
      },
    );
  });
}

/**
 * Load DB credentials into process.env at startup.
 *
 * Session IDs and the settings blob rotate constantly (re-minted by the scraper,
 * by refreshSessionForProfile, and by the dashboard, and written back to the DB),
 * so a stale value baked into the image's .env must NOT win over a fresher one in
 * the DB — the DB is the source of truth for those and always overrides.
 * Username / password / TOTP are stable, so those only fill in when absent.
 */
export async function loadCredentialsToEnv(profileKey: string): Promise<void> {
  const creds = await getChannelCredentials(profileKey);
  if (!creds) return;
  const prefix = profileKey.toUpperCase().replace(/-/g, "_");
  const setIfMissing = (envKey: string, value: string | undefined) => {
    if (value && !process.env[envKey]) process.env[envKey] = value;
  };
  const setAlways = (envKey: string, value: string | undefined) => {
    if (value) process.env[envKey] = value;
  };
  // Prefixed session ID + settings blob: DB always wins over the stale baked-in .env value.
  setAlways(`${prefix}_INSTAGRAM_SESSION_ID`, creds.instagramSessionId);
  setAlways(`${prefix}_INSTAGRAM_SETTINGS_JSON`, creds.instagramSettingsJson);
  setAlways(`${prefix}_INSTAGRAM_PROXY`, creds.instagramProxy);
  // Unprefixed globals are shared across profiles — don't let the last-loaded
  // profile clobber them; only fill in when absent.
  setIfMissing("INSTAGRAM_SESSION_ID", creds.instagramSessionId);
  setIfMissing("INSTAGRAM_SETTINGS_JSON", creds.instagramSettingsJson);
  setIfMissing(`${prefix}_INSTAGRAM_USERNAME`, creds.instagramUsername);
  setIfMissing(`${prefix}_INSTAGRAM_PASSWORD`, creds.instagramPassword);
  setIfMissing(`${prefix}_INSTAGRAM_TOTP_SECRET`, creds.instagramTotpSecret);
  setIfMissing("INSTAGRAM_USERNAME", creds.instagramUsername);
  setIfMissing("INSTAGRAM_PASSWORD", creds.instagramPassword);
  setIfMissing("INSTAGRAM_TOTP_SECRET", creds.instagramTotpSecret);
}
