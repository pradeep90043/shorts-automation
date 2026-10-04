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

/**
 * The stored Instagram session cookie is dead and the server is in session_only
 * mode, so no automatic recovery is possible — a human must paste a fresh
 * sessionid. Callers should alert an admin and stop, NOT retry or trigger a
 * password login.
 */
export class InstagramSessionDeadError extends Error {
  constructor(context: string, detail?: string) {
    super(`Instagram session dead (${context})${detail ? `: ${detail}` : ""}`);
    this.name = "InstagramSessionDeadError";
  }
}

/** Optional callbacks the Python scraper fires back through stderr sentinel lines. */
export interface ScraperCallbacks {
  onSessionRefresh?: (newSessionId: string) => void;
  /** Fired with a base64 instagrapi settings blob to persist (device + cookies). */
  onSettingsRefresh?: (settingsB64: string) => void;
}

const PYTHON3  = config.binaries.python3;
const FETCH_SCRIPT = path.resolve(__dirname, "../../scripts/fetch_reels.py");
const SEARCH_ENGINE_SCRIPT = path.resolve(__dirname, "../../scripts/search_engine_discovery.py");

/**
 * Parse the scraper's stderr sentinel lines. Returns markers the caller acts on.
 */
function handleScraperStderr(
  stderrText: string,
  label: string,
  cb?: ScraperCallbacks,
): { rateLimited: boolean; sessionDead: string | null } {
  let sessionDead: string | null = null;
  let rateLimited = false;
  for (const raw of stderrText.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("SESSION_REFRESHED:")) {
      const sid = line.slice("SESSION_REFRESHED:".length).trim();
      if (sid) cb?.onSessionRefresh?.(sid);
    } else if (line.startsWith("SETTINGS_JSON:")) {
      const blob = line.slice("SETTINGS_JSON:".length).trim();
      if (blob) cb?.onSettingsRefresh?.(blob);
    } else if (line.startsWith("SESSION_DEAD:")) {
      sessionDead = line.slice("SESSION_DEAD:".length).trim() || "session cookie rejected";
    } else if (line.startsWith("RATE_LIMITED")) {
      rateLimited = true;
    } else if (line.startsWith("WARN") || line.startsWith("ERROR")) {
      pipelineLogger.warn(`[${label}] ${line}`, "ChannelFeed");
    }
  }
  return { rateLimited, sessionDead };
}

/**
 * Launch a headless Chromium tuned for small / memory-constrained containers
 * (e.g. the 1 GB Oracle free-tier box this runs on).
 *
 * The previous inline `puppeteer.launch` calls regularly failed in production
 * with "Timed out after 35000 ms while waiting for the WS endpoint URL to
 * appear in stdout!" — Chromium was being OOM-killed before it could print its
 * DevTools endpoint. The flags below drop Chromium's memory footprint (single
 * process, no zygote, minimal renderer features) and the timeout is raised so a
 * slow cold start on a starved CPU still succeeds. Set DEBUG_PUPPETEER=1 to pipe
 * Chromium's own stdout/stderr into the logs when diagnosing launch failures.
 */
async function launchScraperBrowser(): Promise<any> {
  const puppeteerModule = await new Function("return import('puppeteer-core')")();
  const puppeteer = puppeteerModule.default;

  // --single-process slashes Chromium's memory but makes page.evaluate() hang
  // under CPU contention (observed as "Runtime.callFunctionOn timed out" in
  // prod), so it is OFF by default. Enable only if the box has enough RAM
  // headroom that plain multi-process Chromium OOMs at launch.
  const singleProcess =
    process.platform === "win32" || process.env.PUPPETEER_SINGLE_PROCESS === "1";

  const chromeArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=TranslateUI,BackForwardCache",
    "--mute-audio",
    "--hide-scrollbars",
    "--js-flags=--max-old-space-size=256",
    ...(singleProcess ? ["--no-zygote", "--single-process"] : []),
  ];

  const launchOpts = {
    executablePath: config.binaries.chrome,
    headless: true,
    protocolTimeout: 120000,
    timeout: 90000,
    dumpio: process.env.DEBUG_PUPPETEER === "1",
    args: chromeArgs,
  };

  try {
    return await puppeteer.launch(launchOpts);
  } catch (firstErr) {
    pipelineLogger.warn(
      `[ChannelFeed] Chromium launch failed (${firstErr instanceof Error ? firstErr.message.split("\n")[0] : firstErr}) — retrying once...`,
      "ChannelFeed",
    );
    await new Promise((r) => setTimeout(r, 2000));
    return puppeteer.launch(launchOpts);
  }
}

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
  callbacks?: ScraperCallbacks,
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
        const { rateLimited, sessionDead } = handleScraperStderr(
          stderrText,
          `ChannelFeed @${username}`,
          callbacks,
        );

        // Dead session in session_only mode — no auto-recovery; caller must alert.
        if (sessionDead || (err as NodeJS.ErrnoException & { code?: number })?.code === 3) {
          return reject(new InstagramSessionDeadError(username, sessionDead || undefined));
        }

        // Propagate 429 as a distinct error so the caller can back off
        // without burning the current slot.
        if (rateLimited) {
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
  callbacks?: ScraperCallbacks,
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
        const { rateLimited, sessionDead } = handleScraperStderr(
          stderrTrimmed,
          "ChannelFeed hashtags",
          callbacks,
        );

        if (sessionDead || (err as NodeJS.ErrnoException & { code?: number })?.code === 3) {
          return reject(new InstagramSessionDeadError(tags.join(","), sessionDead || undefined));
        }

        if (rateLimited || (err as NodeJS.ErrnoException & { code?: number })?.code === 2) {
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
 * Discover public Instagram Reels via Search Engine (DuckDuckGo/Bing).
 * Solution 1: completely free, zero login/cookies required, immune to datacenter 401 blocks.
 */
export async function searchReelsViaSearchEngine(
  profileKey: string,
  limit = 10,
): Promise<ScoredReelSummary[]> {
  pipelineLogger.info(
    `[SearchEngineDiscovery] Discovering reels via Search Engine (Solution 1) for [${profileKey.toUpperCase()}]...`,
    "ChannelFeed",
  );

  return new Promise((resolve) => {
    const args = [
      SEARCH_ENGINE_SCRIPT,
      "--profile",
      profileKey.toLowerCase(),
      "--limit",
      String(limit),
    ];

    execFile(
      PYTHON3,
      args,
      { timeout: 60000, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout.trim()) {
          pipelineLogger.warn(
            `[SearchEngineDiscovery] Script returned error (${stderr.trim() || err.message.split("\n")[0]})`,
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
              query?: string;
            };
            if (!entry.shortcode || seen.has(entry.shortcode)) continue;
            seen.add(entry.shortcode);
            results.push({
              shortcode: entry.shortcode,
              url: `https://www.instagram.com/reel/${entry.shortcode}/`,
              playCount: entry.play_count || 1000,
              likeCount: entry.like_count || 100,
              commentCount: entry.comment_count || 10,
              creatorUsername: entry.owner_username || undefined,
              sourceHashtag: entry.query || profileKey,
            });
          } catch {
            // skip non-JSON
          }
        }

        pipelineLogger.info(
          `[SearchEngineDiscovery] Discovered ${results.length} reel(s) via Search Engine for [${profileKey.toUpperCase()}]`,
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
    browser = await launchScraperBrowser();

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
    browser = await launchScraperBrowser();

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

