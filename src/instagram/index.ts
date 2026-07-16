import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import https from "https";
import { pipelineLogger } from "../utils/logger";
import { config } from "../config";

const CHROME_PATH = config.binaries.chrome;
const YTDLP = config.binaries.ytdlp;
const FFMPEG = config.binaries.ffmpeg;
const FFPROBE = config.binaries.ffprobe;
const PYTHON3 = config.binaries.python3;

// Resolve manual cookies.txt in the project root if it exists, otherwise fall back to temp file
const PROJECT_COOKIES_PATH = path.resolve(__dirname, "../../cookies.txt");
const COOKIES_FILE = "/tmp/instagram_cookies.txt";

// Match all Instagram content URL formats:
// /reel/, /p/, /tv/, /stories/, share links with ?igsh=...
const INSTAGRAM_REGEX =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p|tv|stories\/[^/]+)\/([A-Za-z0-9_-]+)\/?/;

const TIKTOK_REGEX = /https?:\/\/(?:www\.)?tiktok\.com\/.*\/video\/(\d+)|https?:\/\/vm\.tiktok\.com\/([A-Za-z0-9]+)\/?/;

export function isInstagramReelUrl(text: string): boolean {
  return INSTAGRAM_REGEX.test(text);
}

export function isTikTokUrl(text: string): boolean {
  return TIKTOK_REGEX.test(text);
}

export function extractInstagramUrl(text: string): string | null {
  const m = text.match(INSTAGRAM_REGEX);
  return m ? m[0] : null;
}

export function extractTikTokUrl(text: string): string | null {
  const m = text.match(TIKTOK_REGEX);
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
  try {
    await runCommand(PYTHON3, ["-c", script], "cookie-export");
    pipelineLogger.info("Instagram cookies exported from Chrome", "Instagram");
    return;
  } catch (err) {
    pipelineLogger.warn(
      `Failed to export Instagram cookies from browser: ${err instanceof Error ? err.message : err}. Checking for manual cookies.`,
      "Instagram",
    );
  }

  // Fallback to manual cookies.txt in project root if browser export failed
  if (fs.existsSync(PROJECT_COOKIES_PATH)) {
    pipelineLogger.info(
      "Falling back to manual cookies.txt from project root",
      "Instagram",
    );
    try {
      fs.copyFileSync(PROJECT_COOKIES_PATH, COOKIES_FILE);
    } catch (copyErr) {
      pipelineLogger.error(
        `Failed to copy manual cookies: ${copyErr instanceof Error ? copyErr.message : copyErr}`,
        "Instagram",
      );
    }
  } else {
    pipelineLogger.warn(
      "No manual cookies.txt found in project root. Proceeding without cookies.",
      "Instagram",
    );
  }
}

export interface SourceCaption {
  title?: string;
  description?: string;
}

export interface DownloadReelResult {
  framePath: string;
  instagramSourceType: "image" | "image_with_music" | "video";
  videoPath?: string;
  sourceCaption?: SourceCaption;
}

/**
 * Download a TikTok video using the free TikWM API.
 * Returns the original post caption (TikWM's `title` field) when available.
 */
async function downloadTikTokViaTikwm(
  url: string,
  destDir: string,
): Promise<SourceCaption | undefined> {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`TikWM API failed with status ${res.status}`);
  const json = await res.json() as any;
  if (json.code !== 0 || !json.data?.play) {
    throw new Error(`TikWM API error: ${json.msg || "No video URL found"}`);
  }

  const videoUrl = json.data.play;
  const destPath = path.join(destDir, "reel_video.mp4");
  await downloadFileFromUrl(videoUrl, destPath);
  const caption = typeof json.data.title === "string" ? json.data.title.trim() : "";
  return caption ? { description: caption } : undefined;
}

/**
 * Read the yt-dlp .info.json written next to the downloaded video and pull out
 * the original post title/description (for Instagram, `description` is the caption).
 * Best-effort: never throws; the info.json is deleted after reading.
 */
