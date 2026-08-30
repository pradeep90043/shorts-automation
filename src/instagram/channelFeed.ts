import { execFile } from "child_process";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { COOKIES_FILE } from "./index";

export interface ChannelReelSummary {
  shortcode: string;
  url: string;
}

export interface ScoredReelSummary extends ChannelReelSummary {
  playCount: number;
  likeCount: number;
  commentCount: number;
  creatorUsername?: string;
  sourceHashtag: string;
}

export class InstagramRateLimitError extends Error {
  constructor(context: string) {
    super(`Instagram rate limited (${context})`);
    this.name = "InstagramRateLimitError";
  }
}

const PYTHON3  = config.binaries.python3;
const FETCH_SCRIPT = path.resolve(__dirname, "../../scripts/fetch_reels.py");

/**
 * List a channel's recent reels via Instagram's private mobile API.
 *
 * A dedicated Python helper (scripts/fetch_reels.py) authenticates using the
 * session cookies and calls i.instagram.com/api/v1/clips/user/ — the same
 * endpoint the Instagram mobile app uses.  This avoids both Puppeteer (blocked
 * by Instagram on datacenter IPs) and yt-dlp's broken instagram:user extractor.
 *
 * Up to 20 reels are returned per channel.
 */
export async function listChannelReels(
  username: string,
  scraperEnv?: Record<string, string>,
  onSessionRefresh?: (newSessionId: string) => void,
): Promise<ChannelReelSummary[]> {
  pipelineLogger.info(
    `[ChannelFeed] Fetching reels for @${username} via Instagram mobile API...`,
    "ChannelFeed",
  );

  return new Promise((resolve, reject) => {
    const args = [FETCH_SCRIPT, username, COOKIES_FILE, "20"];

    execFile(
      PYTHON3,
      args,
      {
        timeout: 60000,
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env, ...scraperEnv },
      },
      (err, stdout, stderr) => {
        const stderrText = stderr.trim();
        if (stderrText) {
          const lines = stderrText.split("\n").map((l) => l.trim()).filter(Boolean);
          for (const line of lines) {
            if (line.startsWith("SESSION_REFRESHED:")) {
              const newSid = line.slice("SESSION_REFRESHED:".length).trim();
              if (newSid && onSessionRefresh) onSessionRefresh(newSid);
            } else if (line.startsWith("WARN:") || line.startsWith("ERROR:")) {
              pipelineLogger.warn(`[ChannelFeed] @${username}: ${line}`, "ChannelFeed");
            }
          }
        }

        // Propagate 429 as a distinct error so the caller can back off
        // without burning the current slot.
        if (stderrText.includes("RATE_LIMITED")) {
          return reject(new InstagramRateLimitError(username));
        }

        if (err && !stdout.trim()) {
          const errMsg = stderrText || err.message.split("\n")[0];
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "EACCES") {
            return reject(new Error(`Python binary not found (${PYTHON3}): ${errMsg}`));
          }
          if (errMsg.includes("ERROR:") || errMsg.includes("login failed") || errMsg.includes("LoginRequired") || errMsg.includes("ChallengeRequired") || errMsg.includes("2FA required")) {
            return reject(new Error(errMsg));
          }
          pipelineLogger.warn(
            `[ChannelFeed] fetch_reels.py failed for @${username}: ${errMsg}`,
            "ChannelFeed",
          );
          return resolve([]);
        }

        const results: ChannelReelSummary[] = [];
        const seen = new Set<string>();

        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed) as { shortcode: string; url: string };
            if (!entry.shortcode || seen.has(entry.shortcode)) continue;
            seen.add(entry.shortcode);
            results.push({
              shortcode: entry.shortcode,
              url: `https://www.instagram.com/reel/${entry.shortcode}/`,
            });
          } catch {
            // skip non-JSON lines (warnings etc.)
          }
        }

        pipelineLogger.info(
          `Listed ${results.length} reel(s) from @${username}`,
          "ChannelFeed",
        );
        resolve(results);
      },
    );
  });
}

/**
 * Fetch top reels for multiple hashtags in a SINGLE Python process invocation.
 * All hashtags are passed as --tags a,b,c so instagrapi logs in once, fetches
 * all tags with polite inter-tag delays, then exits — no repeated re-logins.
 * Throws InstagramRateLimitError when the script exits with code 2 / RATE_LIMITED.
 */
