import { pipelineLogger } from "../utils/logger";
import { exportCookies, parseNetscapeCookies, CHROME_PATH, COOKIES_FILE } from "./index";

export interface ChannelReelSummary {
  shortcode: string;
  url: string;
}

/**
 * List a channel's recent reels via a Puppeteer scrape of its /reels/ grid.
 * yt-dlp's `instagram:user` extractor is marked broken upstream (Instagram
 * changed its page structure, its `sharedData` regex no longer matches), so
 * this scrape — reusing the same cookies/browser-launch approach as the
 * single-reel Puppeteer fallback — is the only working listing mechanism.
 *
 * Pinned posts are excluded: they sit at the top of the grid out of
 * chronological order, so treating DOM order as "newest first" only holds
 * once pinned tiles are filtered out.
 */
export async function listChannelReels(
  username: string,
): Promise<ChannelReelSummary[]> {
  await exportCookies().catch(() => {});

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
    await page.setViewport({ width: 1280, height: 1920, deviceScaleFactor: 2 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );

    const cookies = parseNetscapeCookies(COOKIES_FILE);
    if (cookies.length > 0) await page.setCookie(...cookies);

    const url = `https://www.instagram.com/${username}/reels/`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Let the SPA hydrate and render the grid before scraping it.
    await new Promise((r) => setTimeout(r, 4000));

    // Verify we are actually on the requested user's reels page and not redirected to login or main feed
    const currentUrl = page.url().toLowerCase();
    const expectedUrlPart = `instagram.com/${username.toLowerCase()}/reels`;
    if (!currentUrl.includes(expectedUrlPart)) {
      pipelineLogger.warn(
        `[ChannelFeed] Puppeteer was redirected or failed to reach reels page for @${username}. Current URL: ${page.url()}`,
        "ChannelFeed"
      );
      return [];
    }

    const hrefs: string[] = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const anchors: any[] = Array.from(doc.querySelectorAll("a[href*='/reel/']"));
      return anchors
        .filter((a: any) => {
          // Walk up from the anchor until the ancestor contains more than one
          // reel link — the previous level is the smallest container scoped
          // to just this tile. Verified against a live profile with pinned
          // posts: this precisely isolates each tile's own "Pinned post icon"
          // (a naive closest("div") is either too narrow to reach the badge
          // or, if too wide, spans into neighboring tiles and false-positives).
          let node: any = a;
          let single: any = a;
          while (node.parentElement) {
            node = node.parentElement;
            if (node.querySelectorAll("a[href*='/reel/']").length > 1) break;
            single = node;
          }
          return !single.querySelector("svg[aria-label='Pinned post icon']");
        })
        .map((a: any) => a.getAttribute("href") || "");
    });

    const seen = new Set<string>();
    const results: ChannelReelSummary[] = [];
    for (const href of hrefs) {
      const match = href.match(/\/reel\/([A-Za-z0-9_-]+)/);
      if (!match) continue;
      const shortcode = match[1];
      if (seen.has(shortcode)) continue;
      seen.add(shortcode);
      results.push({
        shortcode,
        url: `https://www.instagram.com/reel/${shortcode}/`,
      });
      if (results.length >= 20) break;
    }

    pipelineLogger.info(
      `Listed ${results.length} reel(s) from @${username}`,
      "ChannelFeed",
    );
    return results;
  } finally {
    await browser.close();
  }
}
