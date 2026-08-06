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
          for (const line of stderrText.split("\n")) {
            if (line.startsWith("SESSION_REFRESHED:")) {
              const newSid = line.slice("SESSION_REFRESHED:".length).trim();
              if (newSid && onSessionRefresh) onSessionRefresh(newSid);
            } else {
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
