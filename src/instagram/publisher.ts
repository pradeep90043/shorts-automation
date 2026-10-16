import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { config, InstagramAccount } from "../config";
import { pipelineLogger } from "../utils/logger";
import { VideoMetadata } from "../types";
import { switchOn } from "../utils/switches";
import { mediaLinks, MediaLinkRegistry } from "./mediaLinks";

export interface InstagramUploadResult {
  accountName: string;
  url: string;
  mediaId: string;
}

/** The resumable (binary) upload is rejected by Instagram above this length; the video_url upload is not. Measured, 2026-10-16. */
export const RESUMABLE_MAX_SEC = 60;
/** Length of the last-resort copy: under the limit with a margin, with a 1 s fade-out so it does not end mid-word. */
export const TRIMMED_SEC = 58.5;

export interface PublisherDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  links?: MediaLinkRegistry;
  /** public https base of this server (for the video_url upload), or null when that method is off */
  publicBaseUrl?: () => string | null;
  probeDuration?: (videoPath: string) => Promise<number | null>;
  makeShortCopy?: (videoPath: string, maxSec: number) => Promise<string>;
  pollMs?: number;
  pollMax?: number;
  retryDelayMs?: number;
  apiVersion?: string;
}

/** IG_VIDEO_URL=off turns the video_url method off (PUBLIC_URL is the same base the long-video runners use). */
export const defaultPublicBaseUrl = (env: NodeJS.ProcessEnv = process.env): string | null =>
  switchOn("IG_VIDEO_URL", env, true) ? (env.PUBLIC_URL || "https://shorts-automation.duckdns.org").replace(/\/+$/, "") : null;

function execFileP(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(`${path.basename(file)} failed: ${String(stderr || err.message).slice(-300)}`)) : resolve(String(stdout)))),
  );
}

