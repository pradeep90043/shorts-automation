/**
 * One-off: take the never-expiring Meta System User tokens from env
 * (ADMIN_CODEORCAP_TOKEN / ADMIN_STORIYUM_TOKEN / ADMIN_PROMPTGAG_TOKEN),
 * derive the matching never-expiring Page access token for each, verify the
 * Page↔Instagram link, and write ONLY the token columns into channel_configs.
 *
 * Run locally once:   npx ts-node scripts/wire-meta-tokens.ts
 * Requires in .env:    DATABASE_URL, META_APP_ID, META_APP_SECRET, ADMIN_*_TOKEN
 */
import "dotenv/config";
import { Pool } from "pg";

const GV = "v19.0";
const APP_ID = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || "";
const APP_SECRET = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || "";

const CHANNELS: Record<string, { env: string; pageId: string; igId: string }> = {
  codeorcap:  { env: "ADMIN_CODEORCAP_TOKEN",  pageId: "1155595804312771", igId: "17841468985961363" },
  storiyum:   { env: "ADMIN_STORIYUM_TOKEN",   pageId: "1244228672098266", igId: "17841415627232845" },
  prompt_gag: { env: "ADMIN_PROMPTGAG_TOKEN",  pageId: "1290985010756929", igId: "17841444444088275" },
};

async function g(path: string, params: Record<string, string>): Promise<any> {
  const url = `https://graph.facebook.com/${GV}/${path}?` + new URLSearchParams(params).toString();
  const r = await fetch(url);
  return r.json();
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const appTok = APP_ID && APP_SECRET ? `${APP_ID}|${APP_SECRET}` : "";
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1|sslmode=disable/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });

  for (const [key, cfg] of Object.entries(CHANNELS)) {
    const suToken = (process.env[cfg.env] || "").trim();
    if (!suToken) { console.log(`SKIP ${key} — ${cfg.env} not set`); continue; }

    // Derive the Page access token from the system-user token.
    const pg = await g(cfg.pageId, { fields: "name,access_token,instagram_business_account{id,username}", access_token: suToken });
    if (pg.error || !pg.access_token) { console.log(`FAIL ${key} — cannot get page token: ${pg.error?.message || JSON.stringify(pg)}`); continue; }
    const pageToken: string = pg.access_token;
    const iba = pg.instagram_business_account;

    // Verify longevity.
    let expiryNote = "";
    if (appTok) {
      const dbg = await g("debug_token", { input_token: pageToken, access_token: appTok });
      const d = dbg.data || {};
      expiryNote = `type=${d.type} expires=${d.expires_at ? new Date(d.expires_at * 1000).toISOString() : "NEVER"} data_access=${d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000).toISOString() : "NEVER"}`;
    }

    if (!iba || iba.id !== cfg.igId) {
      console.log(`WARN ${key} — page "${pg.name}" IG link is ${iba ? "@" + iba.username + " (" + iba.id + ")" : "NONE"}, expected ${cfg.igId}`);
    }

    const igAccounts = JSON.stringify([{ name: `${pg.name} Instagram`, igUserId: cfg.igId, accessToken: pageToken }]);
    await pool.query(
      `UPDATE channel_configs SET
         instagram_access_token = $1,
         facebook_access_token  = $1,
         facebook_page_id       = $2,
         instagram_user_id      = $3,
         instagram_accounts     = $4::jsonb,
         updated_at             = NOW()
       WHERE key = $5`,
      [pageToken, cfg.pageId, cfg.igId, igAccounts, key],
    );
    console.log(`OK   ${key} — page "${pg.name}" @${iba?.username} — wrote page token (${pageToken.length} chars). ${expiryNote}`);
  }

  await pool.end();
  console.log("\nDone. Restart / redeploy prod so it re-reads config, or it will pick up on the next config refresh.");
}

main().catch((e) => { console.error(e); process.exit(1); });