export async function searchAllHashtagReels(
  hashtags: string[],
  limitPerTag = 20,
  scraperEnv?: Record<string, string>,
  onSessionRefresh?: (newSessionId: string) => void,
): Promise<ScoredReelSummary[]> {
  const tags = hashtags.map((t) => t.replace(/^#/, "")).filter(Boolean);
  if (tags.length === 0) return [];

  pipelineLogger.info(
    `[ChannelFeed] Searching ${tags.length} hashtag(s) in one call: #${tags.join(", #")}`,
    "ChannelFeed",
  );

  // Generous timeout: one login + N tags × ~5s delay + fetch time
  const timeoutMs = 30000 + tags.length * 8000;

  return new Promise((resolve, reject) => {
    const args = [
      FETCH_SCRIPT,
      "--mode", "hashtag",
      "--tags", tags.join(","),
      "--limit", String(limitPerTag),
    ];

    execFile(
      PYTHON3,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...scraperEnv },
      },
      (err, stdout, stderr) => {
        const stderrTrimmed = stderr.trim();
        if (stderrTrimmed) {
          const lines = stderrTrimmed.split("\n");
          for (const line of lines) {
            if (line.startsWith("RATE_LIMITED")) {
              return reject(new InstagramRateLimitError(tags.join(",")));
            }
            if (line.startsWith("SESSION_REFRESHED:")) {
              const newSid = line.slice("SESSION_REFRESHED:".length).trim();
              if (newSid && onSessionRefresh) onSessionRefresh(newSid);
            } else if (line.startsWith("WARN") || line.startsWith("ERROR")) {
              pipelineLogger.warn(`[ChannelFeed] ${line}`, "ChannelFeed");
            }
          }
        }

        if (err && (err as NodeJS.ErrnoException & { code?: number }).code === 2) {
          return reject(new InstagramRateLimitError(tags.join(",")));
        }

        if (err && !stdout.trim()) {
          const errMsg = stderrTrimmed || err.message.split("\n")[0];
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "EACCES") {
            return reject(new Error(`Python binary not found (${PYTHON3}): ${errMsg}`));
          }
          if (errMsg.includes("ERROR:") || errMsg.includes("login failed") || errMsg.includes("LoginRequired") || errMsg.includes("ChallengeRequired") || errMsg.includes("2FA required")) {
            return reject(new Error(errMsg));
          }
          pipelineLogger.warn(
            `[ChannelFeed] fetch_reels.py hashtag failed: ${err.message.split("\n")[0]}`,
            "ChannelFeed",
          );
          return resolve([]);
        }

        const results: ScoredReelSummary[] = [];
        const seen = new Set<string>();

        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed) as {
              shortcode: string;
              url?: string;
              like_count?: number;
              play_count?: number;
              comment_count?: number;
              owner_username?: string;
              source_hashtag?: string;
            };
            if (!entry.shortcode || seen.has(entry.shortcode)) continue;
            seen.add(entry.shortcode);
            results.push({
              shortcode: entry.shortcode,
              url: `https://www.instagram.com/reel/${entry.shortcode}/`,
              playCount: entry.play_count || 0,
              likeCount: entry.like_count || 0,
              commentCount: entry.comment_count || 0,
              creatorUsername: entry.owner_username || undefined,
              sourceHashtag: entry.source_hashtag || tags[0],
            });
          } catch {
            // skip non-JSON lines
          }
        }

        pipelineLogger.info(
          `[ChannelFeed] Found ${results.length} reel(s) across ${tags.length} hashtag(s)`,
          "ChannelFeed",
        );
        resolve(results);
      },
    );
  });
}

/**
 * Puppeteer browser scraper for channel reels.
 * Renders the web profile directly using headless Chromium with stealth/cookies,
 * bypassing datacenter API blocks and private endpoint rate-limits (429).
 */
