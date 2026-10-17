import crypto from "crypto";
import type { IncomingMessage } from "http";

/**
 * Login for the dashboard / API. One password (DASHBOARD_PASSWORD), then a signed cookie that lasts months, so the
 * password is typed once per browser. The cookie is "<expiry-ms>.<hmac>": stateless, survives restarts, and changing the
 * password (or DASHBOARD_SESSION_SECRET) logs everybody out.
 *
 * Without DASHBOARD_PASSWORD the server still refuses everything: it makes up a password for this run and prints it to
 * the container's stdout only (never the log file, which the dashboard serves).
 */
export const COOKIE_NAME = "dash_session";
export const SESSION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

let password = (process.env.DASHBOARD_PASSWORD || "").trim();
if (!password) {
  password = crypto.randomBytes(12).toString("base64url");
  // eslint-disable-next-line no-console
  console.warn(`[dashboard-auth] DASHBOARD_PASSWORD is not set — using a temporary one for this run: ${password}`);
}

const signingKey = () =>
  crypto.createHash("sha256").update(`dash-session|${process.env.DASHBOARD_SESSION_SECRET || ""}|${password}`).digest();

const sign = (expiry: number): string => crypto.createHmac("sha256", signingKey()).update(String(expiry)).digest("base64url");

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export const checkPassword = (supplied: string): boolean => safeEqual(String(supplied || ""), password);

export function makeSessionToken(now = Date.now()): string {
  const expiry = now + SESSION_DAYS * DAY_MS;
  return `${expiry}.${sign(expiry)}`;
}

/** Returns the milliseconds left on a valid token, or 0 when it is missing, forged or expired. */
export function sessionRemainingMs(token: string | undefined, now = Date.now()): number {
  if (!token) return 0;
  const dot = token.indexOf(".");
  if (dot < 1) return 0;
  const expiry = Number(token.slice(0, dot));
  if (!Number.isFinite(expiry) || expiry <= now) return 0;
  return safeEqual(token.slice(dot + 1), sign(expiry)) ? expiry - now : 0;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean, maxAgeSec = SESSION_DAYS * 24 * 60 * 60): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${maxAgeSec}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export const clearCookie = (secure: boolean): string => sessionCookie("", secure, 0);

export const isSecure = (req: IncomingMessage): boolean => String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";

export interface AuthResult {
  ok: boolean;
  /** A fresh cookie to send, when the session is past half its life (so an active browser never has to log in again). */
  renew?: string;
}

/** Cookie session, or `Authorization: Bearer <password>` for scripts. */
export function authenticate(req: IncomingMessage): AuthResult {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  if (bearer && checkPassword(bearer[1].trim())) return { ok: true };
  const left = sessionRemainingMs(readCookie(req.headers.cookie, COOKIE_NAME));
  if (left <= 0) return { ok: false };
  return { ok: true, renew: left < (SESSION_DAYS * DAY_MS) / 2 ? sessionCookie(makeSessionToken(), isSecure(req)) : undefined };
}

// ── login attempts: 5 wrong passwords per address per 15 minutes ──────────────────────────────
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const fails = new Map<string, number[]>();

export function clientIp(req: IncomingMessage): string {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
}

export function loginBlocked(ip: string, now = Date.now()): boolean {
  const recent = (fails.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  fails.set(ip, recent);
  return recent.length >= MAX_FAILS;
}

export function recordLoginFailure(ip: string, now = Date.now()): void {
  fails.set(ip, [...(fails.get(ip) || []).filter((t) => now - t < WINDOW_MS), now]);
}

export const clearLoginFailures = (ip: string): void => void fails.delete(ip);

/**
 * Routes called by machines, not by a browser, so they cannot carry the login cookie. Each one has its own check:
 * the reel injector sends x-inject-token, the cloud renderer's bundle download and progress callback are keyed by an
 * unguessable job slug (+ a per-job token for progress and for the runner's YouTube-upload token), and Meta's DM webhook is verified by its verify token.
 */
export function isMachineRoute(method: string, pathname: string): boolean {
  if (method === "POST" && (pathname === "/api/inject-reels" || pathname === "/api/longvideo/progress" || pathname === "/api/longvideo/yt-token" || pathname === "/api/dm/webhook")) return true;
  if ((method === "GET" || method === "HEAD") && (pathname.startsWith("/api/longvideo/bundle/") || pathname.startsWith("/api/short/bundle/") || pathname === "/api/dm/webhook")) return true;
  return false;
}

/** Only same-site paths: "/dashboard" yes, "//evil.com" and "https://evil.com" no. */
export const safeNext = (next: string | null | undefined): string => (next && /^\/(?![/\\])/.test(next) ? next : "/");

export function loginPage(next: string, error = ""): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0b;color:#eee;font:16px system-ui,sans-serif}
form{width:min(340px,86vw);display:grid;gap:14px}h1{margin:0;font-size:22px;color:#ffb800}
input,button{padding:12px;border-radius:8px;border:1px solid #333;font:inherit}input{background:#161616;color:#eee}
button{background:#ffb800;color:#000;border:0;font-weight:600;cursor:pointer}.e{color:#ff6b6b;min-height:1.2em;margin:0}</style></head>
<body><form method="post" action="/login"><h1>Dashboard</h1><input type="hidden" name="next" value="${esc(next)}">
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" required>
<p class="e">${esc(error)}</p><button type="submit">Sign in</button></form></body></html>`;
}