function extractCaptionFromInfoJson(destDir: string): SourceCaption | undefined {
  try {
    const infoFile = fs
      .readdirSync(destDir)
      .find((f) => f.endsWith(".info.json"));
    if (!infoFile) return undefined;
    const infoPath = path.join(destDir, infoFile);
    const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
    try {
      fs.unlinkSync(infoPath);
    } catch {}
    const title = typeof info.title === "string" ? info.title.trim() : "";
    const description =
      typeof info.description === "string" ? info.description.trim() : "";
    if (!title && !description) return undefined;
    return {
      title: title || undefined,
      description: description || undefined,
    };
  } catch (err) {
    pipelineLogger.warn(
      `Failed to read caption from info.json: ${err instanceof Error ? err.message : err}`,
      "Instagram",
    );
    return undefined;
  }
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

  pipelineLogger.info(`Downloading content: ${url}`, "Downloader");

  // Export fresh cookies from Chrome (handles macOS keychain encryption)
  if (url.includes("instagram.com")) {
    await exportCookies();
  }

  // --- Step 1: Download video (TikTok vs yt-dlp) ---
  try {
    const videoTemplate = path.join(destDir, "reel_video.%(ext)s");
    let sourceCaption: SourceCaption | undefined;

    if (url.includes("tiktok.com")) {
      pipelineLogger.info("Attempting download via TikWM API...", "TikTok");
      sourceCaption = await downloadTikTokViaTikwm(url, destDir);
    } else {
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
          "--write-info-json",
          "--no-warnings",
          url,
        ],
        "yt-dlp",
      );
      sourceCaption = extractCaptionFromInfoJson(destDir);
    }

    if (sourceCaption) {
      pipelineLogger.info(
        `Original post caption captured (${(sourceCaption.description || sourceCaption.title || "").length} chars)`,
        "Downloader",
      );
    } else {
      pipelineLogger.info("No original post caption found", "Downloader");
    }

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
          return { framePath, instagramSourceType, videoPath, sourceCaption };
        } else {
          try {
            fs.unlinkSync(videoPath);
          } catch {}
          return { framePath, instagramSourceType, sourceCaption };
        }
      }
    }
  } catch (err) {
    pipelineLogger.warn(
      `yt-dlp failed (${err instanceof Error ? err.message.slice(0, 120) : err})`,
      "Downloader",
    );
    if (!url.includes("instagram.com")) {
      throw err; // Do not fallback to Puppeteer for TikTok/other
    }
    pipelineLogger.info("Falling back to Puppeteer extraction", "Instagram");
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
function parseNetscapeCookies(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const cookies: any[] = [];
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim() || line.startsWith("#")) continue;
      const parts = line.split("\t");
      if (parts.length < 7) continue;
      const [domain, , pathVal, secure, expires, name, value] = parts;
      cookies.push({
        name: name.trim(),
        value: value.trim(),
        domain: domain.trim(),
        path: pathVal.trim(),
        secure: secure.trim() === "TRUE",
        expires: parseInt(expires.trim()) || undefined,
      });
    }
    return cookies;
  } catch (err) {
    pipelineLogger.warn(`Failed to parse cookies file: ${err}`, "Instagram");
    return [];
  }
}

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

  const puppeteerModule = await new Function("return import('puppeteer-core')")();
  const puppeteer = puppeteerModule.default;

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    timeout: 90000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setBypassCSP(true);
    // Standard viewport (large height for direct reels page scroll)
    await page.setViewport({ width: 1280, height: 1920, deviceScaleFactor: 2 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );

    // Load cookies if available
    const cookies = parseNetscapeCookies(COOKIES_FILE);
    if (cookies.length > 0) {
      pipelineLogger.info(
        `Setting ${cookies.length} cookies in Puppeteer session`,
        "Instagram",
      );
      await page.setCookie(...cookies);
    }

    // The reel page also preloads NEIGHBORING reels from the feed, so the
    // first intercepted video URL is often a different reel entirely. The
    // requested reel is the one actually playing, and the player fetches many
    // byte-range segments of it while preloads fetch only one or two — so we
    // count requests per (byte-range-stripped) URL and pick the busiest one.
    const interceptedVideoUrls = new Map<string, number>();
    page.on("response", (response: any) => {
      const resUrl = response.url();
      if (
        (resUrl.includes(".mp4") || resUrl.includes("mime=video")) &&
        (resUrl.includes("fbcdn.net") || resUrl.includes("instagram.com"))
      ) {
        try {
          const parsed = new URL(resUrl);

          // Decode Facebook/Instagram efg encoding metadata parameter to check if it's an audio stream
          const efg = parsed.searchParams.get("efg");
          if (efg) {
            try {
              const decoded = Buffer.from(efg, "base64").toString("utf8");
              if (decoded.toLowerCase().includes("audio")) {
                return; // Skip audio stream
              }
            } catch (_) {}
          }

          if (resUrl.toLowerCase().includes("audio")) {
            return; // Skip standard audio paths
          }

          parsed.searchParams.delete("bytestart");
          parsed.searchParams.delete("byteend");
          const cleaned = parsed.toString();
          const count = (interceptedVideoUrls.get(cleaned) || 0) + 1;
          interceptedVideoUrls.set(cleaned, count);
          if (count === 1) {
            pipelineLogger.info(
              `Intercepted direct CDN video URL: ${cleaned.slice(0, 100)}...`,
              "Instagram",
            );
          }
        } catch (_) {}
      }
    });

    let videoSrc: string | null = null;
    let loadedDirectReel = false;

    // Try Direct Reel Page first if cookies are available
    if (cookies.length > 0) {
      try {
        pipelineLogger.info(
          `Attempting direct Instagram Reel page load: ${url}`,
          "Instagram",
        );
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        });

        // Check if redirected to login page
        const currentUrl = page.url();
        if (currentUrl.includes("accounts/login") || currentUrl.includes("/login/")) {
          pipelineLogger.warn(
            "Redirected to login page. Cookies might be expired/invalid.",
            "Instagram",
          );
        } else {
          // Wait for video element
          await page.waitForSelector("video", { timeout: 10_000 });
          loadedDirectReel = true;
          pipelineLogger.info(
            "Successfully loaded direct Reel page in Puppeteer",
            "Instagram",
          );
        }
      } catch (directErr) {
        pipelineLogger.warn(
          `Direct Reel load failed (${directErr instanceof Error ? directErr.message : directErr}), falling back to embed page`,
          "Instagram",
        );
      }
    }

    // Fall back to embed page if direct load didn't work or no cookies
    if (!loadedDirectReel) {
      pipelineLogger.info(
        `Loading Instagram embed via Puppeteer: ${embedUrl}`,
        "Instagram",
      );
      await page.goto(embedUrl, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });

      // Wait for the embedded post image or video to load
      await page
        .waitForSelector("img, video", { timeout: 60_000 })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Best-effort: scrape the original post caption from the loaded page
    let sourceCaption: SourceCaption | undefined;
    try {
      const captionText: string | null = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        if (!doc) return null;
        // Embed page exposes the caption in a .Caption element
        const captionEl = doc.querySelector(".Caption");
        if (captionEl && captionEl.textContent) return captionEl.textContent;
        // Direct page: fall back to the og:title / description meta tags
        const ogTitle = doc.querySelector('meta[property="og:title"]');
        if (ogTitle?.getAttribute("content")) return ogTitle.getAttribute("content");
        const metaDesc = doc.querySelector('meta[name="description"]');
        return metaDesc ? metaDesc.getAttribute("content") : null;
      });
      const cleaned = captionText?.trim();
      if (cleaned) {
        sourceCaption = { description: cleaned };
        pipelineLogger.info(
          `Original post caption scraped via Puppeteer (${cleaned.length} chars)`,
          "Instagram",
        );
      }
    } catch {}

    // Wait up to 3 seconds to let the video buffer stream so we can intercept direct CDN URLs
    let waitCount = 0;
    while (interceptedVideoUrls.size === 0 && waitCount < 6) {
      await new Promise((r) => setTimeout(r, 500));
      waitCount++;
    }

    if (interceptedVideoUrls.size > 0) {
      // Let the playing reel accumulate segment requests so it clearly
      // outnumbers the one-shot preloads of neighboring reels.
      await new Promise((r) => setTimeout(r, 2500));

      let bestCount = 0;
      for (const [candidate, count] of interceptedVideoUrls) {
        if (count > bestCount) {
          videoSrc = candidate;
          bestCount = count;
        }
      }
      pipelineLogger.info(
        `Selected CDN video URL with ${bestCount} segment request(s) out of ${interceptedVideoUrls.size} candidate(s): ${videoSrc?.slice(0, 100)}...`,
        "Instagram",
      );
    } else {
      // Try to extract video src URL
      videoSrc = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        if (!doc) return null;
        const videoEl = doc.querySelector("video");
        if (!videoEl) return null;
        const src = videoEl.getAttribute("src");
        if (src) return src;
        const sourceEl = videoEl.querySelector("source");
        return sourceEl ? sourceEl.getAttribute("src") : null;
      });
    }

    if (videoSrc) {
      pipelineLogger.info(
        `Found video source URL: ${videoSrc}`,
        "Instagram",
      );
      const videoPath = path.join(destDir, "reel_video.mp4");

      try {
        if (videoSrc.startsWith("blob:")) {
          pipelineLogger.info(
            `Detected blob URL. Extracting video content from browser memory: ${videoSrc}`,
            "Instagram",
          );
          const base64Data = await page.evaluate(async (blobUrl: any) => {
            const res = await fetch(blobUrl);
            const blob = await res.blob();
            return new Promise<string>((resolve, reject) => {
              const reader = new (globalThis as any).FileReader();
              reader.onloadend = () => {
                const base64String = (reader.result as string).split(",")[1];
                resolve(base64String);
              };
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          }, videoSrc);

          fs.writeFileSync(videoPath, Buffer.from(base64Data, "base64"));
          pipelineLogger.checkpoint(
            "Video extracted successfully from blob URL",
            true,
            videoPath,
          );
        } else {
          await downloadFileFromUrl(videoSrc, videoPath);
          pipelineLogger.info(
            `Video downloaded successfully via Puppeteer to: ${videoPath}`,
            "Instagram",
          );
        }

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
            return { framePath, instagramSourceType, videoPath, sourceCaption };
          } else {
            try {
              fs.unlinkSync(videoPath);
            } catch {}
            return { framePath, instagramSourceType, sourceCaption };
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

    return { framePath, instagramSourceType: "image", sourceCaption };
  } finally {
    await browser.close();
  }
}

/**
 * Decodes 5 frames of the video (10/30/50/70/90%), downscales to 16x16 grayscale,
 * and compares them. Only videos of 15 seconds or less can be classified as static:
 * genuine "image with music" reels are short loops, and misclassifying a long real
 * video routes it through the image renderer, which discards all but one frame.
 */
export async function checkIfVideoIsStatic(videoPath: string): Promise<boolean> {
  try {
    // 1. Get video duration using ffprobe
    const durationBuffer = await runCommandWithBufferOutput(
      FFPROBE,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      "get-duration",
    );
    const duration = parseFloat(durationBuffer.toString().trim());
    if (isNaN(duration) || duration <= 0) {
      pipelineLogger.warn(
        `Failed to parse video duration. Assuming dynamic video.`,
        "Instagram",
      );
      return false;
    }

    // A long video is never a static image disguised as a video.
    const STATIC_CHECK_MAX_DURATION = 15;
    if (duration > STATIC_CHECK_MAX_DURATION) {
      pipelineLogger.info(
        `Video is ${duration.toFixed(1)}s (> ${STATIC_CHECK_MAX_DURATION}s) — treating as dynamic video.`,
        "Instagram",
      );
      return false;
    }

    // 2. Define 5 sample timestamps across the video
    const timestamps = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => duration * f);
    timestamps[0] = Math.min(1.0, timestamps[0]);
    timestamps[timestamps.length - 1] = Math.max(
      duration - 1.0,
      timestamps[timestamps.length - 1],
    );

    pipelineLogger.info(
      `Checking if video is static. Duration: ${duration.toFixed(2)}s, sampling at: ${timestamps.map((t) => t.toFixed(2)).join("s, ")}s`,
      "Instagram",
    );

    // Helper to extract a single frame as a raw grayscale 16x16 buffer
    const extractFrame = async (ts: number): Promise<Buffer> => {
      return await runCommandWithBufferOutput(
        FFMPEG,
        [
          "-y",
          "-ss",
          ts.toFixed(3),
          "-i",
          videoPath,
          "-vframes",
          "1",
          "-vf",
          "scale=16:16,format=gray",
          "-f",
          "rawvideo",
          "-",
        ],
        `extract-frame-${ts.toFixed(1)}`,
      );
    };

    const frames = await Promise.all(timestamps.map((t) => extractFrame(t)));

    // Helper to compute difference between two raw 16x16 grayscale buffers
    const getDiff = (bA: Buffer, bB: Buffer): number => {
      if (bA.length !== bB.length || bA.length === 0) return 999;
      let total = 0;
      for (let i = 0; i < bA.length; i++) {
        total += Math.abs(bA[i] - bB[i]);
      }
      return total / bA.length;
    };

    const adjacentDiffs = frames
      .slice(1)
      .map((frame, i) => getDiff(frames[i], frame));
    const firstToLastDiff = getDiff(frames[0], frames[frames.length - 1]);

    pipelineLogger.info(
      `Frame difference scores: adjacent=[${adjacentDiffs.map((d) => d.toFixed(3)).join(", ")}], first-to-last=${firstToLastDiff.toFixed(3)}`,
      "Instagram",
    );

    // Static only if every adjacent pair AND the endpoints are virtually
    // identical (less than 1.5 gray levels on average).
    const isStatic =
      adjacentDiffs.every((d) => d < 1.5) && firstToLastDiff < 1.5;
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
