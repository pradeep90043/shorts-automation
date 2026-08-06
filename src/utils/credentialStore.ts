import { getPool } from "./pgClient";

export interface ChannelCredentials {
  profileKey: string;
  instagramSessionId?: string;
  instagramUsername?: string;
  instagramPassword?: string;
  instagramEmail?: string;
  updatedAt?: Date;
}

export async function getChannelCredentials(profileKey: string): Promise<ChannelCredentials | null> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT profile_key, instagram_session_id, instagram_username, instagram_password, instagram_email, updated_at
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
    updatedAt: row.updated_at,
  };
}

export async function saveChannelCredentials(creds: ChannelCredentials): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO channel_credentials (profile_key, instagram_session_id, instagram_username, instagram_password, instagram_email, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (profile_key) DO UPDATE SET
       instagram_session_id = EXCLUDED.instagram_session_id,
       instagram_username   = EXCLUDED.instagram_username,
       instagram_password   = EXCLUDED.instagram_password,
       instagram_email      = EXCLUDED.instagram_email,
       updated_at           = NOW()`,
    [
      creds.profileKey.toLowerCase(),
      creds.instagramSessionId || null,
      creds.instagramUsername || null,
      creds.instagramPassword || null,
      creds.instagramEmail || null,
    ],
  );
}

/** Load DB credentials into process.env as fallback (only sets if env var not already present). */
export async function loadCredentialsToEnv(profileKey: string): Promise<void> {
  const creds = await getChannelCredentials(profileKey);
  if (!creds) return;
  const prefix = profileKey.toUpperCase().replace(/-/g, "_");
  const setIfMissing = (envKey: string, value: string | undefined) => {
    if (value && !process.env[envKey]) process.env[envKey] = value;
  };
  setIfMissing(`${prefix}_INSTAGRAM_SESSION_ID`, creds.instagramSessionId);
  setIfMissing(`${prefix}_INSTAGRAM_USERNAME`, creds.instagramUsername);
  setIfMissing(`${prefix}_INSTAGRAM_PASSWORD`, creds.instagramPassword);
  setIfMissing("INSTAGRAM_SESSION_ID", creds.instagramSessionId);
  setIfMissing("INSTAGRAM_USERNAME", creds.instagramUsername);
  setIfMissing("INSTAGRAM_PASSWORD", creds.instagramPassword);
}
