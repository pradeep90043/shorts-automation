import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import https from "https";
import puppeteer from "puppeteer-core";
import { pipelineLogger } from "../utils/logger";
import { config } from "../config";

const CHROME_PATH = config.binaries.chrome;
const YTDLP = config.binaries.ytdlp;
const FFMPEG = config.binaries.ffmpeg;
const PYTHON3 = config.binaries.python3;

// Resolve manual cookies.txt in the project root if it exists, otherwise fall back to temp file
const PROJECT_COOKIES_PATH = path.resolve(__dirname, "../../cookies.txt");
const COOKIES_FILE = fs.existsSync(PROJECT_COOKIES_PATH)
  ? PROJECT_COOKIES_PATH
  : "/tmp/instagram_cookies.txt";

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
  // If a manual cookies.txt is provided in the project root, don't run export
  if (fs.existsSync(PROJECT_COOKIES_PATH)) {
    pipelineLogger.info(
      "Using manual cookies.txt from project root",
      "Instagram",
    );
    return;
  }

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
  try {
    await runCommand(PYTHON3, ["-c", script], "cookie-export");
    pipelineLogger.info("Instagram cookies exported from Chrome", "Instagram");
  } catch (err) {
    pipelineLogger.warn(
      `Failed to export Instagram cookies from browser: ${err instanceof Error ? err.message : err}. Proceeding without fresh cookies.`,
      "Instagram",
    );
  }
}

export interface DownloadReelResult {
  framePath: string;
  instagramSourceType: "image" | "image_with_music" | "video";
  videoPath?: string;
}

/**
 * Download any Instagram URL (reel, post, IGTV, story) and return a JPEG frame.
 * - Video content → download mp4, extract frame at 2s
 * - Image post     → download image directly
 * - Carousel       → use first item
 */
export async function downloadReelFrame(
  url: string,
  destDir: string,
): Promise<DownloadReelResult> {
  const framePath = path.join(destDir, "original.jpg");

  pipelineLogger.info(`Downloading Instagram content: ${url}`, "Instagram");

  // Export fresh cookies from Chrome (handles macOS keychain encryption)
  await exportCookies();

  // --- Step 1: try yt-dlp (video download + frame extraction) ---
  try {
    const videoTemplate = path.join(destDir, "reel_video.%(ext)s");

    await runCommand(
      YTDLP,
      [
        "--no-playlist",
        "--cookies",
        COOKIES_FILE,
        "--playlist-items",
        "1",
        "-o",
        videoTemplate,
        "--no-warnings",
        url,
      ],
      "yt-dlp",
    );

    const videoFile = fs
      .readdirSync(destDir)
      .find((f) => /\.(mp4|mov|webm|mkv|m4v)$/i.test(f));

    if (videoFile) {
      const videoPath = path.join(destDir, videoFile);
      pipelineLogger.info(`Video downloaded → ${videoPath}`, "Instagram");

      // Check if it is a static image with music or a dynamic video
      const isStatic = await checkIfVideoIsStatic(videoPath);
      const instagramSourceType = isStatic ? "image_with_music" : "video";
      pipelineLogger.info(
        `Content detected as: ${instagramSourceType}`,
        "Instagram",
      );

      await runCommand(
        FFMPEG,
        [
          "-y",
          "-ss",
          "00:00:02",
          "-i",
          videoPath,
          "-vframes",
          "1",
          "-q:v",
          "2",
          framePath,
        ],
        "ffmpeg",
      );

      if (fs.existsSync(framePath)) {
        pipelineLogger.checkpoint(
          `Instagram frame extracted via yt-dlp (${instagramSourceType})`,
          true,
          framePath,
        );
        if (instagramSourceType === "video") {
          return { framePath, instagramSourceType, videoPath };
        } else {
          try {
            fs.unlinkSync(videoPath);
          } catch {}
          return { framePath, instagramSourceType };
        }
      }
    }
  } catch (err) {
    pipelineLogger.warn(
      `yt-dlp failed (${err instanceof Error ? err.message.slice(0, 120) : err}), falling back to Puppeteer extraction`,
      "Instagram",
    );
  }

  // --- Step 2: Puppeteer fallback — attempt to extract video src or screenshot the post ---
  pipelineLogger.info(
    "Using Puppeteer to retrieve Instagram post content…",
    "Instagram",
  );
  return await downloadViaPuppeteer(url, destDir, framePath);
}

