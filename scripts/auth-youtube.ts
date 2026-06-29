/**
 * Run once per YouTube channel to get its refresh token.
 *
 * Usage:
 *   npx ts-node scripts/auth-youtube.ts 1    ← for Channel 1
 *   npx ts-node scripts/auth-youtube.ts 2    ← for Channel 2
 *   npx ts-node scripts/auth-youtube.ts 3    ← for Channel 3
 *
 * It opens a browser URL, you log into that YouTube channel, grant access,
 * and the script prints the refresh token to paste into .env.
 */

import http from 'http';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || '';
const REDIRECT_URI  = 'http://localhost:3000/oauth2callback';
const CHANNEL_NUM   = process.argv[2] || '1';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌  YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be set in .env\n');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',   // force consent screen so we always get a refresh token
  scope: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube',
  ],
});

console.log('\n══════════════════════════════════════════════════════');
console.log(` YouTube Auth — Channel ${CHANNEL_NUM}`);
console.log('══════════════════════════════════════════════════════');
console.log('\n1. Make sure you are logged into the correct YouTube channel in your browser.');
console.log('   (Use an incognito window if needed to pick the right account.)\n');
console.log('2. Open this URL:\n');
console.log(`   ${authUrl}\n`);
console.log('3. Grant access — the page will redirect to localhost:3000.');
console.log('   This script will capture the code automatically.\n');

// Local server to catch the OAuth callback
const server = http.createServer(async (req, res) => {
  const url  = new URL(req.url || '/', `http://localhost:3000`);
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400);
    res.end('No code found in callback URL.');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h2 style="font-family:sans-serif;padding:40px">✅ Auth successful! You can close this tab and check the terminal.</h2>');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      console.error('\n❌  No refresh token returned. Try revoking app access at');
      console.error('   https://myaccount.google.com/permissions  and run this script again.\n');
    } else {
      console.log('══════════════════════════════════════════════════════');
      console.log(` ✅  Refresh token for Channel ${CHANNEL_NUM}:`);
      console.log('══════════════════════════════════════════════════════\n');
      console.log(`YOUTUBE_CHANNEL_${CHANNEL_NUM}_REFRESH_TOKEN=${refreshToken}\n`);
      console.log('Paste the line above into your .env file.\n');
    }
  } catch (err) {
    console.error('❌  Token exchange failed:', err);
  }

  server.close();
  process.exit(0);
});

server.listen(3000, () => {
  console.log('Waiting for OAuth callback on http://localhost:3000 …\n');
});
