import http from 'http';
import url from 'url';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import { exec } from 'child_process';

dotenv.config();

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
const redirectUri = process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3000/oauth2callback';

if (!clientId || !clientSecret) {
  console.error('\n❌ ERROR: YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be set in your .env file first!');
  console.error('Please configure them in your .env file and run this script again.\n');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  clientId,
  clientSecret,
  redirectUri
);

// Define YouTube scopes
const scopes = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly'
];

// Generate auth url
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline', // Critical: this requests the refresh_token
  scope: scopes,
  prompt: 'consent' // Forces approval screen to guarantee refresh_token is returned
});

console.log('\n======================================================');
console.log('🤖 YouTube Shorts Automation - Google OAuth2 Helper');
console.log('======================================================\n');
console.log('1. Attempting to open the Google authorization link in your browser...');
console.log('If it does not open automatically, copy and paste this URL into your browser:\n');
console.log(authUrl);
console.log('\n------------------------------------------------------');
console.log('Waiting for login response on localhost:3000...');

// Try to open browser automatically
try {
  const startCommand = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${startCommand} "${authUrl}"`);
} catch (_) {}

// Start temporary local server to capture authorization code redirect
const server = http.createServer(async (req, res) => {
  try {
    if (req.url && req.url.startsWith('/oauth2callback')) {
      const q = url.parse(req.url, true).query;
      const code = q.code as string;

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization failed: No code returned</h1>');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Authentication Successful!</h1><p>You can close this tab and return to your terminal.</p>');

      console.log('\n✔ Authorization code received successfully!');
      console.log('Exchanging code for tokens...');

      const { tokens } = await oauth2Client.getToken(code);
      
      console.log('\n======================================================');
      console.log('🎉 REFRESH TOKEN GENERATED SUCCESSFULLY!');
      console.log('======================================================\n');
      console.log('Add the following refresh token to your .env file:\n');
      console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('\n======================================================\n');

      server.close(() => {
        console.log('OAuth server closed. Script finished.');
        process.exit(0);
      });
    }
  } catch (err) {
    console.error('Error during token exchange:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server Error');
    process.exit(1);
  }
});

// Port matches redirect URI
server.listen(3000, () => {
  console.log('Local callback server is listening on port 3000...\n');
});