/**
 * Helper to download a file from a URL using standard https module (handles redirects)
 */
async function downloadFileFromUrl(
  url: string,
  destPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    const request = (targetUrl: string) => {
      https
        .get(targetUrl, (response) => {
          if (
            response.statusCode === 301 ||
            response.statusCode === 302 ||
            response.statusCode === 307 ||
            response.statusCode === 308
          ) {
            if (response.headers.location) {
              request(response.headers.location);
              return;
            }
          }

          if (response.statusCode !== 200) {
            reject(
              new Error(
                `Failed to download video file: status code ${response.statusCode}`,
              ),
            );
            return;
          }

          response.pipe(file);

          file.on("finish", () => {
            file.close();
            resolve();
          });
        })
        .on("error", (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
    };

    request(url);
  });
}

/**
 * Extract video directly or screenshot an Instagram post using the public embed URL.
 * Works for images, carousels, and reels.
 */
async function downloadViaPuppeteer(
  url: string,
  destDir: string,
  framePath: string,
): Promise<DownloadReelResult> {
  const match = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (!match)
    throw new Error(`Cannot extract shortcode from Instagram URL: ${url}`);
  const shortcode = match[1];
  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;

  pipelineLogger.info(
    `Loading Instagram embed via Puppeteer: ${embedUrl}`,
    "Instagram",
  );

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    const page = await browser.newPage();
    // Standard desktop viewport sized for the embed widget
    await page.setViewport({ width: 600, height: 700, deviceScaleFactor: 2 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );

    await page.goto(embedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    // Wait for the embedded post image or video to load
    await page
      .waitForSelector("img, video", { timeout: 15_000 })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    // Try to extract video src URL
    const videoSrc = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      if (!doc) return null;
      const videoEl = doc.querySelector("video");
      if (!videoEl) return null;
      const src = videoEl.getAttribute("src");
      if (src) return src;
      const sourceEl = videoEl.querySelector("source");
      return sourceEl ? sourceEl.getAttribute("src") : null;
    });

    if (videoSrc) {
      pipelineLogger.info(
        `Found video source URL in Instagram embed: ${videoSrc}`,
        "Instagram",
      );
      const videoPath = path.join(destDir, "reel_video.mp4");

      try {
        await downloadFileFromUrl(videoSrc, videoPath);
        pipelineLogger.info(
          `Video downloaded successfully via Puppeteer to: ${videoPath}`,
          "Instagram",
        );

        const isStatic = await checkIfVideoIsStatic(videoPath);
        const instagramSourceType = isStatic ? "image_with_music" : "video";
        pipelineLogger.info(
          `Content detected as: ${instagramSourceType}`,
          "Instagram",
        );

        // Extract frame at 2s
        await runCommand(
          FFMPEG,
          [
            "-y",
            "-ss",
            "00:00:02",
            "-i",
            videoPath,
            "-vframes",
            "1",
            "-q:v",
            "2",
            framePath,
          ],
          "ffmpeg",
        );

        if (fs.existsSync(framePath)) {
          pipelineLogger.checkpoint(
            `Instagram frame extracted via Puppeteer video download (${instagramSourceType})`,
            true,
            framePath,
          );
          if (instagramSourceType === "video") {
            return { framePath, instagramSourceType, videoPath };
          } else {
            try {
              fs.unlinkSync(videoPath);
            } catch {}
            return { framePath, instagramSourceType };
          }
        }
      } catch (dlErr) {
        pipelineLogger.warn(
          `Failed to download video from source URL or extract frame: ${dlErr instanceof Error ? dlErr.message : dlErr}. Falling back to screenshot.`,
          "Instagram",
        );
      }
    }

    // Fallback to taking a screenshot
    pipelineLogger.info(
      "No video found or download failed, taking screenshot fallback...",
      "Instagram",
    );

    const embedFrameSelector = ".EmbedFrame";
    await page
      .waitForSelector(embedFrameSelector, { timeout: 5000 })
      .catch(() => {});
    const embedFrame = await page.$(embedFrameSelector);

    if (embedFrame) {
      pipelineLogger.info(
        "Cropping to .EmbedFrame element directly in Puppeteer",
        "Instagram",
      );
      await embedFrame.screenshot({
        path: framePath as `${string}.jpg`,
        type: "jpeg",
        quality: 92,
      });
    } else {
      pipelineLogger.warn(
        "Could not find .EmbedFrame selector, falling back to fullPage screenshot",
        "Instagram",
      );
      await page.screenshot({
        path: framePath as `${string}.jpg`,
        type: "jpeg",
        quality: 92,
        fullPage: true,
      });
    }

    pipelineLogger.checkpoint(
      "Instagram post screenshotted via embed URL",
      true,
      framePath,
    );

    return { framePath, instagramSourceType: "image" };
  } finally {
    await browser.close();
  }
}

