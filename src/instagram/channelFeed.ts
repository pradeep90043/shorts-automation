import { execFile } from "child_process";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { COOKIES_FILE } from "./index";

export interface ChannelReelSummary {
  shortcode: string;
  url: string;
}

const YTDLP = config.binaries.ytdlp;

/**
 * List a channel's recent reels via yt-dlp --flat-playlist.
 *
 * This replaces the previous Puppeteer scrape which was being blocked by
 * Instagram's bot-detection on server/datacenter IPs. yt-dlp handles cookies
 * natively, sends realistic browser headers, and is much more resilient to
 * rate-limiting.
 *
 * Up to 20 entries from the /reels/ tab are returned. Pinned posts are
 * excluded naturally since yt-dlp returns items in reverse-chronological order
 * and we only take the most recent 20.
 */
export async function listChannelReels(
  username: string,
): Promise<ChannelReelSummary[]> {
  const url = `https://www.instagram.com/${username}/reels/`;

  pipelineLogger.info(
    `[ChannelFeed] Fetching reels for @${username} via yt-dlp...`,
    "ChannelFeed",
  );

  return new Promise((resolve) => {
    const args = [
      "--cookies", COOKIES_FILE,
      "--flat-playlist",
      "--no-warnings",
      "--no-download",
      "-j",                     // print one JSON object per entry to stdout
      "--playlist-items", "1:20",
      "--sleep-requests", "2",  // 2s between API requests to avoid 429
      "--sleep-interval", "1",  // 1s between playlist items
      url,
    ];

    execFile(
      YTDLP,
      args,
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout.trim()) {
          pipelineLogger.warn(
            `[ChannelFeed] yt-dlp failed for @${username}: ${err.message.split("\n")[0]}`,
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
            const entry = JSON.parse(trimmed);

            // yt-dlp returns the shortcode as `id` for Instagram reels.
            // Fall back to extracting it from the url/webpage_url field.
            const shortcode: string =
              entry.id ||
              (entry.webpage_url || entry.url || "").match(
                /\/reel\/([A-Za-z0-9_-]+)/,
              )?.[1] ||
              "";

            if (!shortcode || seen.has(shortcode)) continue;
            seen.add(shortcode);
            results.push({
              shortcode,
              url: `https://www.instagram.com/reel/${shortcode}/`,
            });
          } catch {
            // skip malformed / non-JSON lines (yt-dlp sometimes emits warnings)
          }
        }

        if (results.length === 0 && stderr) {
          pipelineLogger.warn(
            `[ChannelFeed] No reels found for @${username}. yt-dlp stderr: ${stderr.slice(0, 200)}`,
            "ChannelFeed",
          );
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
