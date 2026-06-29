import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { pipelineLogger } from '../utils/logger';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const YTDLP   = '/opt/homebrew/bin/yt-dlp';
const FFMPEG  = '/opt/homebrew/bin/ffmpeg';
const PYTHON3 = '/opt/anaconda3/bin/python3';
const COOKIES_FILE = '/tmp/instagram_cookies.txt';

// Match all Instagram content URL formats:
// /reel/, /p/, /tv/, /stories/, share links with ?igsh=...
const INSTAGRAM_REGEX =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p|tv|stories\/[^/]+)\/([A-Za-z0-9_-]+)\/?/;

export function isInstagramReelUrl(text: string): boolean {
  return INSTAGRAM_REGEX.test(text);
}

export function extractInstagramUrl(text: string): string | null {
  const m = text.match(INSTAGRAM_REGEX);
  return m ? m[0] : null;
}

/**
 * Export Instagram cookies from Chrome using browser_cookie3.
 * Chrome encrypts cookies; --cookies-from-browser in yt-dlp doesn't decrypt
 * them properly on macOS, so we export via Python first.
 */
async function exportCookies(): Promise<void> {
  const script = `
import browser_cookie3, time, sys
try:
    cj = browser_cookie3.chrome(domain_name='.instagram.com')
    cookies = list(cj)
    if not cookies:
        sys.exit(1)
    lines = ["# Netscape HTTP Cookie File"]
    for c in cookies:
        inc_sub = "TRUE" if c.domain.startswith('.') else "FALSE"
        secure  = "TRUE" if c.secure else "FALSE"
        expires = str(int(c.expires)) if c.expires else str(int(time.time()) + 86400*365)
        lines.append(f"{c.domain}\\t{inc_sub}\\t{c.path}\\t{secure}\\t{expires}\\t{c.name}\\t{c.value}")
    with open('${COOKIES_FILE}', 'w') as f:
        f.write('\\n'.join(lines))
    print(f"Exported {len(cookies)} cookies")
except Exception as e:
    print(f"Cookie export failed: {e}", file=sys.stderr)
    sys.exit(1)
`;
  await runCommand(PYTHON3, ['-c', script], 'cookie-export');
  pipelineLogger.info('Instagram cookies exported from Chrome', 'Instagram');
}

/**
 * Download any Instagram URL (reel, post, IGTV, story) and return a JPEG frame.
 * - Video content → download mp4, extract frame at 2s
 * - Image post     → download image directly
 * - Carousel       → use first item
 */
export async function downloadReelFrame(
  url: string,
  destDir: string
): Promise<string> {
  const framePath = path.join(destDir, 'original.jpg');

  pipelineLogger.info(`Downloading Instagram content: ${url}`, 'Instagram');

  // Export fresh cookies from Chrome (handles macOS keychain encryption)
  await exportCookies();

  // --- Step 1: try yt-dlp (video download + frame extraction) ---
  try {
    const videoTemplate = path.join(destDir, 'reel_video.%(ext)s');

    await runCommand(YTDLP, [
      '--no-playlist',
      '--cookies', COOKIES_FILE,
      '--playlist-items', '1',
      '-o', videoTemplate,
      '--no-warnings',
      url,
    ], 'yt-dlp');

    const videoFile = fs.readdirSync(destDir)
      .find(f => /\.(mp4|mov|webm|mkv|m4v)$/i.test(f));

    if (videoFile) {
      const videoPath = path.join(destDir, videoFile);
      pipelineLogger.info(`Video downloaded → ${videoPath}`, 'Instagram');

      await runCommand(FFMPEG, [
        '-y', '-ss', '00:00:02',
        '-i', videoPath,
        '-vframes', '1', '-q:v', '2',
        framePath,
      ], 'ffmpeg');

      if (fs.existsSync(framePath)) {
        pipelineLogger.checkpoint('Instagram frame extracted via yt-dlp', true, framePath);
        try { fs.unlinkSync(videoPath); } catch {}
        return framePath;
      }
    }
  } catch (err) {
    pipelineLogger.warn(
      `yt-dlp failed (${err instanceof Error ? err.message.slice(0, 120) : err}), falling back to Puppeteer screenshot`,
      'Instagram'
    );
  }

  // --- Step 2: Puppeteer fallback — screenshot the rendered post ---
  // Works for image carousels, protected posts, and anything yt-dlp can't handle.
  pipelineLogger.info('Using Puppeteer to screenshot Instagram post…', 'Instagram');
  await screenshotInstagramPost(url, framePath);

  if (!fs.existsSync(framePath)) {
    throw new Error('Puppeteer screenshot did not produce an image');
  }

  return framePath;
}

/**
 * Screenshot an Instagram post using the public embed URL.
 * The embed endpoint (/p/{shortcode}/embed/) requires no login and shows no dialogs.
 * Works for images, carousels, and reels.
 */
async function screenshotInstagramPost(url: string, outputPath: string): Promise<void> {
  // Convert any Instagram post URL to its public embed URL
  const match = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`Cannot extract shortcode from Instagram URL: ${url}`);
  const shortcode = match[1];
  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;

  pipelineLogger.info(`Loading Instagram embed: ${embedUrl}`, 'Instagram');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    // Standard desktop viewport sized for the embed widget
    await page.setViewport({ width: 600, height: 700, deviceScaleFactor: 2 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 30_000 });

    // Wait for the embedded post image or video to load
    await page.waitForSelector('img, video', { timeout: 15_000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    // Crop to just the content — remove the Instagram embed chrome (header/footer)
    // The embed widget typically has a white border; screenshot the full page
    await page.screenshot({ path: outputPath as `${string}.jpg`, type: 'jpeg', quality: 92, fullPage: true });

    pipelineLogger.checkpoint('Instagram post screenshotted via embed URL', true, outputPath);
  } finally {
    await browser.close();
  }
}

function runCommand(bin: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} failed (exit ${code}): ${stderr.slice(-400)}`));
      }
    });

    child.on('error', reject);
  });
}
