import http from 'http';
import fs from 'fs';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import path from 'path';
import { Pool } from 'pg';

const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || '';
const CHANNEL_ARG   = (process.argv[2] || 'infoonspot').toLowerCase().trim();
const PORT          = parseInt(process.argv[3] || '3000', 10);
const REDIRECT_URI  = process.env.YOUTUBE_LOCAL_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌  YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be set in .env\n');
  process.exit(1);
}

function resolveChannelInfo(arg: string): { key: string; brandName: string; envKey: string } {
  if (arg === 'infoonspot' || arg === 'info_on_spot') {
    return { key: 'infoonspot', brandName: 'InfoOnSpot', envKey: 'INFOONSPOT_YOUTUBE_REFRESH_TOKEN' };
  }
  if (arg === 'prompt_gag' || arg === 'promptgag' || arg === 'humor') {
    return { key: 'prompt_gag', brandName: 'PromptGag', envKey: 'PROMPT_GAG_YOUTUBE_REFRESH_TOKEN' };
  }
  if (arg === 'storiyum' || arg === 'stories') {
    return { key: 'storiyum', brandName: 'Storiyum', envKey: 'STORIYUM_YOUTUBE_REFRESH_TOKEN' };
  }
  if (arg === 'codeorcap' || arg === 'tech' || arg === '1') {
    return { key: 'codeorcap', brandName: 'CodeOrCap', envKey: 'YOUTUBE_CHANNEL_1_REFRESH_TOKEN' };
  }
  const clean = arg.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return { key: arg.toLowerCase(), brandName: arg, envKey: `${clean}_YOUTUBE_REFRESH_TOKEN` };
}

const chInfo = resolveChannelInfo(CHANNEL_ARG);
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',   // force consent screen so Google always issues a refresh token
  scope: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.readonly',
  ],
});

console.log('\n══════════════════════════════════════════════════════');
console.log(` YouTube Auth — Channel: ${chInfo.brandName} (${chInfo.key})`);
console.log(` Redirect URI: ${REDIRECT_URI}`);
console.log('══════════════════════════════════════════════════════');
console.log('\n1. Make sure you are logged into the correct YouTube account in your browser.');
console.log('   (Use an incognito / private browser window if needed to pick the right Google account.)\n');
console.log('2. Open this URL in your browser:\n');
console.log(`   ${authUrl}\n`);
console.log(`3. Grant permissions. The browser will redirect to ${REDIRECT_URI}.`);
console.log('   This script will capture the OAuth code automatically.\n');

// Local server to catch the OAuth callback
const server = http.createServer(async (req, res) => {
  const url  = new URL(req.url || '/', `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h2 style="font-family:sans-serif;color:#e1306c;padding:40px">❌ OAuth Error: ${error}</h2>`);
    console.error(`\n❌  OAuth authorization denied: ${error}\n`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<h2 style="font-family:sans-serif;padding:40px">No code found in callback URL.</h2>');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <div style="font-family:system-ui,-apple-system,sans-serif;padding:40px;line-height:1.6;max-width:600px;margin:auto;">
      <h2 style="color:#10b981;">✅ YouTube Authentication Successful!</h2>
      <p>Authorized channel: <b>${chInfo.brandName}</b></p>
      <p style="color:#666;">The refresh token has been captured and saved. You can close this tab and return to the terminal.</p>
    </div>
  `);

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      console.error('\n❌  No refresh token returned. Try revoking app access at');
      console.error('   https://myaccount.google.com/permissions  and run this script again.\n');
    } else {
      console.log('══════════════════════════════════════════════════════');
      console.log(` ✅  Refresh token for ${chInfo.brandName} (${chInfo.key}):`);
      console.log('══════════════════════════════════════════════════════\n');
      console.log(`${chInfo.envKey}=${refreshToken}\n`);

      // Update local .env
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf8');
        const regex = new RegExp(`^${chInfo.envKey}=.*$`, 'm');
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, `${chInfo.envKey}=${refreshToken}`);
        } else {
          envContent += `\n${chInfo.envKey}=${refreshToken}\n`;
        }
        fs.writeFileSync(envPath, envContent, 'utf8');
        console.log(`✅ Updated ${chInfo.envKey} in .env`);
      }

      // Update DB if DATABASE_URL is present
      const dbUrl = process.env.DATABASE_URL;
      if (dbUrl) {
        try {
          const pool = new Pool({
            connectionString: dbUrl,
            ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false },
          });
          const ytChannels = JSON.stringify([{ name: chInfo.brandName, refreshToken }]);
          await pool.query(
            `UPDATE channel_configs SET
               youtube_refresh_token = $1,
               youtube_channels = $2::jsonb,
               updated_at = NOW()
             WHERE key = $3`,
            [refreshToken, ytChannels, chInfo.key],
          );
          await pool.end();
          console.log(`✅ Updated channel_configs in database for "${chInfo.key}".`);
        } catch (dbErr) {
          console.warn('⚠️  Could not update database channel_configs:', dbErr instanceof Error ? dbErr.message : dbErr);
        }
      }

      console.log('\nAll set! Make sure to copy this token into your production environment secret (PRODUCTION_ENV).\n');
    }
  } catch (err) {
    console.error('❌  Token exchange failed:', err);
  }

  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Waiting for OAuth callback on ${REDIRECT_URI} …\n`);
});
