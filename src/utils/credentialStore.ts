import path from "path";
import { execFile } from "child_process";
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

/**
 * Spawns get_session_id.py with stored username+password, saves the returned
 * session ID back to the DB and into process.env.  Returns the new session ID
 * on success, null if credentials are missing or login fails.
 */
export async function refreshSessionForProfile(profileKey: string): Promise<string | null> {
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
        },
      },
      async (err, stdout) => {
        const sessionId = stdout.trim();
        if (err || !sessionId) { resolve(null); return; }
        try {
          await saveChannelCredentials({ ...creds, instagramSessionId: sessionId });
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
