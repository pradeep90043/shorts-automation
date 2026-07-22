import { execFile } from "child_process";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { COOKIES_FILE } from "./index";

export interface ChannelReelSummary {
  shortcode: string;
  url: string;
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
): Promise<ChannelReelSummary[]> {
  pipelineLogger.info(
    `[ChannelFeed] Fetching reels for @${username} via Instagram mobile API...`,
    "ChannelFeed",
  );

  return new Promise((resolve) => {
    const args = [FETCH_SCRIPT, username, COOKIES_FILE, "20"];

    execFile(
      PYTHON3,
      args,
      { timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stderr.trim()) {
          pipelineLogger.warn(
            `[ChannelFeed] @${username}: ${stderr.trim().split("\n")[0]}`,
            "ChannelFeed",
          );
        }

        if (err && !stdout.trim()) {
          const errMsg = stderr ? stderr.trim() : err.message.split("\n")[0];
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