export async function listChannelReelsViaPuppeteer(username: string): Promise<ChannelReelSummary[]> {
  const cleanUser = username.replace(/^@/, "").trim();
  pipelineLogger.info(
    `[ChannelFeed] Attempting Puppeteer browser fallback for @${cleanUser}...`,
    "ChannelFeed",
  );
  let browser: any = null;
  try {
    const puppeteerModule = await new Function("return import('puppeteer-core')")();
    const puppeteer = puppeteerModule.default;
    const chromeArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      ...(process.platform === "win32" ? ["--no-zygote", "--single-process"] : []),
    ];
    browser = await puppeteer.launch({
      executablePath: config.binaries.chrome,
      headless: true,
      protocolTimeout: 60000,
      timeout: 35000,
      args: chromeArgs,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );

    // Load cookies if available
    const { parseNetscapeCookies } = await import("./index");
    const cookies = parseNetscapeCookies(COOKIES_FILE);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
    }

    const shortcodes = new Set<string>();
    page.on("response", async (res: any) => {
      try {
        const resUrl = res.url();
        if (resUrl.includes("graphql") || resUrl.includes("/api/v1/clips/user/") || resUrl.includes("web_profile_info")) {
          const text = await res.text();
          const matches = text.matchAll(/"shortcode":"([A-Za-z0-9_-]+)"/g);
          for (const m of matches) shortcodes.add(m[1]);
          const codeMatches = text.matchAll(/"code":"([A-Za-z0-9_-]+)"/g);
          for (const m of codeMatches) shortcodes.add(m[1]);
        }
      } catch (_) {}
    });

    const targetUrl = `https://www.instagram.com/${cleanUser}/reels/`;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));

    const domCodes: string[] = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const links = Array.from(doc?.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]') || []);
      return links.map((a: any) => {
        const m = (a.getAttribute("href") || "").match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)/);
        return m ? m[1] : null;
      }).filter(Boolean);
    });

    domCodes.forEach((c) => shortcodes.add(c));

    const results: ChannelReelSummary[] = Array.from(shortcodes).map((shortcode) => ({
      shortcode,
      url: `https://www.instagram.com/reel/${shortcode}/`,
    }));

    pipelineLogger.info(
      `[ChannelFeed] Puppeteer extracted ${results.length} reel(s) for @${cleanUser}`,
      "ChannelFeed",
    );
    return results;
  } catch (puppeteerErr) {
    pipelineLogger.warn(
      `[ChannelFeed] Puppeteer fallback failed for @${cleanUser}: ${puppeteerErr instanceof Error ? puppeteerErr.message : puppeteerErr}`,
      "ChannelFeed",
    );
    return [];
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }
}

/**
 * Puppeteer browser scraper for hashtag discovery.
 * Visits hashtag exploration pages and extracts public reels without triggering 429 errors.
 */
export async function searchHashtagReelsViaPuppeteer(
  hashtags: string[],
  limit = 20,
): Promise<ScoredReelSummary[]> {
  const tags = hashtags.map((t) => t.replace(/^#/, "")).filter(Boolean);
  if (tags.length === 0) return [];

  pipelineLogger.info(
    `[ChannelFeed] Attempting Puppeteer hashtag discovery for #${tags.slice(0, 3).join(", #")}...`,
    "ChannelFeed",
  );

  let browser: any = null;
  const results: ScoredReelSummary[] = [];
  const seenCodes = new Set<string>();

  try {
    const puppeteerModule = await new Function("return import('puppeteer-core')")();
    const puppeteer = puppeteerModule.default;
    const chromeArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      ...(process.platform === "win32" ? ["--no-zygote", "--single-process"] : []),
    ];
    browser = await puppeteer.launch({
      executablePath: config.binaries.chrome,
      headless: true,
      protocolTimeout: 60000,
      timeout: 35000,
      args: chromeArgs,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );

    const { parseNetscapeCookies } = await import("./index");
    const cookies = parseNetscapeCookies(COOKIES_FILE);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
    }

    for (const tag of tags.slice(0, 5)) {
      if (results.length >= limit) break;
      const shortcodesForTag = new Set<string>();

      page.removeAllListeners("response");
      page.on("response", async (res: any) => {
        try {
          const resUrl = res.url();
          if (resUrl.includes("graphql") || resUrl.includes("/api/v1/tags/")) {
            const text = await res.text();
            const matches = text.matchAll(/"shortcode":"([A-Za-z0-9_-]+)"/g);
            for (const m of matches) shortcodesForTag.add(m[1]);
            const codeMatches = text.matchAll(/"code":"([A-Za-z0-9_-]+)"/g);
            for (const m of codeMatches) shortcodesForTag.add(m[1]);
          }
        } catch (_) {}
      });

      const tagUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`;
      await page.goto(tagUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));

      const domCodes: string[] = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const links = Array.from(doc?.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]') || []);
        return links.map((a: any) => {
          const m = (a.getAttribute("href") || "").match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)/);
          return m ? m[1] : null;
        }).filter(Boolean);
      });

      domCodes.forEach((c) => shortcodesForTag.add(c));

      for (const code of shortcodesForTag) {
        if (!seenCodes.has(code)) {
          seenCodes.add(code);
          results.push({
            shortcode: code,
            url: `https://www.instagram.com/reel/${code}/`,
            playCount: 1000,
            likeCount: 100,
            commentCount: 10,
            sourceHashtag: tag,
          });
          if (results.length >= limit) break;
        }
      }
    }

    pipelineLogger.info(
      `[ChannelFeed] Puppeteer extracted ${results.length} hashtag reel(s)`,
      "ChannelFeed",
    );
    return results;
  } catch (err) {
    pipelineLogger.warn(
      `[ChannelFeed] Puppeteer hashtag scraping failed: ${err instanceof Error ? err.message : err}`,
      "ChannelFeed",
    );
    return results;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }
}