async function probeDurationDefault(videoPath: string): Promise<number | null> {
  try {
    const out = await execFileP(config.binaries.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath]);
    const n = parseFloat(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function makeShortCopyDefault(videoPath: string, maxSec: number): Promise<string> {
  const out = path.join(path.dirname(videoPath), `${path.basename(videoPath, path.extname(videoPath))}.ig${Math.round(maxSec)}.mp4`);
  const fadeAt = Math.max(0, maxSec - 1);
  await execFileP(config.binaries.ffmpeg, [
    "-y", "-i", videoPath, "-t", String(maxSec),
    "-vf", `fade=t=out:st=${fadeAt}:d=1`, "-af", `afade=t=out:st=${fadeAt}:d=1`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
  ]);
  return out;
}

export class InstagramPublisher {
  // Per-channel-profile Instagram accounts (defaults to the primary profile)
  private accounts: InstagramAccount[];
  private readonly d: Required<PublisherDeps>;

  constructor(accounts: InstagramAccount[] = config.instagram.accounts, deps: PublisherDeps = {}) {
    this.accounts = accounts;
    this.d = {
      fetchFn: deps.fetchFn ?? fetch,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      links: deps.links ?? mediaLinks,
      publicBaseUrl: deps.publicBaseUrl ?? (() => defaultPublicBaseUrl()),
      probeDuration: deps.probeDuration ?? probeDurationDefault,
      makeShortCopy: deps.makeShortCopy ?? makeShortCopyDefault,
      pollMs: deps.pollMs ?? 5000,
      pollMax: deps.pollMax ?? 60,
      retryDelayMs: deps.retryDelayMs ?? 10_000,
      apiVersion: deps.apiVersion ?? "v21.0",
    };
  }

  /** Never lets an access token reach a log line or an error message. */
  private redact(text: string, token: string): string {
    return text.split(token).join("<token>").replace(/access_token=[^&"\s]+/g, "access_token=<token>");
  }

  private async graph(account: InstagramAccount, pathAndQuery: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: any }> {
    const sep = pathAndQuery.includes("?") ? "&" : "?";
    const res = await this.d.fetchFn(`https://graph.facebook.com/${this.d.apiVersion}/${pathAndQuery}${sep}access_token=${account.accessToken}`, init);
    let data: any = {};
    try { data = await res.json(); } catch { /* an empty or non-JSON body: the status still says what happened */ }
    return { ok: res.ok, status: res.status, data };
  }

  /** Polls a container until Instagram has processed the video. Throws on ERROR/EXPIRED/timeout. */
  private async waitUntilReady(account: InstagramAccount, containerId: string): Promise<void> {
    for (let i = 0; i < this.d.pollMax; i++) {
      const { data } = await this.graph(account, `${containerId}?fields=status_code,status`);
      if (data.status_code === "FINISHED") return;
      if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
        throw new Error(`Instagram processing ${data.status_code} on container ${containerId}: ${JSON.stringify(data).slice(0, 300)}`);
      }
      await this.d.sleep(this.d.pollMs);
    }
    throw new Error(`Timed out waiting for Instagram to process container ${containerId}`);
  }

  /** Method 1: Instagram downloads the video from a temporary link on this server. Accepts Reels longer than 60 s. */
  private async viaUrl(account: InstagramAccount, videoPath: string, caption: string, base: string): Promise<string> {
    const link = this.d.links.register(videoPath);
    try {
      const videoUrl = `${base}${link.path}`;
      const init = await this.graph(account, `${account.igUserId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media_type: "REELS", video_url: videoUrl, caption }),
      });
      if (!init.ok || !init.data.id) throw new Error(`Failed to create the container from a URL: ${JSON.stringify(init.data).slice(0, 300)}`);
      await this.waitUntilReady(account, init.data.id);
      return init.data.id;
    } finally {
      this.d.links.revoke(link.token); // the link lives only as long as Instagram needs it
    }
  }

  /** Method 2: push the bytes in a resumable upload. Instagram rejects this above 60 s. */
  private async viaResumable(account: InstagramAccount, videoPath: string, caption: string): Promise<string> {
    const init = await this.graph(account, `${account.igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_type: "REELS", upload_type: "resumable", caption }),
    });
    if (!init.ok || !init.data.id || !init.data.uri) throw new Error(`Failed to initialize container: ${JSON.stringify(init.data).slice(0, 300)}`);
    const size = fs.statSync(videoPath).size;
    const up = await this.d.fetchFn(init.data.uri, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${account.accessToken}`,
        offset: "0",
        file_size: String(size),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
      },
      body: fs.readFileSync(videoPath),
    });
    const upText = await up.text();
    if (!up.ok) throw new Error(`Failed to upload binary data: ${upText.slice(0, 300)}`);
    await this.waitUntilReady(account, init.data.id);
    return init.data.id;
  }

  /** Publishes a finished container. Only the publish itself may fail: the URL lookup afterwards never throws. */
  private async publishContainer(account: InstagramAccount, containerId: string): Promise<InstagramUploadResult> {
    const pub = await this.graph(account, `${account.igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: containerId }),
    });
    if (!pub.ok || !pub.data.id) throw new Error(`Failed to publish media: ${JSON.stringify(pub.data).slice(0, 300)}`);
    const mediaId = String(pub.data.id);
    let url = `https://instagram.com/p/${mediaId}/`;
    try {
      const m = await this.graph(account, `${mediaId}?fields=shortcode`);
      if (m.data.shortcode) url = `https://instagram.com/reel/${m.data.shortcode}/`;
    } catch {
      // already published: a failed lookup must not turn into a retry that posts the Reel twice
    }
    return { accountName: account.name, url, mediaId };
  }

  /**
   * One pass over the methods, best first, each logged:
   *  1. video_url (any length)            2. resumable, only when the video is within Instagram's 60 s limit
   *  3. last resort for a long video: a 58.5 s copy (end faded out) through the resumable upload
   */
  private async publishOnce(account: InstagramAccount, videoPath: string, caption: string): Promise<InstagramUploadResult & { method: string }> {
    const tag = `[${account.name}]`;
    const duration = await this.d.probeDuration(videoPath);
    const tooLong = duration !== null && duration > RESUMABLE_MAX_SEC;
    const failures: string[] = [];
    pipelineLogger.info(`${tag} Instagram: video is ${duration === null ? "of unknown length" : `${duration.toFixed(1)}s`}${tooLong ? ` (over the ${RESUMABLE_MAX_SEC}s limit of the resumable upload)` : ""}`, "InstagramPublisher");

    const base = this.d.publicBaseUrl();
    if (base) {
      try {
        pipelineLogger.info(`${tag} Instagram method 1/3: Instagram downloads the video from a temporary link`, "InstagramPublisher");
        const id = await this.viaUrl(account, videoPath, caption, base);
        return { ...(await this.publishContainer(account, id)), method: "video_url" };
      } catch (err) {
        const msg = this.redact(err instanceof Error ? err.message : String(err), account.accessToken);
        failures.push(`video_url: ${msg}`);
        pipelineLogger.warn(`${tag} Instagram method 1 (video_url) failed: ${msg}`, "InstagramPublisher");
      }
    } else {
      pipelineLogger.info(`${tag} Instagram method 1 (video_url) is off (IG_VIDEO_URL=off or no public URL)`, "InstagramPublisher");
    }

    if (!tooLong) {
      try {
        pipelineLogger.info(`${tag} Instagram method 2/3: resumable upload of the original`, "InstagramPublisher");
        const id = await this.viaResumable(account, videoPath, caption);
        return { ...(await this.publishContainer(account, id)), method: "resumable" };
      } catch (err) {
        const msg = this.redact(err instanceof Error ? err.message : String(err), account.accessToken);
        failures.push(`resumable: ${msg}`);
        pipelineLogger.warn(`${tag} Instagram method 2 (resumable) failed: ${msg}`, "InstagramPublisher");
      }
    } else {
      pipelineLogger.info(`${tag} Instagram method 2 skipped: the resumable upload rejects videos over ${RESUMABLE_MAX_SEC}s`, "InstagramPublisher");
      let copy: string | null = null;
      try {
        pipelineLogger.warn(`${tag} Instagram method 3/3 (LAST RESORT): posting a ${TRIMMED_SEC}s version of the ${duration!.toFixed(1)}s video; the end is cut`, "InstagramPublisher");
        copy = await this.d.makeShortCopy(videoPath, TRIMMED_SEC);
        const id = await this.viaResumable(account, copy, caption);
        return { ...(await this.publishContainer(account, id)), method: "resumable-trimmed" };
      } catch (err) {
        const msg = this.redact(err instanceof Error ? err.message : String(err), account.accessToken);
        failures.push(`trimmed: ${msg}`);
        pipelineLogger.warn(`${tag} Instagram method 3 (trimmed) failed: ${msg}`, "InstagramPublisher");
      } finally {
        if (copy) fs.rm(copy, { force: true }, () => undefined);
      }
    }
    throw new Error(failures.join(" | ") || "no upload method was possible");
  }

  private async uploadToAccount(
    account: InstagramAccount,
    videoPath: string,
    metadata: VideoMetadata,
  ): Promise<InstagramUploadResult | null> {
    if (!account.accessToken || !account.igUserId) {
      pipelineLogger.error(`[${account.name}] Missing Instagram credentials`, undefined, "InstagramPublisher");
      return null;
    }
    const caption = `${metadata.title}\n\n${metadata.description}\n\n${metadata.tags.map((t) => "#" + t.replace(/\s+/g, "")).join(" ")}`;

    const MAX_UPLOAD_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
      try {
        pipelineLogger.info(`[${account.name}] Starting Instagram Reel upload (Attempt ${attempt}/${MAX_UPLOAD_ATTEMPTS})...`, "InstagramPublisher");
        const r = await this.publishOnce(account, videoPath, caption);
        pipelineLogger.checkpoint(`[${account.name}] Uploaded to Instagram (${r.method})`, true, r.url);
        return { accountName: r.accountName, url: r.url, mediaId: r.mediaId };
      } catch (err) {
        const msg = this.redact(err instanceof Error ? err.message : String(err), account.accessToken);
        pipelineLogger.warn(`[${account.name}] Instagram upload attempt ${attempt} failed: ${msg}`, "InstagramPublisher");
        if (attempt < MAX_UPLOAD_ATTEMPTS) {
          pipelineLogger.info(`[${account.name}] Waiting ${this.d.retryDelayMs / 1000}s before retrying...`, "InstagramPublisher");
          await this.d.sleep(this.d.retryDelayMs);
        } else {
          pipelineLogger.error(`[${account.name}] Instagram upload failed after ${MAX_UPLOAD_ATTEMPTS} attempts: every method failed (${msg.slice(0, 400)})`, undefined, "InstagramPublisher");
        }
      }
    }
    return null;
  }

  public async uploadToAllAccounts(
    videoPath: string,
    metadata: VideoMetadata,
  ): Promise<InstagramUploadResult[]> {
    const accounts = this.accounts;

    if (accounts.length === 0) {
      pipelineLogger.warn(
        "No Instagram accounts configured — running in SIMULATED mode",
        "InstagramPublisher",
      );
      // Simulate upload
      await new Promise((r) => setTimeout(r, 2000));
      return [
        {
          accountName: "Simulated Instagram",
          url: "https://instagram.com/reel/simulated/",
          mediaId: "simulated_id",
        },
      ];
    }

    const promises = accounts.map((account) =>
      this.uploadToAccount(account, videoPath, metadata),
    );
    const results = await Promise.all(promises);

    return results.filter((r): r is InstagramUploadResult => r !== null);
  }
}