/**
 * Decodes the first 5 seconds of the video, downscales to 8x8 grayscale,
 * and calculates the average pixel difference between consecutive frames.
 * If the average pixel change is below a threshold (e.g. 0.15 gray levels),
 * it is considered a static image with background music.
 */
async function checkIfVideoIsStatic(videoPath: string): Promise<boolean> {
  try {
    // We downscale to 8x8 and force gray color space at 1 frame per second.
    // This allows us to handle compression noise, progress bars, and minor artifacts.
    const buffer = await runCommandWithBufferOutput(
      FFMPEG,
      [
        "-t",
        "5",
        "-i",
        videoPath,
        "-an",
        "-vf",
        "fps=fps=1,scale=8:8,format=gray",
        "-f",
        "rawvideo",
        "-",
      ],
      "check-static-video",
    );

    const numFrames = Math.floor(buffer.length / 64);
    if (numFrames <= 1) {
      // Not enough frames to determine change (assume static)
      return true;
    }

    const frames: Buffer[] = [];
    for (let i = 0; i < numFrames; i++) {
      frames.push(buffer.subarray(i * 64, (i + 1) * 64));
    }

    let totalDiff = 0;
    let comparisons = 0;

    for (let i = 1; i < frames.length; i++) {
      const f1 = frames[i];
      const f0 = frames[i - 1];
      let frameDiff = 0;
      for (let j = 0; j < 64; j++) {
        frameDiff += Math.abs(f1[j] - f0[j]);
      }
      totalDiff += frameDiff / 64;
      comparisons++;
    }

    const avgDiffPerPixel = comparisons > 0 ? totalDiff / comparisons : 0;
    pipelineLogger.info(
      `Average frame difference score: ${avgDiffPerPixel.toFixed(3)}`,
      "Instagram",
    );

    // Threshold of 0.15 gray levels difference per pixel on average.
    // Static reels (image + music) have practically 0 difference.
    // Zooming edits have >0.9 difference, real videos have even higher.
    const isStatic = avgDiffPerPixel < 0.15;
    return isStatic;
  } catch (err) {
    pipelineLogger.warn(
      `Failed to check if video is static: ${err instanceof Error ? err.message : err}. Assuming dynamic video.`,
      "Instagram",
    );
    return false;
  }
}

function runCommand(bin: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`${label} failed (exit ${code}): ${stderr.slice(-400)}`),
        );
      }
    });

    child.on("error", reject);
  });
}

function runCommandWithBufferOutput(
  bin: string,
  args: string[],
  label: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(
          new Error(`${label} failed (exit ${code}): ${stderr.slice(-400)}`),
        );
      }
    });

    child.on("error", reject);
  });
}
