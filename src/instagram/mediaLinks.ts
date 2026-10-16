import crypto from "crypto";
import fs from "fs";
import path from "path";
import http from "http";
import { pipelineLogger } from "../utils/logger";

/**
 * Temporary public links for Instagram's "video_url" upload: Instagram's servers download the finished Short from one of
 * these and process it (the resumable upload rejects anything over 60 s, this path accepts longer Reels).
 *
 * The surface is deliberately tiny:
 *  - a link serves exactly ONE registered file; there is no path from the URL to the filesystem
 *  - the token is 32 random bytes (43 url-safe characters): not guessable, never logged in full
 *  - it expires after `ttlMs` (default 30 min), after `maxHits` requests, or as soon as the publisher revokes it
 *  - GET and HEAD only, with Range support (Instagram may fetch in pieces), no caching, no indexing
 */
export interface MediaLink {
  token: string;
  filePath: string;
  size: number;
  expiresAt: number;
  hits: number;
}

export interface RegistryOptions {
  ttlMs?: number;
  maxHits?: number;
  now?: () => number;
}

const TOKEN_RE = /^\/ig-media\/([A-Za-z0-9_-]{43})\.(mp4|jpg)$/;

export class MediaLinkRegistry {
  private links = new Map<string, MediaLink>();
  private readonly ttlMs: number;
  private readonly maxHits: number;
  private readonly now: () => number;

  constructor(opts: RegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.maxHits = opts.maxHits ?? 300;
    this.now = opts.now ?? Date.now;
  }

  /** Registers a file (a video, or a .jpg cover) and returns its URL path ("/ig-media/<token>.mp4" or ".jpg"). Throws if the file is missing or empty. */
  register(filePath: string): { token: string; path: string; expiresAt: number } {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size === 0) throw new Error(`not a usable file: ${filePath}`);
    this.sweep();
    const token = crypto.randomBytes(32).toString("base64url");
    const link: MediaLink = { token, filePath, size: st.size, expiresAt: this.now() + this.ttlMs, hits: 0 };
    this.links.set(token, link);
    const ext = path.extname(filePath).toLowerCase() === ".jpg" ? "jpg" : "mp4";
    return { token, path: `/ig-media/${token}.${ext}`, expiresAt: link.expiresAt };
  }

  /** The live link for a token, or undefined (unknown, expired or used up: an expired one is forgotten here). */
  get(token: string): MediaLink | undefined {
    const link = this.links.get(token);
    if (!link) return undefined;
    if (this.now() > link.expiresAt || link.hits >= this.maxHits) {
      this.links.delete(token);
      return undefined;
    }
    return link;
  }

  revoke(token: string): void {
    this.links.delete(token);
  }

  sweep(): void {
    const t = this.now();
    for (const [k, l] of this.links) if (t > l.expiresAt || l.hits >= this.maxHits) this.links.delete(k);
  }

  size(): number {
    this.sweep();
    return this.links.size;
  }
}

/** One registry per process, swept every minute (the timer never keeps the process alive). */
export const mediaLinks = new MediaLinkRegistry();
setInterval(() => mediaLinks.sweep(), 60_000).unref();

/** "bytes=a-b" -> inclusive range; null = no usable header (serve the whole file); "invalid" = 416. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number, end: number;
  if (m[1] === "") {
    // suffix range: the last N bytes
    const n = Number(m[2]);
    if (!(n > 0)) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  return { start, end };
}

const shortTok = (t: string) => `${t.slice(0, 6)}…`;

/**
 * Handles GET/HEAD /ig-media/<token>.mp4. Returns false for any other path (the caller carries on), true when it answered.
 * Every answer for a bad token is the same bare 404: nothing tells a prober whether a token ever existed.
 */
export function handleMediaRequest(req: http.IncomingMessage, res: http.ServerResponse, registry: MediaLinkRegistry = mediaLinks): boolean {
  const pathname = (req.url || "").split("?")[0];
  if (!pathname.startsWith("/ig-media/")) return false;

  const notFound = () => {
    res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("Not found");
  };
  const method = req.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
    res.end();
    return true;
  }
  const m = TOKEN_RE.exec(pathname);
  const link = m ? registry.get(m[1]) : undefined;
  if (!m || !link) {
    notFound();
    return true;
  }

  let size: number;
  try {
    size = fs.statSync(link.filePath).size;
  } catch {
    registry.revoke(link.token);
    pipelineLogger.warn(`[IGMedia] ${shortTok(link.token)}: the file is gone, link revoked`, "IGMedia");
    notFound();
    return true;
  }

  const range = parseRange(req.headers.range as string | undefined, size);
  if (range === "invalid") {
    res.writeHead(416, { "Content-Range": `bytes */${size}`, "Cache-Control": "no-store" });
    res.end();
    return true;
  }
  link.hits++;
  const base = {
    "Content-Type": m[2] === "jpg" ? "image/jpeg" : "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Content-Disposition": "inline",
  };
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const len = end - start + 1;
  res.writeHead(range ? 206 : 200, {
    ...base,
    "Content-Length": String(len),
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  });
  pipelineLogger.info(`[IGMedia] ${shortTok(link.token)}: ${method} ${range ? `bytes ${start}-${end}` : "whole file"} (${len} bytes), hit ${link.hits}`, "IGMedia");
  if (method === "HEAD") {
    res.end();
    return true;
  }
  const stream = fs.createReadStream(link.filePath, { start, end });
  stream.on("error", (err) => {
    pipelineLogger.warn(`[IGMedia] ${shortTok(link.token)}: read error: ${err.message}`, "IGMedia");
    res.destroy();
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
  return true;
}
