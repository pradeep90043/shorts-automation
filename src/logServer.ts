import { jobProgress } from "./utils/jobProgress";
import http from "http";
import fs from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { google } from "googleapis";
import { addLogClient, removeLogClient } from "./utils/logBroadcast";
import { config, ChannelProfile, resolveTheme } from "./config";
import { getPool } from "./utils/pgClient";
import { getChannelCredentials, patchChannelCredentials } from "./utils/credentialStore";
import { getAllStoredChannelConfigs, saveChannelConfig, deleteChannelConfig, StoredChannelConfig, StoredInstagramAccount, StoredYoutubeChannel } from "./utils/channelConfigStore";
import { getAllAudienceStats } from "./utils/audienceStats";
import {
  authenticate, checkPassword, clearCookie, clearLoginFailures, clientIp, isMachineRoute, isSecure, loginBlocked, loginPage, makeSessionToken,
  recordLoginFailure, safeNext, sessionCookie,
} from "./utils/dashboardAuth";
import { maskChannel, restoreMasked } from "./utils/channelMask";
import { autoLongSnapshot, enqueueNow } from "./longvideo-auto";
import { candidateStore } from "./longvideo-auto/config";
import { longQueue } from "./longvideo-auto/queue";
import { handleMediaRequest } from "./instagram/mediaLinks";
import { activeWatchers } from "./instagram/channelWatcher";
import { DirectUploader } from "./direct-uploader";
import { ViralAnalyzer } from "./utils/viral-analyzer";
import { buildHashtagsForNiche } from "./instagram/nicheSearcher";
import { computeViralScore } from "./utils/viralScore";
import { MultiSceneGenerator } from "./video/multiSceneGenerator";
import { YouTubeService } from "./youtube";
import { estimateStickman } from "./my-video/stickmanEstimate";
import { buildImportPrompts, buildPlanOnlyPrompt, checkImportedPlan, checkPlanOnly, PlanImportError } from "./my-video/stickmanPlanner";
import { cancelStickmanJob, continueStickmanJob, getStickmanJob, getStickmanJobForPoll, listStickmanJobs, markRemotePublic, resetPublish, restartStickmanJob, setRunnerPublishProvider, setRunnerUploadedHook, startPublish, startStickmanJob } from "./my-video/stickmanJobs";
import { handleRunnerPublish, recordCloudProgress, resolveMyVideoDir } from "./my-video/myVideoService";
import { pipelineLogger } from "./utils/logger";
import { buildActivityFeed, mergeLiveJobs, loadJobSummaries, jobsFileFor } from "./utils/activityFeed";
import { dmStore, dmKnowledgeBase, inboundDmManager, outboundDmManager, aiDmBrain, getPersona } from "./instagram/dm";

function escapeHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let ytOAuthServer: http.Server | null = null;

/** Port the local YouTube OAuth callback listener binds to. Must match the
 *  redirect URI registered in Google Cloud Console. */
const OAUTH_PORT = parseInt(process.env.YOUTUBE_OAUTH_PORT || "3001", 10);
const OAUTH_REDIRECT_URI =
  process.env.YOUTUBE_REDIRECT_URI || `http://localhost:${OAUTH_PORT}/oauth2callback`;

const GRAPH_VERSION = "v19.0";
const META_APP_ID = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || "";
/** Facebook Login redirect target. Defaults to <origin of the YT redirect>/meta/oauth2callback.
 *  Must be listed in the FB app → Facebook Login → Settings → Valid OAuth Redirect URIs. */
const META_REDIRECT_URI =
  process.env.META_REDIRECT_URI ||
  (() => {
    try { return `${new URL(OAUTH_REDIRECT_URI).origin}/meta/oauth2callback`; }
    catch { return `http://localhost:${OAUTH_PORT}/meta/oauth2callback`; }
  })();
const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "business_management",
].join(",");

let tokenStatusCache: { at: number; tokens: any[] } | null = null;

/** App access token for reliable /debug_token calls (falls back to the token itself). */
function metaAppToken(): string {
  return META_APP_ID && META_APP_SECRET ? `${META_APP_ID}|${META_APP_SECRET}` : "";
}

/** Inspect a Meta token: returns { status, expiresAt, dataAccessExpiresAt, scopes, message }. */
async function inspectMetaToken(token: string): Promise<{
  status: "valid" | "expired" | "invalid" | "unknown";
  expiresAt: number | null;
  dataAccessExpiresAt: number | null;
  scopes: string[];
  message: string;
}> {
  if (!token) return { status: "unknown", expiresAt: null, dataAccessExpiresAt: null, scopes: [], message: "no token stored" };
  const appTok = metaAppToken() || token;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 25000);
    const r = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appTok)}`,
      { signal: ac.signal },
    ).finally(() => clearTimeout(t));
    const j: any = await r.json();
    if (j.error) {
      const expired = /expired/i.test(j.error.message || "") || j.error.code === 190;
      return { status: expired ? "expired" : "invalid", expiresAt: null, dataAccessExpiresAt: null, scopes: [], message: j.error.message || "invalid" };
    }
    const d = j.data || {};
    if (d.is_valid === false) {
      const expired = /expired/i.test(d.error?.message || "");
      return { status: expired ? "expired" : "invalid", expiresAt: d.expires_at || null, dataAccessExpiresAt: d.data_access_expires_at || null, scopes: d.scopes || [], message: d.error?.message || "token not valid" };
    }
    return {
      status: "valid",
      expiresAt: d.expires_at || 0,
      dataAccessExpiresAt: d.data_access_expires_at || null,
      scopes: d.scopes || [],
      message: d.expires_at ? "" : "never expires",
    };
  } catch (e: any) {
    return { status: "unknown", expiresAt: null, dataAccessExpiresAt: null, scopes: [], message: e?.name === "AbortError" ? "Meta API timed out" : (e?.message || String(e)) };
  }
}

/**
 * Handle the Google OAuth redirect (`/oauth2callback?code=...`). Exchanges the
 * code for a refresh token and returns an HTML page that posts it back to the
 * dashboard tab. Served from BOTH the main dashboard port (so it works on prod
 * behind Caddy/HTTPS) and the legacy localhost:OAUTH_PORT listener (local dev).
 */
export async function renderYouTubeOAuthCallback(parsedUrl: URL, res: http.ServerResponse): Promise<void> {
  const code = parsedUrl.searchParams.get("code");
  const stateStr = parsedUrl.searchParams.get("state") || "{}";
  let stateObj: any = {};
  try { stateObj = JSON.parse(stateStr); } catch {}

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h3>❌ No authorization code found in callback.</h3>");
    return;
  }

  try {
    const clientId = process.env.YOUTUBE_CLIENT_ID || "";
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || "";
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, OAUTH_REDIRECT_URI);
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h3>⚠️ No refresh token returned. Revoke permissions at <a href='https://myaccount.google.com/permissions'>myaccount.google.com/permissions</a> and try again.</h3>");
      return;
    }

    oauth2Client.setCredentials(tokens);
    let channelTitle = "YouTube Channel";
    try {
      const yt = google.youtube({ version: "v3", auth: oauth2Client });
      const listRes = await yt.channels.list({ part: ["snippet"], mine: true });
      if (listRes.data.items?.[0]?.snippet?.title) {
        channelTitle = listRes.data.items[0].snippet.title;
      }
    } catch (e: any) {
      pipelineLogger.warn(`[OAuth] Could not fetch channel title: ${e.message}`);
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>YouTube Connected</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
          .box { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; max-width: 420px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
          h2 { color: #3fb950; margin-top: 0; }
          .ch-badge { background: rgba(56, 139, 253, 0.15); color: #58a6ff; border: 1px solid rgba(56, 139, 253, 0.4); padding: 4px 10px; border-radius: 6px; font-weight: 700; display: inline-block; margin: 12px 0; font-size: 15px; }
        </style>
      </head>
      <body>
        <div class="box">
          <h2>✅ YouTube Connected!</h2>
          <div class="ch-badge">📺 ${escapeHtml(channelTitle)}</div>
          <p style="font-size: 13px; color: #8b949e;">Adding channel and token to your dashboard...</p>
        </div>
        <script>
          const payload = {
            type: 'YOUTUBE_AUTH_SUCCESS',
            channelName: ${JSON.stringify(channelTitle)},
            refreshToken: ${JSON.stringify(refreshToken)},
            target: ${JSON.stringify(stateObj.target || '')}
          };
          if (window.opener) {
            window.opener.postMessage(payload, '*');
            setTimeout(() => window.close(), 1200);
          } else {
            document.querySelector('p').textContent = 'Copy this refresh token into the dashboard: ' + ${JSON.stringify(refreshToken)};
          }
        </script>
      </body>
      </html>
    `);
  } catch (err: any) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h3>❌ Token exchange failed: ${escapeHtml(err.message)}</h3>`);
  }
}

function ensureYouTubeOAuthServer(): void {
  if (ytOAuthServer) return;
  // Only needed for local dev: on prod the redirect URI is the public HTTPS
  // domain, and /oauth2callback is served by the main dashboard port.
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(OAUTH_REDIRECT_URI)) return;
  try {
    const oauthPort = OAUTH_PORT;
    ytOAuthServer = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url || "/", `http://localhost:${oauthPort}`);
      if (parsedUrl.pathname === "/oauth2callback") {
        await renderYouTubeOAuthCallback(parsedUrl, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    ytOAuthServer.listen(oauthPort, () => {
      console.log(`[LogServer] YouTube OAuth callback listener active on http://localhost:${oauthPort}/oauth2callback`);
    });

    ytOAuthServer.on("error", (e: any) => {
      if (e.code !== "EADDRINUSE") {
        console.warn(`[LogServer] YouTube OAuth server error: ${e.message}`);
      }
    });
  } catch (err: any) {
    console.warn(`[LogServer] Could not initialize YouTube OAuth server: ${err.message}`);
  }
}

const PORT = parseInt(process.env.LOG_SERVER_PORT || "3002", 10);
const COMBINED_LOG = path.join(config.paths.logDir, "combined.log");
const ERROR_LOG = path.join(config.paths.logDir, "error.log");
const TAIL_LINES = 350;

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function readLastLines(filePath: string, maxLines: number): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    if (fileSize === 0) return [];

    const fd = fs.openSync(filePath, "r");
    const bufferSize = 65536;
    const buffer = Buffer.alloc(bufferSize);
    let filePosition = fileSize;
    let lineCount = 0;
    const chunks: string[] = [];

    while (filePosition > 0 && lineCount <= maxLines) {
      const readLength = Math.min(bufferSize, filePosition);
      filePosition -= readLength;
      fs.readSync(fd, buffer, 0, readLength, filePosition);
      
      const chunk = buffer.toString("utf8", 0, readLength);
      chunks.unshift(chunk);
      
      let pos = -1;
      while ((pos = chunk.indexOf("\n", pos + 1)) !== -1) {
        lineCount++;
      }
    }

    fs.closeSync(fd);

    const fullText = chunks.join("");
    const lines = fullText.split("\n").filter((l) => l.trim());
    return lines.slice(-maxLines);
  } catch (err) {
    console.error("Error reading last lines of log file:", err);
    return [];
  }
}

function generateTimeSeriesData(
  days: number,
  channels: string[],
  reelHistory: any[] = [],
  reelInsights: any[] = [],
) {
  const labels: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    labels.push(
      days <= 14
        ? d.toLocaleDateString([], { weekday: "short", day: "numeric" })
        : d.toLocaleDateString([], { month: "short", day: "numeric" }),
    );
  }

  const series: Record<
    string,
    { views: number[]; reels: number[]; er: number[]; shares: number[] }
  > = {};
  channels.forEach((ch) => {
    const viewsArr: number[] = [];
    const reelsArr: number[] = [];
    const erArr: number[] = [];
    const sharesArr: number[] = [];

    const chHistory = reelHistory.filter((r) =>
      (r.profile_key || r.channel || "")
        .toLowerCase()
        .includes(ch.toLowerCase()),
    );
    const chInsights = reelInsights.filter((i) =>
      (i.profile_key || "").toLowerCase().includes(ch.toLowerCase()),
    );

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date(now);
      dayStart.setDate(dayStart.getDate() - i);
      dayStart.setHours(0, 0, 0, 0);

      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);

      const dayReels = chHistory.filter((r) => {
        if (!r.published_at && !r.picked_at) return false;
        const pDate = new Date(r.published_at || r.picked_at);
        return pDate >= dayStart && pDate <= dayEnd;
      });

      const dayCount = dayReels.length;
      let dayViews = dayReels.reduce(
        (sum, r) => sum + (Number(r.views) || 0),
        0,
      );
      let dayLikes = dayReels.reduce(
        (sum, r) => sum + (Number(r.likes) || 0),
        0,
      );
      let dayComments = dayReels.reduce(
        (sum, r) => sum + (Number(r.comments) || 0),
        0,
      );
      let dayShares = dayReels.reduce(
        (sum, r) => sum + (Number(r.shares) || 0),
        0,
      );

      const dayInsights = chInsights.filter((ins) => {
        if (!ins.recorded_at) return false;
        const rDate = new Date(ins.recorded_at);
        return rDate >= dayStart && rDate <= dayEnd;
      });

      if (dayInsights.length > 0) {
        dayViews = Math.max(
          dayViews,
          dayInsights.reduce((sum, ins) => sum + (Number(ins.views) || 0), 0),
        );
        dayLikes = Math.max(
          dayLikes,
          dayInsights.reduce((sum, ins) => sum + (Number(ins.likes) || 0), 0),
        );
        dayComments = Math.max(
          dayComments,
          dayInsights.reduce(
            (sum, ins) => sum + (Number(ins.comments) || 0),
            0,
          ),
        );
        dayShares = Math.max(
          dayShares,
          dayInsights.reduce((sum, ins) => sum + (Number(ins.shares) || 0), 0),
        );
      }

      const dayEr =
        dayViews > 0
          ? +(((dayLikes + dayComments + dayShares) / dayViews) * 100).toFixed(
              2,
            )
          : 0;

      viewsArr.push(dayViews);
      reelsArr.push(dayCount);
      erArr.push(dayEr);
      sharesArr.push(dayShares);
    }

    series[ch] = {
      views: viewsArr,
      reels: reelsArr,
      er: erArr,
      shares: sharesArr,
    };
  });

  return { labels, series };
}

function buildRecentActivity(reelHistory: any[], watchStates: any[]) {
  try {
    const logDir = config.paths.logDir || path.resolve(__dirname, "../logs");
    const queues: Record<string, any[]> = {};
    for (const w of watchStates) queues[String(w.profile_key).toLowerCase()] = Array.isArray(w.queue) ? w.queue : [];
    const profiles = config.profiles.map((p) => ({ key: p.key || p.brandName, brandName: p.brandName, isDefault: p.isDefault }));
    const feed = buildActivityFeed({
      history: reelHistory,
      queues,
      profiles,
      jobsFor: (p) => loadJobSummaries(jobsFileFor(logDir, p)),
    });
    return mergeLiveJobs(feed, jobProgress().snapshot(), profiles);
  } catch (err) {
    pipelineLogger.warn(`Activity feed build failed: ${err instanceof Error ? err.message : err}`, "LogServer");
    return [];
  }
}

let dashCache: { at: number; p: Promise<any> } | null = null;
/** Coalesce concurrent/rapid dashboard polls: one DB+log pass per 8s no matter how many tabs. */
function getDashboardData(): Promise<any> {
  const now = Date.now();
  if (dashCache && now - dashCache.at < 8000) return dashCache.p;
  const p = getDashboardDataUncached();
  dashCache = { at: now, p };
  p.catch(() => { if (dashCache?.p === p) dashCache = null; });
  return p;
}

async function getDashboardDataUncached() {
  let dbStatus = "connected";
  let reelHistory: any[] = [];
  let watchStates: any[] = [];
  let reelInsights: any[] = [];

  try {
    const pool = await getPool();
    const historyRes = await pool.query(
      `SELECT * FROM reel_history ORDER BY picked_at DESC LIMIT 100`,
    );
    reelHistory = historyRes.rows;

    const watchRes = await pool.query(`SELECT * FROM watch_state`);
    watchStates = watchRes.rows.map((w) => {
      if (Array.isArray(w.queue)) {
        w.queue = w.queue.filter(
          (q: any) =>
            q.shortcode &&
            !q.shortcode.startsWith("failed-fetch-") &&
            !q.shortcode.startsWith("no-unseen-"),
        );
      }
      return w;
    });

    const insightsRes = await pool.query(
      `SELECT * FROM reel_insights ORDER BY views DESC LIMIT 50`,
    );
    reelInsights = insightsRes.rows;
  } catch {
    dbStatus = "disconnected";
  }

  const recentLogs = readLastLines(COMBINED_LOG, 250);
  const priorityFixes: Array<{
    id: string;
    severity: "high" | "medium" | "low";
    title: string;
    message: string;
    actionHint: string;
  }> = [];

  const igAuthErrors = recentLogs.filter(
    (l) =>
      l.includes("Instagram login failed") ||
      l.includes("LoginRequired") ||
      l.includes("ChallengeRequired"),
  );
  if (igAuthErrors.length > 0) {
    const failedAccounts = Array.from(
      new Set(
        igAuthErrors
          .map((l) => {
            const match = l.match(/account "([^"]+)"/);
            return match ? match[1] : null;
          })
          .filter(Boolean),
      ),
    );

    priorityFixes.push({
      id: "ig_auth",
      severity: "high",
      title: "Instagram Authentication Action Needed",
      message: `Mobile API login failed for account(s): ${failedAccounts.join(", ") || "watcher accounts"}.`,
      actionHint:
        "Update account credentials or session cookies in .env on production server.",
    });
  }

  if (dbStatus === "disconnected") {
    priorityFixes.push({
      id: "db_conn",
      severity: "high",
      title: "Database Connection Interrupted",
      message: "Unable to query PostgreSQL / Supabase tables.",
      actionHint:
        "Verify DATABASE_URL environment variable and database pooler availability.",
    });
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const audienceStatsMap = await getAllAudienceStats();

  const channels = config.profiles.map((profile, idx) => {
    const pKey = (profile.key || profile.brandName).toLowerCase();
    const audStats = audienceStatsMap[pKey] || { igFollowers: null, ytSubscribers: null };
    const wState = watchStates.find((w) => w.profile_key === pKey);

    const profileHistory = reelHistory.filter(
      (r) => r.profile_key === pKey || r.channel?.toLowerCase().includes(pKey),
    );
    const publishedToday = profileHistory.find(
      (r) => r.published_at && String(r.published_at).startsWith(todayStr),
    );
    const lastPublished =
      publishedToday ||
      profileHistory.find((r) => r.published_at) ||
      profileHistory[0];

    const queue = wState?.queue || [];
    const currentSlot = wState?.current_slot || 0;
    const totalSlots = profile.watch?.dailyCount || 6;
    const progressPct = Math.min(
      100,
      Math.round((currentSlot / totalSlots) * 100),
    );

    const profileErrors = igAuthErrors.filter((l) =>
      l.toLowerCase().includes(pKey),
    );
    let status: "working" | "warning" | "error" = "working";
    if (profileErrors.length > 0) status = "warning";

    const publishedCount = profileHistory.filter((r) => !r.failed).length;
    const failedCount = profileHistory.filter((r) => r.failed).length;

    const colors = ["teal", "blue", "purple", "amber", "rose"];
    const avatarColor = colors[idx % colors.length];

    const defaultHashtags = buildHashtagsForNiche(profile.theme);

    return {
      key: pKey,
      name: profile.brandName,
      handle: profile.handle || `@${pKey}`,
      niche: profile.theme?.niche || "tech",
      initials: profile.brandName.slice(0, 2).toUpperCase(),
      color: avatarColor,
      status,
      active: true,
      isWatchOnly: profile.isWatchOnly,
      dailyTarget: profile.watch?.dailyCount || 6,
      dailyLimit: profile.watch?.dailyCount || 6,
      searchMode: profile.watch?.searchMode || "hashtags",
      nicheHashtags: profile.watch?.nicheHashtags || [],
      defaultHashtags,
      watchedChannels: profile.watch?.channels || [],
      excludeChannels: profile.watch?.excludeChannels || [],
      outroVersion: profile.watch?.outroVersion || "v1",
      scheduleTime: profile.watch?.scheduleTime || "09:00",
      gapHours: profile.watch?.gapHours || 3,
      queueCount: queue.length,
      currentSlot,
      totalSlots,
      progressPct,
      watchedChannelsCount: profile.watch?.channels?.length || 0,
      lastPublished: lastPublished
        ? {
            shortcode: lastPublished.shortcode,
            channel: lastPublished.channel,
            publishedAt: lastPublished.published_at || lastPublished.picked_at,
            originalUrl: `https://www.instagram.com/reel/${lastPublished.shortcode}/`,
            youtubeUrl: lastPublished.youtube_url,
            instagramUrl: lastPublished.instagram_url,
            facebookUrl: lastPublished.facebook_url,
            status: lastPublished.failed ? "failed" : "published",
            failedReason: lastPublished.failed_reason,
          }
        : null,
      igFollowers: audStats.igFollowers ?? (profile as any).igFollowers ?? null,
      ytSubscribers: audStats.ytSubscribers ?? (profile as any).ytSubscribers ?? null,
      stats: {
        publishedCount,
        failedCount,
        viralCount: profileHistory.filter((r) => r.views && r.views > 10000)
          .length,
      },
    };
  });

  const defaultFallbackProfiles = [
    {
      key: "codeorcap",
      name: "CodeOrCap",
      handle: "@codeorcap",
      niche: "tech",
      initials: "CO",
      color: "teal",
      dailyLimit: 6,
      active: true,
      igFollowers: null,
      ytSubscribers: null,
    },
    {
      key: "storiyum",
      name: "Storiyum",
      handle: "@storiyum",
      niche: "stories",
      initials: "ST",
      color: "purple",
      dailyLimit: 6,
      active: true,
      igFollowers: null,
      ytSubscribers: null,
    },
    {
      key: "prompt_gag",
      name: "PromptGag",
      handle: "@prompt_gag",
      niche: "finance",
      initials: "PG",
      color: "amber",
      dailyLimit: 6,
      active: true,
      igFollowers: null,
      ytSubscribers: null,
    },
    {
      key: "infoonspot",
      name: "InfoOnSpot",
      handle: "@infoonspot",
      niche: "infoonspot",
      initials: "IO",
      color: "teal",
      dailyLimit: 5,
      active: true,
      igFollowers: null,
      ytSubscribers: null,
    },
  ];

  defaultFallbackProfiles.forEach((fb) => {
    if (!channels.some((c) => c.key === fb.key)) {
      const wState = watchStates.find((w) => w.profile_key === fb.key);
      // Read persisted watch_config from the database so settings like
      // outroVersion, scheduleTime, gapHours etc. survive server restarts
      // and are correctly reflected in the dashboard fallback view.
      let savedWatchConfig: Record<string, any> = {};
      if (wState?.watch_config) {
        try {
          savedWatchConfig = typeof wState.watch_config === "string"
            ? JSON.parse(wState.watch_config)
            : wState.watch_config;
        } catch {}
      }

      const profileHistory = reelHistory.filter(
        (r) =>
          r.profile_key === fb.key || r.channel?.toLowerCase().includes(fb.key),
      );
      const publishedToday = profileHistory.find(
        (r) => r.published_at && String(r.published_at).startsWith(todayStr),
      );
      const lastPublished =
        publishedToday ||
        profileHistory.find((r) => r.published_at) ||
        profileHistory[0];

      const queue = wState?.queue || [];
      const currentSlot = wState?.current_slot || 0;
      const totalSlots = fb.dailyLimit;
      const progressPct = Math.min(
        100,
        Math.round((currentSlot / totalSlots) * 100),
      );

      const publishedCount = profileHistory.filter((r) => !r.failed).length;
      const failedCount = profileHistory.filter((r) => r.failed).length;

      channels.push({
        key: fb.key,
        name: fb.name,
        handle: fb.handle,
        niche: fb.niche as any,
        initials: fb.initials,
        color: fb.color,
        status: "working",
        active: true,
        isWatchOnly: false,
        dailyTarget: fb.dailyLimit,
        dailyLimit: fb.dailyLimit,
        searchMode: savedWatchConfig.searchMode || "hashtags",
        nicheHashtags: savedWatchConfig.nicheHashtags || [],
        defaultHashtags: buildHashtagsForNiche({ niche: fb.niche } as any),
        watchedChannels: savedWatchConfig.channels || [],
        excludeChannels: savedWatchConfig.excludeChannels || [],
        outroVersion: (savedWatchConfig.outroVersion || "v1") as "v1" | "v2",
        scheduleTime: savedWatchConfig.scheduleTime || "09:00",
        gapHours: savedWatchConfig.gapHours || 3,
        queueCount: queue.length,
        currentSlot,
        totalSlots,
        progressPct,
        watchedChannelsCount: 4,
        igFollowers: fb.igFollowers,
        ytSubscribers: fb.ytSubscribers,
        lastPublished: lastPublished
          ? {
              shortcode: lastPublished.shortcode,
              channel: lastPublished.channel,
              publishedAt:
                lastPublished.published_at || lastPublished.picked_at,
              originalUrl: `https://www.instagram.com/reel/${lastPublished.shortcode}/`,
              youtubeUrl: lastPublished.youtube_url,
              instagramUrl: lastPublished.instagram_url,
              facebookUrl: lastPublished.facebook_url,
              status: lastPublished.failed ? "failed" : "published",
              failedReason: lastPublished.failed_reason,
            }
          : null,
        stats: {
          publishedCount,
          failedCount,
          viralCount: profileHistory.filter(
            (r) => r.views && Number(r.views) > 10000,
          ).length,
        },
      });
    }
  });

  const channelKeys = Array.from(
    new Set([
      ...channels.map((c) => c.key),
      "codeorcap",
      "storiyum",
      "prompt_gag",
      "infoonspot",
    ]),
  );

  // Compile full Queue items across all watch_states & reelHistory
  const compiledQueue: any[] = [];

  watchStates.forEach((ws) => {
    const rawList = ws.queue || [];
    const qList = rawList.filter((q: any) => {
      const sc = q.shortcode || "";
      if (sc.startsWith("failed-fetch-") || sc.startsWith("no-unseen-"))
        return false;
      return true;
    });
    qList.forEach((q: any, idx: number) => {
      const sc =
        q.shortcode ||
        q.url?.split("/reel/")[1]?.split("/")[0] ||
        q.url?.split("/p/")[1]?.split("/")[0];
      if (!sc || sc.startsWith("failed-fetch-") || sc.startsWith("no-unseen-"))
        return;
      compiledQueue.push({
        id: `q_${ws.profile_key}_${sc}`,
        shortcode: sc,
        channel: ws.profile_key,
        source: q.url || `https://www.instagram.com/reel/${sc}/`,
        addedAt: q.pickedAt || q.addedAt || new Date().toISOString(),
        status: idx === 0 ? "processing" : "queued",
        slot: idx + 1,
        playCount: Number(q.playCount || q.play_count || 0),
        likeCount: Number(q.likeCount || q.like_count || 0),
        commentCount: Number(q.commentCount || q.comment_count || 0),
      });
    });
  });

  reelHistory.forEach((rh, idx) => {
    if (
      !rh.shortcode ||
      rh.shortcode.startsWith("failed-fetch-") ||
      rh.shortcode.startsWith("no-unseen-")
    )
      return;
    compiledQueue.push({
      id: `h_${rh.shortcode}_${rh.profile_key}`,
      shortcode: rh.shortcode,
      channel: rh.profile_key || "codeorcap",
      source:
        rh.instagram_url || `https://www.instagram.com/reel/${rh.shortcode}/`,
      youtubeUrl: rh.youtube_url,
      facebookUrl: rh.facebook_url,
      addedAt: rh.published_at || rh.picked_at,
      status: rh.failed ? "failed" : "published",
      slot: (idx % 6) + 1,
      playCount: Number(rh.views || 0),
      likeCount: Number(rh.likes || 0),
      commentCount: Number(rh.comments || 0),
    });
  });

  // Analytics time-series computed directly from PostgreSQL reelHistory & reelInsights
  const timeSeriesRanges = {
    "7d": generateTimeSeriesData(7, channelKeys, reelHistory, reelInsights),
    "14d": generateTimeSeriesData(14, channelKeys, reelHistory, reelInsights),
    "30d": generateTimeSeriesData(30, channelKeys, reelHistory, reelInsights),
    "90d": generateTimeSeriesData(90, channelKeys, reelHistory, reelInsights),
  };

  // Collect & compile viral analytics data
  const viralAnalyzer = new ViralAnalyzer();
  const analyticsRecords = viralAnalyzer.getRecords();
  const viralPatternsText = viralAnalyzer.getViralPatterns();

  const allReelsMap = new Map<string, any>();
  compiledQueue.forEach((q) => {
    allReelsMap.set(q.shortcode, {
      ...q,
      title: q.title || `Short clip #${q.shortcode}`,
      sourceChannel: q.channel || "creator",
      profileKey: q.channel,
    });
  });

  analyticsRecords.forEach((rec) => {
    const existing = allReelsMap.get(rec.id) || {};
    allReelsMap.set(rec.id, {
      ...existing,
      shortcode: rec.id,
      title: rec.title,
      profileKey: existing.profileKey || "codeorcap",
      sourceChannel: existing.sourceChannel || "analytics",
      playCount: Math.max(rec.metrics?.views || 0, existing.playCount || 0),
      likeCount: Math.max(rec.metrics?.likes || 0, existing.likeCount || 0),
      commentCount: Math.max(
        rec.metrics?.comments || 0,
        existing.commentCount || 0,
      ),
      youtubeUrl: rec.youtubeUrl || existing.youtubeUrl,
      sourceUrl:
        existing.sourceUrl ||
        rec.youtubeUrl ||
        `https://www.instagram.com/reel/${rec.id}/`,
      status: "published",
    });
  });

  const reelsList = Array.from(allReelsMap.values());
  const maxPlays = Math.max(1, ...reelsList.map((r) => r.playCount || 0));
  const maxLikes = Math.max(1, ...reelsList.map((r) => r.likeCount || 0));
  const maxComments = Math.max(1, ...reelsList.map((r) => r.commentCount || 0));

  const scoredReels = reelsList
    .map((r) => {
      const playC = r.playCount || 0;
      const likeC = r.likeCount || 0;
      const commC = r.commentCount || 0;
      const calculatedScore = computeViralScore(
        { playCount: playC, likeCount: likeC, commentCount: commC },
        { playCount: maxPlays, likeCount: maxLikes, commentCount: maxComments },
      );
      const er = playC > 0 ? +(((likeC + commC) / playC) * 100).toFixed(1) : 0;
      const shares = Math.round(playC * 0.045);
      let trend = "→";
      if (calculatedScore >= 80) trend = "↑";
      else if (calculatedScore < 50) trend = "↓";

      return {
        ...r,
        viralScore: r.viralScore || calculatedScore,
        er,
        shares,
        trend,
      };
    })
    .sort((a, b) => b.viralScore - a.viralScore);

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const recent7Views = reelHistory
    .filter(
      (r) =>
        nowMs - new Date(r.published_at || r.picked_at || 0).getTime() <=
        sevenDaysMs,
    )
    .reduce((s, r) => s + (Number(r.views) || 0), 0);
  const prev7Views = reelHistory
    .filter((r) => {
      const age =
        nowMs - new Date(r.published_at || r.picked_at || 0).getTime();
      return age > sevenDaysMs && age <= 14 * 24 * 60 * 60 * 1000;
    })
    .reduce((s, r) => s + (Number(r.views) || 0), 0);
  const viewsDelta =
    prev7Views > 0
      ? Math.round(((recent7Views - prev7Views) / prev7Views) * 100)
      : recent7Views > 0
        ? 100
        : 0;

  const recent7Shares = reelHistory
    .filter(
      (r) =>
        nowMs - new Date(r.published_at || r.picked_at || 0).getTime() <=
        sevenDaysMs,
    )
    .reduce((s, r) => s + (Number(r.shares) || 0), 0);
  const prev7Shares = reelHistory
    .filter((r) => {
      const age =
        nowMs - new Date(r.published_at || r.picked_at || 0).getTime();
      return age > sevenDaysMs && age <= 14 * 24 * 60 * 60 * 1000;
    })
    .reduce((s, r) => s + (Number(r.shares) || 0), 0);
  const sharesDelta =
    prev7Shares > 0
      ? Math.round(((recent7Shares - prev7Shares) / prev7Shares) * 100)
      : recent7Shares > 0
        ? 100
        : 0;

  const viralAnalytics = {
    timeSeriesRanges,
    kpis: {
      totalViews: scoredReels.reduce((s, r) => s + (r.playCount || 0), 0),
      totalReels: scoredReels.length,
      avgER:
        scoredReels.length > 0
          ? +(
              scoredReels.reduce((s, r) => s + r.er, 0) / scoredReels.length
            ).toFixed(1)
          : 0,
      totalShares: scoredReels.reduce((s, r) => s + (r.shares || 0), 0),
      viewsDelta,
      sharesDelta,
    },
    leaderboard: scoredReels.slice(0, 25),
    patternsText: viralPatternsText,
  };

  return {
    systemHealth: {
      status: priorityFixes.length > 0 ? "warning" : "healthy",
      dbStatus,
      activeProfilesCount: config.profiles.length,
      priorityFixes,
    },
    channels,
    queue: compiledQueue,
    recentHistory: reelHistory.slice(0, 15),
    recentActivity: buildRecentActivity(reelHistory, watchStates),
    topInsights: reelInsights.slice(0, 15),
    viralAnalytics,
  };
}

async function getChannelDetails(pKey: string) {
  pKey = pKey.toLowerCase();
  const profile = config.profiles.find(
    (p) => (p.key || p.brandName).toLowerCase() === pKey,
  );
  if (!profile) return null;

  let queue: any[] = [];
  let history: any[] = [];
  let currentSlot = 0;

  try {
    const pool = await getPool();
    const wRes = await pool.query(
      `SELECT * FROM watch_state WHERE profile_key = $1`,
      [pKey],
    );
    if (wRes.rows.length > 0) {
      queue = wRes.rows[0].queue || [];
      currentSlot = wRes.rows[0].current_slot || 0;
    }

    const hRes = await pool.query(
      `SELECT * FROM reel_history WHERE profile_key = $1 ORDER BY picked_at DESC LIMIT 50`,
      [pKey],
    );
    history = hRes.rows;
  } catch {}

  const formattedQueue = queue.map((q: any) => ({
    shortcode:
      q.shortcode || q.url?.split("/reel/")[1]?.replace(/\//g, "") || "N/A",
    originalUrl: q.url || `https://www.instagram.com/reel/${q.shortcode}/`,
    sourceChannel: q.channel || q.creatorUsername || "n/a",
    sourceHashtag: q.sourceHashtag || profile.theme?.niche || "tech",
    playCount: q.playCount || q.play_count || 0,
    likeCount: q.likeCount || q.like_count || 0,
    commentCount: q.commentCount || q.comment_count || 0,
    pickedAt: q.pickedAt || new Date().toISOString(),
  }));

  const formattedHistory = history.map((h: any) => ({
    shortcode: h.shortcode,
    sourceChannel: h.channel || "n/a",
    originalUrl: `https://www.instagram.com/reel/${h.shortcode}/`,
    youtubeUrl: h.youtube_url,
    instagramUrl: h.instagram_url,
    facebookUrl: h.facebook_url,
    publishedAt: h.published_at || h.picked_at,
    status: h.failed ? "failed" : "published",
    failedReason: h.failed_reason,
  }));

  return {
    profile: {
      key: pKey,
      name: profile.brandName,
      handle: profile.handle || `@${pKey}`,
      niche: profile.theme?.niche || "tech",
      isWatchOnly: profile.isWatchOnly,
      dailyTarget: profile.watch?.dailyCount || 6,
      scheduleTime: profile.watch?.scheduleTime || "09:00",
      gapHours: profile.watch?.gapHours || 3,
      watchedChannels: profile.watch?.channels || [],
      outroVersion: profile.watch?.outroVersion || "v1",
      currentSlot,
      totalSlots: profile.watch?.dailyCount || 6,
      progressPct: Math.min(
        100,
        Math.round((currentSlot / (profile.watch?.dailyCount || 6)) * 100),
      ),
    },
    queue: formattedQueue,
    history: formattedHistory,
  };
}

function resolveHtmlPath(): string {
  const candidates = [
    path.join(process.cwd(), "public", "dashboard.html"),
    path.join(process.cwd(), "src", "dashboard.html"),
    path.join(__dirname, "dashboard.html"),
    path.join(__dirname, "..", "public", "dashboard.html"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    "dashboard.html not found. Expected at src/dashboard.html or public/dashboard.html",
  );
}

const liveReloadClients = new Set<http.ServerResponse>();

function notifyLiveReload() {
  for (const client of liveReloadClients) {
    try { client.write("data: reload\n\n"); } catch { liveReloadClients.delete(client); }
  }
}

let htmlCache: { mtime: number; out: string } | null = null;
function getHTML(): string {
  const htmlPath = resolveHtmlPath();
  const mtime = fs.statSync(htmlPath).mtimeMs;
  if (htmlCache && htmlCache.mtime === mtime) return htmlCache.out;
  const html = fs.readFileSync(htmlPath, "utf8");
  const out = buildHTML(html);
  htmlCache = { mtime, out };
  return out;
}

function buildHTML(html: string): string {
  // Inject hot-reload client script before </body>
  const hotReloadScript = `
<script>
(function(){
  const es = new EventSource('/__livereload');
  es.onmessage = function(e){ if(e.data==='reload') window.location.reload(); };
  es.onerror = function(){ setTimeout(()=>{ const es2=new EventSource('/__livereload'); es2.onmessage=es.onmessage; },3000); };
})();
</script>`;
  return html.replace(/<\/body>/, hotReloadScript + "</body>");
}

let lvJobsCache: { at: number; body: string } | null = null;

/** A YouTubeService for one dashboard channel profile, or null when no YouTube channel is connected to it. */
export async function youtubeServiceFor(channelKey: string): Promise<YouTubeService | null> {
  const stored = (await getAllStoredChannelConfigs()).find((c) => c.key === channelKey);
  const ytChannels = stored?.youtubeChannels || [];
  if (ytChannels.length === 0 && !stored?.youtubeRefreshToken) return null;

  // Deduplicate channels by name so multiple/duplicate tokens for the same channel count as 1
  const deduped: StoredYoutubeChannel[] = [];
  const seen = new Set<string>();
  for (const c of ytChannels) {
    const nameKey = (c.name || channelKey).toLowerCase().trim();
    if (c.refreshToken && !seen.has(nameKey)) {
      seen.add(nameKey);
      deduped.push(c);
    }
  }

  return new YouTubeService({
    clientId: stored?.youtubeClientId || process.env.YOUTUBE_CLIENT_ID || "",
    clientSecret: stored?.youtubeClientSecret || process.env.YOUTUBE_CLIENT_SECRET || "",
    redirectUri: stored?.youtubeRedirectUri || OAUTH_REDIRECT_URI,
    channels: deduped.length > 0 ? deduped : [{ name: stored?.brandName || channelKey, refreshToken: stored?.youtubeRefreshToken || "" }],
  });
}

export function startLogServer(): void {
  // Long videos: the cloud runner uploads the finished video to YouTube itself (private) with a short-lived token
  // from here, so this server does not have to download and unpack it. Needs at least one connected channel.
  setRunnerPublishProvider(async (job) => {
    if (process.env.LONGVIDEO_RUNNER_UPLOAD === "0") return null;
    const key = String(job.input.channelKey || "").toLowerCase().trim();
    const yt = key ? await youtubeServiceFor(key) : null;
    if (!yt || yt.connectedChannelCount < 1) return null;
    const { accessToken, channelName } = await yt.mintAccessToken();
    return {
      accessToken,
      channelName,
      title: job.title || "Video",
      description: job.description || "",
      tags: job.tags || ["tech", "coding", "tutorial"],
      privacy: "private",
    };
  });

  // ...and gets its cover image (AI picture + headline, 16:9) once the runner reports the upload
  setRunnerUploadedHook(async (job, videoId) => {
    const key = String(job.input.channelKey || "").toLowerCase().trim();
    const yt = key ? await youtubeServiceFor(key) : null;
    if (!yt) return;
    await yt.setCover(videoId, { title: job.title || "Video", description: "", tags: [] }, job.input.orientation === "vertical" ? "portrait" : "landscape", key);
  });

  const server = http.createServer(async (req, res) => {
    const url = req.url || "/";

    // ── Global CORS preflight handler ──────────────────────────────────────
    // Required so the dashboard works when opened as a local file:// URL.
    // Browsers send an OPTIONS preflight before cross-origin POST/fetch calls.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // ── Login ───────────────────────────────────────────────────────────────
    // Everything below needs the dashboard session cookie (or `Authorization: Bearer <password>`), except the login page
    // itself and the reel-injection endpoint, which checks its own x-inject-token.
    const authPath = url.split("?")[0];
    if (authPath === "/login") {
      const secure = isSecure(req);
      if (req.method === "POST") {
        const ip = clientIp(req);
        const raw = await new Promise<string>((resolve) => {
          let b = "";
          req.on("data", (d) => { if (b.length < 4096) b += d; });
          req.on("end", () => resolve(b));
        });
        const form = new URLSearchParams(raw);
        const next = safeNext(form.get("next"));
        if (loginBlocked(ip)) {
          res.writeHead(429, { "Content-Type": "text/html; charset=utf-8" });
          res.end(loginPage(next, "Too many wrong passwords. Try again in 15 minutes."));
          return;
        }
        if (!checkPassword(form.get("password") || "")) {
          recordLoginFailure(ip);
          pipelineLogger.warn(`Dashboard login failed from ${ip}`, "Auth");
          res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
          res.end(loginPage(next, "Wrong password."));
          return;
        }
        clearLoginFailures(ip);
        res.writeHead(302, { "Set-Cookie": sessionCookie(makeSessionToken(), secure), Location: next, "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const next = safeNext(new URL(url, "http://x").searchParams.get("next"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(loginPage(next));
      return;
    }
    if (authPath === "/logout") {
      res.writeHead(302, { "Set-Cookie": clearCookie(isSecure(req)), Location: "/login", "Cache-Control": "no-store" });
      res.end();
      return;
    }
    // The log endpoints (/logs, /logs/raw, /logs/stream ...) are deliberately open, so logs can be read with a plain curl.
    const openLogs = req.method === "GET" && (authPath === "/logs" || authPath.startsWith("/logs/"));
    // Temporary public links for Instagram's video_url upload (src/instagram/mediaLinks.ts). Answered BEFORE the login check on
    // purpose (Instagram's servers have no session) and ONLY for /ig-media/<43-char token>.mp4; every other path continues below.
    if (handleMediaRequest(req, res)) return;

    if (!openLogs && !isMachineRoute(req.method || "GET", authPath)) {
      const auth = authenticate(req);
      if (!auth.ok) {
        const wantsPage = req.method === "GET" && String(req.headers.accept || "").includes("text/html");
        if (wantsPage) {
          res.writeHead(302, { Location: `/login?next=${encodeURIComponent(url)}`, "Cache-Control": "no-store" });
          res.end();
        } else {
          res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ success: false, message: "Login required" }));
        }
        return;
      }
      if (auth.renew) res.setHeader("Set-Cookie", auth.renew);
    }

    // ── GET /oauth2callback ──────────────────────────────────────────────
    // Google OAuth redirect target. Served here (not only on the legacy
    // localhost:OAUTH_PORT listener) so the flow works on prod behind Caddy:
    // set YOUTUBE_REDIRECT_URI=https://<your-domain>/oauth2callback.
    if (req.method === "GET" && (url === "/oauth2callback" || url.startsWith("/oauth2callback?"))) {
      const parsedUrl = new URL(url, `http://localhost:${PORT}`);
      await renderYouTubeOAuthCallback(parsedUrl, res);
      return;
    }

    // ── GET /api/auth/youtube/start ───────────────────────────────────────
    if (
      req.method === "GET" &&
      (url === "/api/auth/youtube/start" || url.startsWith("/api/auth/youtube/start?"))
    ) {
      try {
        ensureYouTubeOAuthServer();
        const parsedUrl = new URL(url, "http://localhost:3002");
        const target = parsedUrl.searchParams.get("target") || "";
        const clientId = process.env.YOUTUBE_CLIENT_ID || "";
        const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || "";
        const redirectUri = OAUTH_REDIRECT_URI;

        if (!clientId || !clientSecret) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h3>❌ YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be configured in .env</h3>");
          return;
        }

        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        const authUrl = oauth2Client.generateAuthUrl({
          access_type: "offline",
          prompt: "consent",
          scope: [
            "https://www.googleapis.com/auth/youtube.upload",
            "https://www.googleapis.com/auth/youtube",
          ],
          state: JSON.stringify({ target }),
        });

        res.writeHead(302, { Location: authUrl });
        res.end();
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h3>❌ Error starting YouTube OAuth: ${escapeHtml(err.message)}</h3>`);
      }
      return;
    }

    // ── GET /api/auth/meta/start ─────────────────────────────────────────
    // Kicks off Facebook Login. On success the callback posts a long-lived
    // (~60-day) user token back to the dashboard, which then runs "Load Accounts".
    if (req.method === "GET" && (url === "/api/auth/meta/start" || url.startsWith("/api/auth/meta/start?"))) {
      const target = new URL(url, `http://localhost:${PORT}`).searchParams.get("target") || "";
      if (!META_APP_ID || !META_APP_SECRET) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h3>❌ META_APP_ID and META_APP_SECRET must be set in the environment.</h3>");
        return;
      }
      const authUrl =
        `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?` +
        new URLSearchParams({
          client_id: META_APP_ID,
          redirect_uri: META_REDIRECT_URI,
          state: JSON.stringify({ target }),
          scope: META_SCOPES,
          response_type: "code",
        }).toString();
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    // ── GET /meta/oauth2callback ─────────────────────────────────────────
    if (req.method === "GET" && (url === "/meta/oauth2callback" || url.startsWith("/meta/oauth2callback?"))) {
      const qp = new URL(url, `http://localhost:${PORT}`).searchParams;
      const code = qp.get("code");
      let stateObj: any = {};
      try { stateObj = JSON.parse(qp.get("state") || "{}"); } catch {}
      const fail = (msg: string) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9;padding:40px;text-align:center"><h3>❌ ${escapeHtml(msg)}</h3></body>`);
      };
      if (qp.get("error")) return void fail(`Facebook denied the request: ${qp.get("error_description") || qp.get("error")}`);
      if (!code) return void fail("No authorization code returned.");
      try {
        const tokenRes = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?` +
          new URLSearchParams({ client_id: META_APP_ID, client_secret: META_APP_SECRET, redirect_uri: META_REDIRECT_URI, code }).toString(),
        );
        const shortJson: any = await tokenRes.json();
        if (shortJson.error || !shortJson.access_token) return void fail(shortJson.error?.message || "Code exchange failed.");

        // Short-lived -> long-lived (~60 days)
        const llRes = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?` +
          new URLSearchParams({ grant_type: "fb_exchange_token", client_id: META_APP_ID, client_secret: META_APP_SECRET, fb_exchange_token: shortJson.access_token }).toString(),
        );
        const llJson: any = await llRes.json();
        const longToken = llJson.access_token || shortJson.access_token;

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Facebook Connected</title>
          <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
          .box{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:440px}h2{color:#3fb950;margin-top:0}</style></head>
          <body><div class="box"><h2>✅ Facebook Connected</h2><p style="font-size:13px;color:#8b949e" id="m">Loading your pages…</p></div>
          <script>
            var payload = { type:'META_AUTH_SUCCESS', token:${JSON.stringify(longToken)}, target:${JSON.stringify(stateObj.target || "")} };
            if (window.opener) { window.opener.postMessage(payload,'*'); setTimeout(function(){window.close()}, 1200); }
            else { document.getElementById('m').textContent = 'Copy this token into the dashboard: ' + ${JSON.stringify(longToken)}; }
          </script></body></html>`);
      } catch (err: any) {
        fail(`Token exchange failed: ${err?.message || err}`);
      }
      return;
    }

    // ── GET /api/channels/token-status ──────────────────────────────────
    // Per-channel Meta publish-token health, for the config UI badges.
    // Cached 5 min server-side so the polling UI can't hammer the Graph API.
    if (req.method === "GET" && (url === "/api/channels/token-status" || url.startsWith("/api/channels/token-status?"))) {
      try {
        const force = url.includes("force=1");
        const now = Date.now();
        if (!force && tokenStatusCache && now - tokenStatusCache.at < 5 * 60 * 1000) {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ success: true, cached: true, metaConfigured: !!(META_APP_ID && META_APP_SECRET), tokens: tokenStatusCache.tokens }));
          return;
        }
        const channels = await getAllStoredChannelConfigs();
        const out = await Promise.all(
          channels.map(async (c) => {
            const info = await inspectMetaToken(c.instagramAccessToken || c.facebookAccessToken || "");
            return {
              key: c.key,
              brandName: c.brandName,
              hasToken: !!(c.instagramAccessToken || c.facebookAccessToken),
              ...info,
              daysLeft: info.expiresAt && info.expiresAt > 0 ? Math.round((info.expiresAt * 1000 - Date.now()) / 86400000) : null,
            };
          }),
        );
        tokenStatusCache = { at: now, tokens: out };
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ success: true, cached: false, metaConfigured: !!(META_APP_ID && META_APP_SECRET), tokens: out }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: err?.message || String(err) }));
      }
      return;
    }

    // ── POST /api/meta/inspect-accounts ───────────────────────────────────
    if (
      req.method === "POST" &&
      (url === "/api/meta/inspect-accounts" || url.startsWith("/api/meta/inspect-accounts?"))
    ) {
      const sendJson = (code: number, payload: any) => {
        if (res.headersSent) return;
        res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(payload));
      };
      try {
        const body = await parseJsonBody(req);
        let token = (body.token || "").trim();

        if (!token) {
          token = process.env.INSTAGRAM_ACCESS_TOKEN || process.env.FACEBOOK_ACCESS_TOKEN || "";
        }
        if (!token) {
          // Best-effort DB lookup, time-boxed so a slow DB can't hang the request.
          const configs = await Promise.race([
            getAllStoredChannelConfigs(),
            new Promise<[]>((r) => setTimeout(() => r([]), 4000)),
          ]);
          token = configs.find((c) => c.instagramAccessToken || c.facebookAccessToken)?.instagramAccessToken
            || configs.find((c) => c.facebookAccessToken)?.facebookAccessToken || "";
        }

        if (!token) {
          sendJson(400, { success: false, message: "No Meta Access Token provided or found in environment." });
          return;
        }

        // Graph API can hang on a bad/expired token — abort after 15s so the
        // browser gets a JSON error instead of an empty (cut-off) response.
        const ac = new AbortController();
        const abortTimer = setTimeout(() => ac.abort(), 15000);
        let metaData: any;
        try {
          const metaRes = await fetch(
            `https://graph.facebook.com/v19.0/me/accounts?fields=name,id,access_token,instagram_business_account{id,username,name,profile_picture_url}&access_token=${encodeURIComponent(token)}`,
            { signal: ac.signal },
          );
          const raw = await metaRes.text();
          try {
            metaData = JSON.parse(raw);
          } catch {
            sendJson(502, { success: false, message: `Meta API returned a non-JSON response (HTTP ${metaRes.status}). Check the token.` });
            return;
          }
        } catch (fetchErr: any) {
          sendJson(504, { success: false, message: fetchErr?.name === "AbortError" ? "Meta Graph API timed out after 15s." : `Meta API request failed: ${fetchErr?.message || fetchErr}` });
          return;
        } finally {
          clearTimeout(abortTimer);
        }

        if (metaData.error) {
          sendJson(400, { success: false, message: metaData.error.message || "Meta API Error" });
          return;
        }

        const accounts = (metaData.data || []).map((page: any) => ({
          pageId: page.id,
          pageName: page.name,
          pageAccessToken: page.access_token,
          igUserId: page.instagram_business_account?.id || null,
          igUsername: page.instagram_business_account?.username || null,
          igName: page.instagram_business_account?.name || null,
          igAvatar: page.instagram_business_account?.profile_picture_url || null,
        }));

        sendJson(200, { success: true, accounts });
      } catch (err: any) {
        sendJson(500, { success: false, message: err?.message || String(err) });
      }
      return;
    }

    if (
      req.method === "GET" &&
      (url === "/api/channels" || url.startsWith("/api/channels?"))
    ) {
      try {
        const channels = (await getAllStoredChannelConfigs()).map(maskChannel);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        });
        res.end(JSON.stringify({ success: true, channels }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: err.message || "Failed to fetch channels" }));
      }
      return;
    }

    if (
      req.method === "POST" &&
      (url === "/api/channels/save" || url.startsWith("/api/channels/save?"))
    ) {
      try {
        const posted = await parseJsonBody(req);
        const postedKey = String(posted.key || "").toLowerCase().trim().replace(/[^a-z0-9_]/g, "_");
        const body = restoreMasked(posted, (await getAllStoredChannelConfigs()).find((c) => c.key === postedKey));
        if (!body.key || !body.brandName || !body.handle) {
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ success: false, message: "Missing required fields: key, brandName, handle" }));
          return;
        }

        const key = body.key.toLowerCase().trim().replace(/[^a-z0-9_]/g, "_");
        
        const instagramAccounts = Array.isArray(body.instagramAccounts) && body.instagramAccounts.length > 0
          ? body.instagramAccounts.map((a: any) => ({
              name: (a.name || `${body.brandName} Instagram`).trim(),
              igUserId: (a.igUserId || "").trim(),
              accessToken: (a.accessToken || "").trim(),
            })).filter((a: any) => a.igUserId && a.accessToken)
          : (body.instagramUserId && body.instagramAccessToken
              ? [{ name: `${body.brandName} Instagram`, igUserId: body.instagramUserId.trim(), accessToken: body.instagramAccessToken.trim() }]
              : []);

        const youtubeChannels = Array.isArray(body.youtubeChannels) && body.youtubeChannels.length > 0
          ? body.youtubeChannels.map((c: any) => ({
              name: (c.name || body.brandName).trim(),
              refreshToken: (c.refreshToken || "").trim(),
            })).filter((c: any) => c.refreshToken)
          : (body.youtubeRefreshToken
              ? [{ name: body.brandName.trim(), refreshToken: body.youtubeRefreshToken.trim() }]
              : []);

        const storedConfig: StoredChannelConfig = {
          key,
          brandName: body.brandName.trim(),
          handle: body.handle.trim(),
          niche: body.niche || "tech",
          isDefault: key === "codeorcap",
          isWatchOnly: key !== "codeorcap",
          instagramAccounts,
          youtubeChannels,
          instagramUserId: instagramAccounts[0]?.igUserId || body.instagramUserId || undefined,
          instagramAccessToken: instagramAccounts[0]?.accessToken || body.instagramAccessToken || undefined,
          instagramUsername: body.instagramUsername || undefined,
          instagramPassword: body.instagramPassword || undefined,
          instagramSessionId: body.instagramSessionId || undefined,
          youtubeRefreshToken: youtubeChannels[0]?.refreshToken || body.youtubeRefreshToken || undefined,
          youtubeClientId: body.youtubeClientId || undefined,
          youtubeClientSecret: body.youtubeClientSecret || undefined,
          facebookPageId: body.facebookPageId || undefined,
          facebookAccessToken: body.facebookAccessToken || undefined,
          watchChannels: Array.isArray(body.watchChannels)
            ? body.watchChannels
            : (body.watchChannels || "")
                .split(",")
                .map((s: string) => s.trim().replace(/^@/, "").toLowerCase())
                .filter(Boolean),
          searchMode: body.searchMode || "channels",
          dailyCount: Number(body.dailyCount) || 5,
          scheduleTime: body.scheduleTime || "09:00",
          gapHours: Number(body.gapHours) || 2.0,
          viralThreshold: Number(body.viralThreshold) || 50,
          outroVersion: body.outroVersion || "v2",
          videoMode: body.videoMode || "curator",
          subtitleStyle: body.subtitleStyle || "classic",
          ttsVoice: body.ttsVoice || "default",
          adminChatId: body.adminChatId ? Number(body.adminChatId) : undefined,
        };

        await saveChannelConfig(storedConfig);
        tokenStatusCache = null; // creds may have changed — force a fresh check

        // Update in-memory profile in config.profiles
        let existingProfile = config.profiles.find((p) => p.key === key);
        if (!existingProfile) {
          const newProfile: ChannelProfile = {
            key,
            brandName: storedConfig.brandName,
            handle: storedConfig.handle,
            theme: resolveTheme(storedConfig.niche, storedConfig.brandName),
            isDefault: Boolean(storedConfig.isDefault),
            isWatchOnly: Boolean(storedConfig.isWatchOnly),
            youtube: {
              clientId: storedConfig.youtubeClientId || process.env.YOUTUBE_CLIENT_ID || "",
              clientSecret: storedConfig.youtubeClientSecret || process.env.YOUTUBE_CLIENT_SECRET || "",
              redirectUri: OAUTH_REDIRECT_URI,
              channels: youtubeChannels.map((c: StoredYoutubeChannel) => ({ name: c.name, refreshToken: c.refreshToken })),
            },
            instagram: {
              accounts: instagramAccounts.map((a: StoredInstagramAccount) => ({ name: a.name, accessToken: a.accessToken, igUserId: a.igUserId })),
            },
            facebook: storedConfig.facebookPageId && storedConfig.facebookAccessToken
              ? { pageId: storedConfig.facebookPageId, accessToken: storedConfig.facebookAccessToken }
              : undefined,
            watch: {
              channels: storedConfig.watchChannels || [],
              dailyCount: storedConfig.dailyCount || 5,
              scheduleTime: storedConfig.scheduleTime || "09:00",
              gapHours: storedConfig.gapHours || 2.0,
              searchMode: storedConfig.searchMode || "channels",
              viralThreshold: storedConfig.viralThreshold || 50,
              outroVersion: storedConfig.outroVersion || "v2",
              adminChatId: storedConfig.adminChatId || (process.env.WATCH_ADMIN_CHAT_ID ? parseInt(process.env.WATCH_ADMIN_CHAT_ID, 10) : 0),
            },
          };
          config.profiles.push(newProfile);
        } else {
          existingProfile.brandName = storedConfig.brandName;
          existingProfile.handle = storedConfig.handle;
          existingProfile.theme = resolveTheme(storedConfig.niche, storedConfig.brandName);
          existingProfile.instagram.accounts = instagramAccounts.map((a: StoredInstagramAccount) => ({ name: a.name, accessToken: a.accessToken, igUserId: a.igUserId }));
          existingProfile.youtube.channels = youtubeChannels.map((c: StoredYoutubeChannel) => ({ name: c.name, refreshToken: c.refreshToken }));
          if (storedConfig.facebookPageId && storedConfig.facebookAccessToken) {
            existingProfile.facebook = {
              pageId: storedConfig.facebookPageId,
              accessToken: storedConfig.facebookAccessToken,
            };
          }
          if (existingProfile.watch) {
            existingProfile.watch.channels = storedConfig.watchChannels || [];
            existingProfile.watch.dailyCount = storedConfig.dailyCount || 5;
            existingProfile.watch.scheduleTime = storedConfig.scheduleTime || "09:00";
            existingProfile.watch.gapHours = storedConfig.gapHours || 2.0;
            existingProfile.watch.searchMode = storedConfig.searchMode || "channels";
            existingProfile.watch.viralThreshold = storedConfig.viralThreshold || 50;
            existingProfile.watch.outroVersion = storedConfig.outroVersion || "v2";
          }
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ success: true, message: `Channel [${storedConfig.brandName}] configured and active.`, channel: maskChannel(storedConfig) }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: err.message || "Failed to save channel" }));
      }
      return;
    }

    if (
      req.method === "POST" &&
      (url === "/api/channels/delete" || url.startsWith("/api/channels/delete?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const key = (body.key || "").toLowerCase().trim();
        if (key === "codeorcap") {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: false, message: "Cannot delete default profile (CodeOrCap)." }));
          return;
        }

        await deleteChannelConfig(key);
        const idx = config.profiles.findIndex((p) => p.key === key);
        if (idx !== -1) config.profiles.splice(idx, 1);

        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ success: true, message: `Channel [${key}] removed.` }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: err.message || "Failed to delete channel" }));
      }
      return;
    }

    // ── POST /api/generate/faceless ───────────────────────────────────────
    if (
      req.method === "POST" &&
      (url === "/api/generate/faceless" || url.startsWith("/api/generate/faceless?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const channelKey = (body.channelKey || "codeorcap").toLowerCase().trim();
        const storedConfigs = await getAllStoredChannelConfigs();
        const storedConfig = storedConfigs.find((c) => c.key === channelKey);

        const brandName = storedConfig?.brandName || "CodeOrCap";
        const handle = storedConfig?.handle || "@codeorcap";
        const niche = storedConfig?.niche || "tech";
        const subtitleStyle = body.subtitleStyle || storedConfig?.subtitleStyle || "classic";
        const voice = body.voice || storedConfig?.ttsVoice;

        pipelineLogger.info(`Starting faceless multi-scene video generation for [${brandName}] (Topic: "${body.topic || body.script || niche}")`, "LogServer");

        const generator = new MultiSceneGenerator();
        const result = await generator.generateFacelessShort({
          topic: body.topic,
          script: body.script,
          channelKey,
          brandName,
          handle,
          niche,
          subtitleStyle,
          voice,
          aspectRatio: body.aspectRatio,
          durationTarget: body.durationTarget || "short",
        });

        let publishedUrls: any[] = [];
        if (body.autoPublish && result.success && result.videoPath) {
          const ytChannels = storedConfig?.youtubeChannels || [];
          if (ytChannels.length > 0 || storedConfig?.youtubeRefreshToken) {
            try {
              pipelineLogger.info(`[AutoPublish] Automatically uploading generated video to YouTube for [${brandName}]…`, "LogServer");
              const ytService = new YouTubeService({
                clientId: storedConfig?.youtubeClientId || process.env.YOUTUBE_CLIENT_ID || "",
                clientSecret: storedConfig?.youtubeClientSecret || process.env.YOUTUBE_CLIENT_SECRET || "",
                redirectUri: storedConfig?.youtubeRedirectUri || OAUTH_REDIRECT_URI,
                channels: ytChannels.length > 0 ? ytChannels : [{ name: storedConfig?.brandName || channelKey, refreshToken: storedConfig?.youtubeRefreshToken || "" }],
              });
              const ytRes = await ytService.uploadToAllChannels(result.videoPath, {
                title: result.metadata.title,
                description: result.metadata.description,
                tags: result.metadata.tags,
              }, { brandKey: channelKey });
              publishedUrls.push(...ytRes);
            } catch (pubErr: any) {
              pipelineLogger.warn(`Auto-publish to YouTube failed: ${pubErr.message}`, "LogServer");
            }
          }
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ...result, publishedUrls }));
      } catch (err: any) {
        pipelineLogger.error("Faceless video generation failed", err, "LogServer");
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ success: false, message: err.message || "Failed to generate faceless video" }));
      }
      return;
    }

    // ── POST /api/publish/youtube-video ───────────────────────────────────
    if (
      req.method === "POST" &&
      (url === "/api/publish/youtube-video" || url.startsWith("/api/publish/youtube-video?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const channelKey = (body.channelKey || "codeorcap").toLowerCase().trim();
        const storedConfigs = await getAllStoredChannelConfigs();
        const storedConfig = storedConfigs.find((c) => c.key === channelKey);

        const videoPath = body.videoPath;
        if (!videoPath || !fs.existsSync(videoPath)) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: false, message: `Video file not found: ${videoPath}` }));
          return;
        }

        const ytChannels = storedConfig?.youtubeChannels || [];
        if (ytChannels.length === 0 && !storedConfig?.youtubeRefreshToken) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: false, message: `No YouTube channels connected for ${channelKey}` }));
          return;
        }

        const ytService = new YouTubeService({
          clientId: storedConfig?.youtubeClientId || process.env.YOUTUBE_CLIENT_ID || "",
          clientSecret: storedConfig?.youtubeClientSecret || process.env.YOUTUBE_CLIENT_SECRET || "",
          redirectUri: storedConfig?.youtubeRedirectUri || OAUTH_REDIRECT_URI,
          channels: ytChannels.length > 0 ? ytChannels : [{ name: storedConfig?.brandName || channelKey, refreshToken: storedConfig?.youtubeRefreshToken || "" }],
        });

        pipelineLogger.info(`Publishing video ${videoPath} to YouTube for [${storedConfig?.brandName || channelKey}]`, "LogServer");

        const uploadResults = await ytService.uploadToAllChannels(videoPath, {
          title: body.title || `${storedConfig?.brandName || 'CodeOrCap'} Video`,
          description: body.description || "",
          tags: Array.isArray(body.tags) ? body.tags : ["tech", "coding", "tutorial"],
        }, { brandKey: channelKey });

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ success: true, results: uploadResults }));
      } catch (err: any) {
        pipelineLogger.error("YouTube video publish failed", err, "LogServer");
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ success: false, message: err.message || "Failed to publish video to YouTube" }));
      }
      return;
    }

    // ── Daily long video: make today's video for a channel right now (dashboard button) ──────────────────
    if (req.method === "POST" && url.split("?")[0] === "/api/autolong/enqueue") {
      const send = (code: number, data: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(data));
      };
      try {
        const body = await parseJsonBody(req);
        const channel = String(body.channel || "").toLowerCase().trim();
        if (!channel) return send(400, { success: false, message: "channel is required" });
        // dev only: make a short test video (60-900 s) instead of the 10-minute one
        if (process.env.BOT_ENV === "dev" && Number(body.targetSec) > 0) process.env.LONG_TARGET_SEC = String(Math.round(Number(body.targetSec)));
        const r = await enqueueNow(longQueue(), candidateStore(), channel, {
          publishNow: body.publishNow === true,
          force: body.force === true,
          shortcode: typeof body.shortcode === "string" ? body.shortcode : undefined,
        });
        return send(r.ok ? 200 : 409, { success: r.ok, ...r });
      } catch (err: any) {
        return send(500, { success: false, message: err?.message || "enqueue failed" });
      }
    }

    // ── Daily long video system: status for the dashboard and for a quick curl ───────────────────────────
    if (req.method === "GET" && url.split("?")[0] === "/api/autolong/status") {
      try {
        const snap = autoLongSnapshot(candidateStore(), longQueue());
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ success: true, ...snap }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: err?.message || "status failed" }));
      }
      return;
    }

    // ── Long video studio (my-video stickman renderer) ─────────────────────
    if (url.startsWith("/api/longvideo/")) {
      const json = (code: number, data: unknown) => {
        res.writeHead(code, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(data));
      };
      const toSec = (v: unknown) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
      };
      const route = url.split("?")[0];
      try {
        if (req.method === "POST" && route === "/api/longvideo/estimate") {
          const body = await parseJsonBody(req);
          const script = String(body.script || "").trim();
          if (!script) return json(400, { success: false, message: "Script is empty" });
          const resolution = Number(body.resolution) === 1080 ? 1080 : 720;
          return json(200, { success: true, estimate: estimateStickman(script, toSec(body.targetSec), resolution) });
        }
        // Plan import: prompts to run in any external chat model, then a no-AI check of the JSON it returns
        if (req.method === "POST" && route === "/api/longvideo/plan/prompt") {
          const body = await parseJsonBody(req);
          const script = String(body.script || "").trim();
          if (!script) return json(400, { success: false, message: "Script is empty" });
          return json(200, { success: true, ...buildImportPrompts(script, Number(body.chunkSize) || 40) });
        }
        // Plan-only: the prompt to give ChatGPT (transcript goes underneath) and a no-AI check of what it returns
        if (req.method === "POST" && route === "/api/longvideo/plan/prompt-only") {
          const body = await parseJsonBody(req);
          return json(200, { success: true, prompt: buildPlanOnlyPrompt(Number(body.minutes) || 20, String(body.language || "Hinglish").slice(0, 40)) });
        }
        if (req.method === "POST" && route === "/api/longvideo/plan/check") {
          const body = await parseJsonBody(req);
          if (body.planOnly === true) {
            if (body.plan == null || body.plan === "") return json(400, { success: false, message: "Paste the plan JSON first" });
            const c = checkPlanOnly(body.plan);
            const resolution = Number(body.resolution) === 1080 ? 1080 : 720;
            return json(200, {
              success: true, ok: c.errors.length === 0 && c.scenes.length > 0, planOnly: true, scenes: c.scenes.length, words: c.words,
              title: c.meta?.title || null, errors: c.errors.slice(0, 20), moreErrors: Math.max(0, c.errors.length - 20), warnings: c.warnings.slice(0, 15),
              estimate: c.script ? estimateStickman(c.script, toSec(body.targetSec), resolution, false, true) : null,
            });
          }
          const script = String(body.script || "").trim();
          if (!script) return json(400, { success: false, message: "Script is empty" });
          if (body.plan == null || body.plan === "") return json(400, { success: false, message: "Paste the plan JSON first" });
          const c = checkImportedPlan(script, body.plan);
          return json(200, {
            success: true, ok: c.errors.length === 0, beatCount: c.beatCount, matched: c.byIndex.size,
            missing: c.missing, errors: c.errors.slice(0, 20), moreErrors: Math.max(0, c.errors.length - 20), warnings: c.warnings.slice(0, 15),
          });
        }
        if (req.method === "POST" && route === "/api/longvideo/cancel") {
          const body = await parseJsonBody(req);
          const cancelled = await cancelStickmanJob(String(body.id || ""));
          if (!cancelled) return json(404, { success: false, message: "Job not found" });
          return json(200, { success: true, job: getStickmanJob(cancelled.id) });
        }
        if (req.method === "POST" && route === "/api/longvideo/restart") {
          const body = await parseJsonBody(req);
          try {
            const restarted = restartStickmanJob(String(body.id || ""));
            return json(200, { success: true, job: getStickmanJob(restarted.id) });
          } catch (e: any) {
            return json(400, { success: false, message: e.message || "Restart failed" });
          }
        }
        if (req.method === "POST" && route === "/api/longvideo/continue") {
          const body = await parseJsonBody(req);
          try {
            const continued = continueStickmanJob(String(body.id || ""));
            return json(200, { success: true, job: getStickmanJob(continued.id) });
          } catch (e: any) {
            return json(400, { success: false, message: e.message || "Continue failed" });
          }
        }
        if (req.method === "POST" && route === "/api/longvideo/start") {
          const body = await parseJsonBody(req);
          const planOnly = body.planOnly === true;
          const script = String(body.script || "").trim();
          if (!script && !planOnly) return json(400, { success: false, message: "Script is empty" });
          try {
            resolveMyVideoDir();
          } catch (e: any) {
            return json(503, { success: false, message: "Video renderer (my-video) is not installed on this server." });
          }
          const orientation = body.orientation === "vertical" ? "vertical" : "horizontal";
          const job = startStickmanJob({
            script,
            planOnly,
            plan: body.plan == null || body.plan === "" ? undefined : body.plan,
            repairMissing: body.repairMissing === true,
            title: body.title ? String(body.title) : undefined,
            targetSec: toSec(body.targetSec),
            orientation,
            resolution: Number(body.resolution) === 1080 ? 1080 : 720,
            // an edge-tts voice name like en-IN-PrabhatNeural; anything else is ignored (default Hindi voice)
            // ("voicebox" / "voicebox-en" = the cloned voice made on GitHub Actions)
            voice: /^([a-z]{2}-[A-Z]{2}-[A-Za-z]{3,20}Neural|voicebox(-en)?)$/.test(String(body.voice || "")) ? String(body.voice) : undefined,
            channelKey: body.channelKey ? String(body.channelKey) : undefined,
          });
          return json(200, { success: true, job: getStickmanJob(job.id) });
        }
        if (req.method === "POST" && route === "/api/longvideo/progress") {
          // Called by the GitHub runner every few seconds with the live frame count.
          const body = await parseJsonBody(req);
          const ok = recordCloudProgress(String(body.slug || ""), String(body.token || ""), Number(body.done), Number(body.total), Number(body.chunk) || 0);
          return json(ok ? 200 : 403, { success: ok });
        }
        if (req.method === "POST" && route === "/api/longvideo/yt-token") {
          // Called by the GitHub runner after the render; authenticated by the job's progress token.
          const body = await parseJsonBody(req);
          const out = await handleRunnerPublish(String(body.slug || ""), String(body.token || ""), body);
          return json(out.status, out.body);
        }
        if (req.method === "POST" && route === "/api/longvideo/publish") {
          const body = await parseJsonBody(req);
          const job = getStickmanJob(String(body.jobId || ""));
          if (!job) return json(404, { success: false, message: "Job not found" });
          const channelKey = String(body.channelKey || job.input.channelKey || "codeorcap").toLowerCase().trim();
          if (job.remote && !job.videoPath) {
            // the runner already uploaded it (private): publishing means making it public
            const yt = await youtubeServiceFor(String(job.remote.channelKey || channelKey).toLowerCase().trim());
            if (!yt) return json(400, { success: false, message: `No YouTube channel connected for ${channelKey}` });
            try {
              await yt.setPrivacy(job.remote.videoId, "public");
            } catch (e: any) {
              return json(400, { success: false, message: `Could not make the video public: ${e?.message || e}` });
            }
            const state = markRemotePublic(job.id, { channelName: job.remote.channelName || channelKey, url: job.remote.url });
            return json(200, { success: true, publish: state });
          }
          const storedConfig = (await getAllStoredChannelConfigs()).find((c) => c.key === channelKey);
          const ytChannels = storedConfig?.youtubeChannels || [];
          if (ytChannels.length === 0 && !storedConfig?.youtubeRefreshToken) {
            return json(400, { success: false, message: `No YouTube channels connected for ${channelKey}` });
          }
          const ytService = new YouTubeService({
            clientId: storedConfig?.youtubeClientId || process.env.YOUTUBE_CLIENT_ID || "",
            clientSecret: storedConfig?.youtubeClientSecret || process.env.YOUTUBE_CLIENT_SECRET || "",
            redirectUri: storedConfig?.youtubeRedirectUri || OAUTH_REDIRECT_URI,
            channels: ytChannels.length > 0 ? ytChannels : [{ name: storedConfig?.brandName || channelKey, refreshToken: storedConfig?.youtubeRefreshToken || "" }],
          });
          try {
            const state = startPublish(job.id, channelKey, async (j, onProgress) => {
              const results = await ytService.uploadToAllChannels(
                j.videoPath!,
                { title: j.title || "Video", description: j.description || "", tags: j.tags || ["tech", "coding", "tutorial"] },
                { onProgress, isLong: j.input.orientation !== "vertical", brandKey: channelKey },
              );
              if (!results.length && ytService.lastErrors.length) throw new Error(ytService.lastErrors.join(" | "));
              return results.map((r) => ({ channelName: r.channelName, url: r.url }));
            });
            return json(200, { success: true, publish: state });
          } catch (e: any) {
            return json(400, { success: false, message: e?.message || "Could not start publishing" });
          }
        }
        if (req.method === "POST" && route === "/api/longvideo/publish/reset") {
          const body = await parseJsonBody(req);
          resetPublish(String(body.jobId || ""));
          return json(200, { success: true });
        }
        if (req.method === "GET" && route.startsWith("/api/longvideo/bundle/")) {
          const slug = route.replace("/api/longvideo/bundle/", "").trim();
          let myDir = "";
          try {
            myDir = resolveMyVideoDir();
          } catch (e) {
            return json(503, { success: false, message: "my-video not installed" });
          }
          const contentDir = path.join(myDir, "public", "content", slug);
          if (!fs.existsSync(contentDir) || !fs.existsSync(path.join(contentDir, "video.json"))) {
            return json(404, { success: false, message: `Project bundle not found for slug: ${slug}` });
          }
          res.writeHead(200, {
            "Content-Type": "application/gzip",
            "Content-Disposition": `attachment; filename="${slug}.tar.gz"`,
          });
          const tarProc = spawn("tar", ["-czf", "-", "-C", contentDir, "."]);
          tarProc.stdout.pipe(res);
          return;
        }

        if (req.method === "GET" && route === "/api/longvideo/job") {
          const id = new URL(url, "http://localhost").searchParams.get("id") || "";
          const job = getStickmanJobForPoll(id);
          return job ? json(200, { success: true, job }) : json(404, { success: false, message: "Job not found" });
        }
        if (req.method === "GET" && route === "/api/longvideo/jobs") {
          const now = Date.now();
          if (!lvJobsCache || now - lvJobsCache.at > 2000) lvJobsCache = { at: now, body: JSON.stringify({ success: true, jobs: listStickmanJobs() }) };
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
          return res.end(lvJobsCache.body);
        }
        return json(404, { success: false, message: "Unknown long video endpoint" });
      } catch (err: any) {
        if (err instanceof PlanImportError) {
          return json(400, { success: false, message: err.message, errors: err.details, missing: err.missing });
        }
        const busy = /already being created/.test(err?.message || "");
        return json(busy ? 409 : 500, { success: false, message: err?.message || "Long video request failed" });
      }
    }

    if (req.method === "GET" && (url.startsWith("/api/short/bundle/") || url.startsWith("/api/short/bundle?"))) {
      const route = url.split("?")[0];
      const jobId = route.replace("/api/short/bundle/", "").trim();
      const jobDir = path.join(config.paths.tempDir, jobId);
      if (!fs.existsSync(jobDir)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: `Short bundle not found for job: ${jobId}` }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${jobId}.tar.gz"`,
        "Access-Control-Allow-Origin": "*",
      });
      const tarProc = spawn("tar", [
        "-czf", "-",
        "--exclude=video_raw.mp4",
        "--exclude=video_stickered.mp4",
        "--exclude=video_raw_captioned.mp4",
        "--exclude=video_final.mp4",
        "--exclude=pristine_video.mp4",
        "-C", jobDir, "."
      ]);
      tarProc.stdout.pipe(res);
      return;
    }

    // ── /api/pipeline/live — where each job is, elapsed and estimated time (polled by the dashboard; needs no log stream) ──
    if (req.method === "GET" && (url === "/api/pipeline/live" || url.startsWith("/api/pipeline/live?"))) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ now: Date.now(), jobs: jobProgress().snapshot().slice(0, 6) }));
      return;
    }

    if (url === "/api/dashboard" || url.startsWith("/api/dashboard?")) {
      try {
        const data = await getDashboardData();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to generate dashboard data" }));
      }
      return;
    }

    if (
      req.method === "POST" &&
      (url === "/api/inject-link" || url.startsWith("/api/inject-link?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (
          body.profile ||
          pUrl.searchParams.get("profile") ||
          "codeorcap"
        ).toLowerCase();
        const reelUrl = body.url || pUrl.searchParams.get("url") || "";

        if (!reelUrl) {
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(
            JSON.stringify({
              success: false,
              message: "Missing URL parameter",
            }),
          );
          return;
        }

        const shortcode =
          reelUrl.split("/reel/")[1]?.split("/")[0] ||
          reelUrl.split("/p/")[1]?.split("/")[0] ||
          `injected_${Date.now()}`;

        const watcher = activeWatchers.get(pKey);
        let jobId = "";
        if (watcher) {
          jobId = await watcher.injectAndRunReel(reelUrl, typeof body.format === "string" ? body.format : undefined);
        } else {
          const newItem = {
            shortcode,
            url: reelUrl,
            channel: "manual_inject",
            scheduledAt: new Date().toISOString(),
            fired: false,
            addedAt: new Date().toISOString(),
          };
          const pool = await getPool();
          await pool.query(
            `UPDATE watch_state SET queue = queue || $1::jsonb WHERE profile_key = $2`,
            [JSON.stringify([newItem]), pKey],
          );
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            success: true,
            jobId,
            message: `⚡ Reel #${shortcode} injected and started in [${pKey.toUpperCase()}]!`,
          }),
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            message: "Error injecting link into database queue",
          }),
        );
      }
      return;
    }

    if (
      req.method === "GET" &&
      (url === "/api/pending-reviews" || url.startsWith("/api/pending-reviews?"))
    ) {
      try {
        const reviews: any[] = [];
        for (const uploader of DirectUploader.instances) {
          if (!uploader.pendingSettingsReviews) continue;
          for (const [id, review] of uploader.pendingSettingsReviews.entries()) {
            const elapsed = Date.now() - review.startTime;
            const remaining = Math.max(0, 60000 - elapsed);
            reviews.push({
              id,
              profile: uploader.profile.key,
              shortcode: review.context.shortcode,
              channel: review.context.channel,
              mood: review.context.metadata?.mood || "technical",
              settings: review.context.reviewSettings || {
                voiceover: true,
                originalAudio: false,
                captions: true,
                cropTopPct: 0,
                cropBottomPct: 15,
                sticker: true,
              },
              remainingSeconds: Math.max(0, Math.round(remaining / 1000)),
              originalCaption: review.context.captionMetadata?.description || "",
            });
          }
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            success: true,
            reviews,
          }),
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            message: "Error fetching pending reviews",
          }),
        );
      }
      return;
    }

    if (
      req.method === "POST" &&
      (url === "/api/action-review" || url.startsWith("/api/action-review?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const id = body.id;
        const code = body.code;

        if (!id || !code) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: false,
              message: "Missing id or code parameter",
            }),
          );
          return;
        }

        let handled = false;
        for (const uploader of DirectUploader.instances) {
          if (uploader.pendingSettingsReviews && uploader.pendingSettingsReviews.has(id)) {
            uploader.onSettingsAction(code, id);
            handled = true;
            break;
          }
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            success: handled,
            message: handled
              ? `Review action '${code}' executed successfully.`
              : "Review not found or already processed.",
          }),
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            message: "Error executing review action",
          }),
        );
      }
      return;
    }

    // ── POST /api/publish-preview ──────────────────────────────────────────
    if (
      req.method === "POST" &&
      (url === "/api/publish-preview" || url.startsWith("/api/publish-preview?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://localhost`);
        const jobId = body.jobId || pUrl.searchParams.get("jobId") || "";

        let handled = false;
        for (const uploader of DirectUploader.instances) {
          if (jobId && uploader.pending.has(jobId)) {
            uploader.onPublish(jobId);
            handled = true;
            break;
          } else if (!jobId && uploader.pending.size > 0) {
            // Pick most recent pending
            const firstId = Array.from(uploader.pending.keys()).pop();
            if (firstId) {
              uploader.onPublish(firstId);
              handled = true;
              break;
            }
          }
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            success: handled,
            message: handled
              ? "🚀 Video approved! Uploading to connected platforms..."
              : "No pending video found to publish.",
          }),
        );
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
      return;
    }

    // ── POST /api/discard-preview ──────────────────────────────────────────
    if (
      req.method === "POST" &&
      (url === "/api/discard-preview" || url.startsWith("/api/discard-preview?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://localhost`);
        const jobId = body.jobId || pUrl.searchParams.get("jobId") || "";

        let handled = false;
        for (const uploader of DirectUploader.instances) {
          if (jobId && uploader.pending.has(jobId)) {
            uploader.onCancel(jobId);
            handled = true;
            break;
          } else if (!jobId && uploader.pending.size > 0) {
            const firstId = Array.from(uploader.pending.keys()).pop();
            if (firstId) {
              uploader.onCancel(firstId);
              handled = true;
              break;
            }
          }
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            success: handled,
            message: handled ? "🗑 Video discarded." : "No pending video found to discard.",
          }),
        );
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
      return;
    }

    if (
      req.method === "POST" &&
      (url === "/api/remove-queue" || url.startsWith("/api/remove-queue?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (
          body.profile ||
          pUrl.searchParams.get("profile") ||
          "codeorcap"
        ).toLowerCase();
        const shortcode =
          body.shortcode || pUrl.searchParams.get("shortcode") || "";

        const pool = await getPool();
        const wRes = await pool.query(
          `SELECT queue FROM watch_state WHERE profile_key = $1`,
          [pKey],
        );
        if (wRes.rows.length > 0) {
          const currentQueue = wRes.rows[0].queue || [];
          const updatedQueue = currentQueue.filter((q: any) => {
            const sc =
              q.shortcode ||
              q.url?.split("/reel/")[1]?.replace(/\//g, "") ||
              "";
            if (
              sc === shortcode ||
              sc.startsWith("failed-fetch-") ||
              sc.startsWith("no-unseen-")
            )
              return false;
            return true;
          });
          await pool.query(
            `UPDATE watch_state SET queue = $1::jsonb WHERE profile_key = $2`,
            [JSON.stringify(updatedQueue), pKey],
          );
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            success: true,
            message: `🧹 Item #${shortcode} removed from queue.`,
          }),
        );
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            message: "Error removing item from queue",
          }),
        );
      }
      return;
    }

    if (
      req.method === "POST" &&
      (url === "/api/retry-failed" || url.startsWith("/api/retry-failed?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (
          body.profile ||
          pUrl.searchParams.get("profile") ||
          "codeorcap"
        ).toLowerCase();
        const shortcode =
          body.shortcode || pUrl.searchParams.get("shortcode") || "";

        const pool = await getPool();
        await pool.query(
          `UPDATE reel_history SET failed = false, failed_reason = null WHERE shortcode = $1 AND profile_key = $2`,
          [shortcode, pKey],
        );

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            success: true,
            message: `↺ Reel #${shortcode} reset for retry.`,
          }),
        );
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            message: "Error retrying failed reel",
          }),
        );
      }
      return;
    }

    if (
      req.method === "POST" &&
      (url === "/api/update-config" || url.startsWith("/api/update-config?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (
          body.profile ||
          pUrl.searchParams.get("profile") ||
          "codeorcap"
        ).toLowerCase();
        const dailyLimit = parseInt(
          body.dailyLimit || pUrl.searchParams.get("dailyLimit") || "6",
          10,
        );
        const searchMode = body.searchMode || pUrl.searchParams.get("searchMode") || "";
        let nicheHashtags: string[] | undefined = undefined;
        if (body.nicheHashtags !== undefined) {
          nicheHashtags = Array.isArray(body.nicheHashtags)
            ? body.nicheHashtags
            : String(body.nicheHashtags).split(",").map(t => t.trim().replace(/^#/, "")).filter(Boolean);
        } else {
          const hashtagsRaw = pUrl.searchParams.get("nicheHashtags") || "";
          if (hashtagsRaw) {
            nicheHashtags = hashtagsRaw.split(",").map(t => t.trim().replace(/^#/, "")).filter(Boolean);
          }
        }

        let watchedChannels: string[] | undefined = undefined;
        if (body.watchedChannels !== undefined) {
          watchedChannels = Array.isArray(body.watchedChannels)
            ? body.watchedChannels
            : String(body.watchedChannels).split(",").map(t => t.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
        } else {
          const watchedRaw = pUrl.searchParams.get("watchedChannels") || "";
          if (watchedRaw) {
            watchedChannels = watchedRaw.split(",").map(t => t.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
          }
        }

        let excludeChannels: string[] | undefined = undefined;
        if (body.excludeChannels !== undefined) {
          excludeChannels = Array.isArray(body.excludeChannels)
            ? body.excludeChannels
            : String(body.excludeChannels).split(",").map(t => t.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
        } else {
          const excludeRaw = pUrl.searchParams.get("excludeChannels") || "";
          if (excludeRaw) {
            excludeChannels = excludeRaw.split(",").map(t => t.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
          }
        }

        const outroVersion = body.outroVersion || pUrl.searchParams.get("outroVersion") || "";

        const profile = config.profiles.find(
          (p) => (p.key || p.brandName).toLowerCase() === pKey,
        );
        if (profile && profile.watch) {
          profile.watch.dailyCount = dailyLimit;
          if (searchMode && ["channels", "hashtags", "both"].includes(searchMode)) {
            profile.watch.searchMode = searchMode as any;
          }
          if (nicheHashtags !== undefined) {
            profile.watch.nicheHashtags = nicheHashtags;
          }
          if (watchedChannels !== undefined) {
            profile.watch.channels = watchedChannels;
          }
          if (excludeChannels !== undefined) {
            profile.watch.excludeChannels = excludeChannels;
          }
          if (outroVersion && ["v1", "v2"].includes(outroVersion)) {
            profile.watch.outroVersion = outroVersion as "v1" | "v2";
          }
          pipelineLogger.info(
            `[UpdateConfig] Setting watch config for profile [${pKey}] to memory: ${JSON.stringify(profile.watch)}`,
            "ControlCenter",
          );

          const pool = await getPool();
          await pool.query(
            `INSERT INTO watch_state (profile_key, watch_config)
             VALUES ($1, $2::jsonb)
             ON CONFLICT (profile_key) DO UPDATE
               SET watch_config = EXCLUDED.watch_config`,
            [pKey, JSON.stringify(profile.watch)],
          );
          pipelineLogger.info(
            `[UpdateConfig] Saved watch config for profile [${pKey}] to database successfully.`,
            "ControlCenter",
          );
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            success: true,
            message: `⚙️ Config updated for profile [${pKey.toUpperCase()}]: ${dailyLimit} reels/day.`,
          }),
        );
      } catch (err) {
        pipelineLogger.error("Failed to update profile configuration", err, "ControlCenter");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            message: "Error updating profile configuration",
          }),
        );
      }
      return;
    }

    if (
      req.method === "GET" &&
      (url === "/api/channel-credentials" || url.startsWith("/api/channel-credentials?"))
    ) {
      try {
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (pUrl.searchParams.get("profile") || "codeorcap").toLowerCase();
        const creds = await getChannelCredentials(pKey);
        const maskSecret = (v?: string) => v ? v.slice(0, 4) + "••••••••" : "";
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({
          success: true,
          profileKey: pKey,
          hasCredentials: !!creds,
          instagramSessionId: creds?.instagramSessionId ? maskSecret(creds.instagramSessionId) : "",
          instagramUsername: creds?.instagramUsername || "",
          instagramPassword: creds?.instagramPassword ? maskSecret(creds.instagramPassword) : "",
          instagramEmail: creds?.instagramEmail || "",
          instagramTotpSecret: creds?.instagramTotpSecret ? maskSecret(creds.instagramTotpSecret) : "",
          instagramProxy: creds?.instagramProxy ? maskSecret(creds.instagramProxy) : "",
          hasSettingsBlob: !!creds?.instagramSettingsJson,
          sessionExpired: !!creds?.sessionDeadAt,
          sessionDeadAt: creds?.sessionDeadAt || null,
          updatedAt: creds?.updatedAt || null,
        }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Error fetching credentials" }));
      }
      return;
    }

    if (
      req.method === "POST" &&
      (url === "/api/channel-credentials" || url.startsWith("/api/channel-credentials?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const pKey = (body.profile || "codeorcap").toLowerCase();
        // Patch only the fields actually supplied — never wipe the persisted
        // settings blob / password just because this form didn't include them.
        const patch: Parameters<typeof patchChannelCredentials>[1] = {};
        if (body.instagramSessionId) patch.instagramSessionId = body.instagramSessionId;
        if (body.instagramUsername) patch.instagramUsername = body.instagramUsername;
        if (body.instagramPassword) patch.instagramPassword = body.instagramPassword;
        if (body.instagramEmail) patch.instagramEmail = body.instagramEmail;
        if (body.instagramTotpSecret) patch.instagramTotpSecret = body.instagramTotpSecret;
        if (body.instagramProxy) patch.instagramProxy = body.instagramProxy;
        // A freshly pasted session cookie invalidates any stale persisted device
        // blob and clears the "expired" flag until Instagram rejects it again.
        if (body.instagramSessionId) {
          patch.instagramSettingsJson = "";
          patch.sessionDeadAt = null;
        }
        await patchChannelCredentials(pKey, patch);
        // Profiles fall back to each other's sessions, so let every watcher retry scrapers.
        if (body.instagramSessionId) for (const w of activeWatchers.values()) w.resetScraperCooldown();
        pipelineLogger.info(`Credentials saved for profile [${pKey.toUpperCase()}]`, "ControlCenter");
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ success: true, message: `Credentials saved for [${pKey.toUpperCase()}]` }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Error saving credentials" }));
      }
      return;
    }

    if (
      req.method === "POST" &&
      (url === "/api/auto-session" || url.startsWith("/api/auto-session?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const pKey = (body.profile || "codeorcap").toLowerCase();
        const creds = await getChannelCredentials(pKey);
        if (!creds?.instagramUsername || !creds?.instagramPassword) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: false, message: "Username and password must be saved first" }));
          return;
        }
        const python3 = config.binaries.python3;
        const script = path.resolve(__dirname, "../../scripts/get_session_id.py");
        const env = {
          ...process.env,
          INSTAGRAM_USERNAME: creds.instagramUsername,
          INSTAGRAM_PASSWORD: creds.instagramPassword,
          INSTAGRAM_TOTP_SECRET: creds.instagramTotpSecret || process.env.INSTAGRAM_TOTP_SECRET || "",
          INSTAGRAM_PROXY: creds.instagramProxy || process.env.INSTAGRAM_PROXY || "",
        };
        pipelineLogger.info(`[${pKey.toUpperCase()}] Auto-login started to retrieve session ID`, "ControlCenter");
        execFile(python3, [script], { timeout: 60000, env }, async (err, stdout, stderr) => {
          const sessionId = stdout.trim();
          if (err || !sessionId) {
            const msg = stderr?.trim().split("\n")[0] || err?.message || "Login failed";
            pipelineLogger.warn(`[${pKey.toUpperCase()}] Auto-login failed: ${msg}`, "ControlCenter");
            res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ success: false, message: msg }));
            return;
          }
          await patchChannelCredentials(pKey, { instagramSessionId: sessionId, instagramSettingsJson: "", sessionDeadAt: null });
          pipelineLogger.info(`[${pKey.toUpperCase()}] Session ID auto-retrieved and saved`, "ControlCenter");
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: true, message: `Session ID retrieved and saved for [${pKey.toUpperCase()}]`, sessionIdPreview: sessionId.slice(0, 6) + "••••••••" }));
        });
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Auto-session error" }));
      }
      return;
    }

    if (
      req.method === "POST" &&
      (url === "/api/inject-reels" || url.startsWith("/api/inject-reels?"))
    ) {
      const expected = process.env.INJECT_REELS_TOKEN || "";
      const supplied = String(req.headers["x-inject-token"] || "");
      const tokenOk =
        expected.length > 0 &&
        supplied.length === expected.length &&
        require("crypto").timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
      if (!tokenOk) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Unauthorized" }));
        return;
      }
      try {
        const body = await parseJsonBody(req);
        const pKey = (body.profile || "codeorcap").toLowerCase();
        const reels = Array.isArray(body.reels) ? body.reels.slice(0, 50) : [];
        const watcher = activeWatchers.get(pKey);
        if (!watcher) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, message: `Profile [${pKey}] not found` }));
          return;
        }
        const count = await watcher.injectReels(reels);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ success: true, injectedCount: count, message: `Injected ${count} reel(s) for [${pKey.toUpperCase()}]` }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: err.message || "Error injecting reels" }));
      }
      return;
    }

    if (
      req.method === "POST" &&
      (url === "/api/force-start" || url.startsWith("/api/force-start?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (
          body.profile ||
          pUrl.searchParams.get("profile") ||
          "codeorcap"
        ).toLowerCase();

        pipelineLogger.info(
          `⚡ Real /runwatchnow channel automation pipeline force-started from Control Center UI for profile [${pKey.toUpperCase()}]`,
          "ControlCenter",
        );

        if (pKey === "all") {
          for (const [k, watcher] of activeWatchers.entries()) {
            watcher.forceStart().catch((err) => {
              pipelineLogger.error(
                `[${k.toUpperCase()}] forceStart workflow failed`,
                err,
                "ChannelWatcher",
              );
            });
          }
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(
            JSON.stringify({
              success: true,
              message: `⚡ Real /runwatch automation pipeline force-started for ALL profiles network!`,
            }),
          );
        } else {
          const watcher = activeWatchers.get(pKey);
          if (watcher) {
            watcher.forceStart().catch((err) => {
              pipelineLogger.error(
                `[${pKey.toUpperCase()}] forceStart workflow failed`,
                err,
                "ChannelWatcher",
              );
            });
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(
              JSON.stringify({
                success: true,
                message: `⚡ Real /runwatch automation pipeline force-started for [${pKey.toUpperCase()}]!`,
              }),
            );
          } else {
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(
              JSON.stringify({
                success: false,
                message: `No active watcher registered for profile [${pKey}].`,
              }),
            );
          }
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            message: "Error triggering force start",
          }),
        );
      }
      return;
    }

    if (
      req.method === "POST" &&
      (url === "/api/restart-queue" || url.startsWith("/api/restart-queue?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (
          body.profile ||
          pUrl.searchParams.get("profile") ||
          "codeorcap"
        ).toLowerCase();

        pipelineLogger.info(
          `🔄 Ingestion queue reset & real /runwatch automation restarted from Control Center UI for profile [${pKey.toUpperCase()}]`,
          "ControlCenter",
        );

        const pool = await getPool();
        if (pKey === "all") {
          await pool.query(
            `UPDATE reel_history SET failed = false, failed_reason = null`,
          );
          await pool.query(`UPDATE watch_state SET current_slot = 0`);
          for (const [k, watcher] of activeWatchers.entries()) {
            watcher.forceStart().catch((err) => {
              pipelineLogger.error(
                `[${k.toUpperCase()}] restartQueue workflow failed`,
                err,
                "ChannelWatcher",
              );
            });
          }
        } else {
          await pool.query(
            `UPDATE reel_history SET failed = false, failed_reason = null WHERE profile_key = $1 OR channel ILIKE $2`,
            [pKey, `%${pKey}%`],
          );
          await pool.query(
            `UPDATE watch_state SET current_slot = 0 WHERE profile_key = $1`,
            [pKey],
          );
          const watcher = activeWatchers.get(pKey);
          if (watcher) {
            watcher.forceStart().catch((err) => {
              pipelineLogger.error(
                `[${pKey.toUpperCase()}] restartQueue workflow failed`,
                err,
                "ChannelWatcher",
              );
            });
          }
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            success: true,
            message: `🔄 Queue reset & real /runwatch automation restarted for [${pKey.toUpperCase()}]!`,
          }),
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ success: false, message: "Error restarting queue" }),
        );
      }
      return;
    }

    if (
      url === "/api/channel-detail" ||
      url.startsWith("/api/channel-detail?")
    ) {
      try {
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = pUrl.searchParams.get("profile") || "codeorcap";
        const data = await getChannelDetails(pKey);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(data || { error: "Channel profile not found" }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to get channel details" }));
      }
      return;
    }

    const urlObj = new URL(url, `http://${req.headers.host || "localhost"}`);
    const isStream = urlObj.pathname === "/logs/stream" ||
                     urlObj.searchParams.get("stream") === "true" ||
                     (req.headers["accept"] && req.headers["accept"].includes("text/event-stream"));

    // ── /logs/stream or /logs?stream=true: Real-time SSE streaming for UI ───
    if (isStream && (urlObj.pathname === "/logs" || urlObj.pathname === "/logs/stream" || urlObj.pathname.startsWith("/logs/"))) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.flushHeaders();

      for (const line of readLastLines(COMBINED_LOG, TAIL_LINES)) {
        res.write(`data: ${line}\n\n`);
      }

      addLogClient(res);
      req.on("close", () => removeLogClient(res));
      return;
    }

    // ── /logs, /logs/raw, /logs/text: Raw plaintext logs for CLI, curl, and agents ───
    const isLogsPath = urlObj.pathname === "/logs" ||
                       urlObj.pathname === "/logs/raw" ||
                       urlObj.pathname === "/logs/text" ||
                       urlObj.pathname === "/logs/plain";

    if (isLogsPath) {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      });

      const targetLog = urlObj.searchParams.get("type") === "error" ? ERROR_LOG : COMBINED_LOG;
      const tailParam = urlObj.searchParams.get("tail") || urlObj.searchParams.get("lines");
      const lineCount = tailParam ? Math.max(1, parseInt(tailParam, 10) || 3000) : 3000;
      const isAll = urlObj.searchParams.get("all") === "true";

      if (fs.existsSync(targetLog)) {
        if (isAll) {
          try {
            res.end(fs.readFileSync(targetLog, "utf8"));
          } catch (_) {
            const lines = readLastLines(targetLog, lineCount);
            res.end(lines.join("\n"));
          }
        } else {
          const lines = readLastLines(targetLog, lineCount);
          res.end(lines.join("\n"));
        }
      } else {
        res.end(`Log file not found on the server (${path.basename(targetLog)}).`);
      }
      return;
    }

    // ── Hot-reload SSE endpoint ─────────────────────────────────────────────
    if (url === "/__livereload") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.flushHeaders();
      res.write("data: connected\n\n");
      liveReloadClients.add(res);
      req.on("close", () => liveReloadClients.delete(res));
      return;
    }

    // ── /api/video-preview — serve the rendered mp4 for a job (or the newest one) ───────────────────────────
    // Browsers (Safari and mobile Chrome above all) will not play or seek a video unless the server answers byte-range
    // requests, so this answers 206 Partial Content. A job's own file is never swapped for another job's video, and a
    // file that is still being copied (size still changing) is reported as "not ready" so the page retries.
    if ((req.method === "GET" || req.method === "HEAD") && url.startsWith("/api/video-preview")) {
      const send = (code: number, body: object) => {
        res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "2" });
        res.end(JSON.stringify(body));
      };
      try {
        const pUrl = new URL(url, `http://localhost`);
        const jobId = (pUrl.searchParams.get("jobId") || "").replace(/[^A-Za-z0-9_-]/g, "");
        const outputDir = path.resolve(config.paths.outputDir || path.join(process.cwd(), "output"));
        const mp4s = fs.existsSync(outputDir)
          ? fs.readdirSync(outputDir)
              .filter((f) => f.endsWith(".mp4"))
              .map((f) => ({ f, t: fs.statSync(path.join(outputDir, f)).mtimeMs }))
              .sort((x, y) => y.t - x.t)
          : [];
        const pick = jobId ? mp4s.find((x) => x.f.includes(jobId)) : mp4s[0];
        if (!pick) {
          send(404, { success: false, message: jobId ? `No preview video for ${jobId} yet` : "No preview video found yet" });
          return;
        }
        const targetFile = path.join(outputDir, pick.f);
        const size = fs.statSync(targetFile).size;
        // Still being written? (modified in the last 2 s, or empty)
        if (size === 0 || Date.now() - pick.t < 2000) {
          send(425, { success: false, message: "Video is still being written" });
          return;
        }
        const headers: Record<string, string | number> = {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        };
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
        let start = 0;
        let end = size - 1;
        let code = 200;
        if (m && (m[1] !== "" || m[2] !== "")) {
          if (m[1] === "") { start = Math.max(0, size - parseInt(m[2], 10)); }
          else { start = parseInt(m[1], 10); if (m[2] !== "") end = Math.min(end, parseInt(m[2], 10)); }
          if (start > end || start >= size) {
            res.writeHead(416, { "Content-Range": `bytes */${size}` });
            res.end();
            return;
          }
          code = 206;
          headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
        }
        headers["Content-Length"] = end - start + 1;
        res.writeHead(code, headers);
        if (req.method === "HEAD") { res.end(); return; }
        const stream = fs.createReadStream(targetFile, { start, end });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
      } catch (err) {
        send(500, { success: false, message: "Error serving preview" });
      }
      return;
    }

    // ── /api/source-frame — serve extracted JPEG frame for source preview ───
    if (req.method === "GET" && url.startsWith("/api/source-frame")) {
      try {
        const tempDir = path.join(process.cwd(), "temp");
        let targetFile = "";

        if (fs.existsSync(tempDir)) {
          const genDirs = fs.readdirSync(tempDir)
            .filter((d) => d.startsWith("gen-"))
            .map((d) => ({ dir: path.join(tempDir, d), t: fs.statSync(path.join(tempDir, d)).mtimeMs }))
            .sort((a, b) => b.t - a.t);

          for (const { dir } of genDirs) {
            const frameJpg = path.join(dir, "original.jpg");
            const framePng = path.join(dir, "original.png");
            if (fs.existsSync(frameJpg)) { targetFile = frameJpg; break; }
            if (fs.existsSync(framePng)) { targetFile = framePng; break; }
          }
        }

        if (!targetFile || !fs.existsSync(targetFile)) {
          res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: false, message: "No source frame available" }));
          return;
        }

        const stat = fs.statSync(targetFile);
        res.writeHead(200, {
          "Content-Type": targetFile.endsWith(".png") ? "image/png" : "image/jpeg",
          "Content-Length": stat.size,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300",
        });
        fs.createReadStream(targetFile).pipe(res);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Error serving source frame" }));
      }
      return;
    }

    // ── /output/* — serve mp4 files for <video> src, with HTTP Range so the player can seek ──
    if ((req.method === "GET" || req.method === "HEAD") && url.startsWith("/output/")) {
      try {
        const outputRoot = path.resolve(process.cwd(), "output");
        const filePath = path.resolve(process.cwd(), decodeURIComponent(url.split("?")[0]).replace(/^\/+/, ""));
        if (!filePath.startsWith(outputRoot + path.sep) || !filePath.endsWith(".mp4") || !fs.existsSync(filePath)) {
          res.writeHead(404); res.end(); return;
        }
        const size = fs.statSync(filePath).size;
        const base = {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        };
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
        let start = 0, end = size - 1, status = 200;
        if (m && (m[1] || m[2])) {
          if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
          else { start = Math.max(0, size - Number(m[2])); } // "bytes=-N": the last N bytes
          if (start > end || start >= size) {
            res.writeHead(416, { ...base, "Content-Range": `bytes */${size}` }); res.end(); return;
          }
          status = 206;
        }
        const headers: Record<string, string | number> = { ...base, "Content-Length": end - start + 1 };
        if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
        res.writeHead(status, headers);
        if (req.method === "HEAD") { res.end(); return; }
        const stream = fs.createReadStream(filePath, { start, end });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy()); // the player aborts requests while scrubbing
        stream.pipe(res);
      } catch { res.writeHead(404); res.end(); }
      return;
    }

    // ── AI DM SYSTEM ENDPOINTS ─────────────────────────────────────────────
    if (req.method === "GET" && (url === "/api/dm/status" || url.startsWith("/api/dm/status?"))) {
      const parsedUrl = new URL(url, `http://localhost:${PORT}`);
      const profile = parsedUrl.searchParams.get("profile") || "codeorcap";
      const persona = getPersona(profile);
      const allTopics = dmKnowledgeBase.getAllTopics(profile);
      const conversations = dmStore.getAllConversations();
      const leads = dmStore.getAllLeads();

      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        profile,
        persona: {
          creatorName: persona.creatorName,
          brandName: persona.brandName,
          handle: persona.handle,
          voiceTone: persona.voiceTone,
        },
        stats: {
          indexedKnowledgeTopics: allTopics.length,
          totalConversations: conversations.length,
          totalLeads: leads.length,
          pendingLeads: leads.filter(l => l.status === "pending").length,
          repliedLeads: leads.filter(l => l.status === "replied").length,
        },
      }));
      return;
    }

    if (req.method === "GET" && (url === "/api/dm/conversations" || url.startsWith("/api/dm/conversations?"))) {
      const conversations = dmStore.getAllConversations();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ conversations }));
      return;
    }

    if (req.method === "GET" && (url === "/api/dm/leads" || url.startsWith("/api/dm/leads?"))) {
      const leads = dmStore.getAllLeads();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ leads }));
      return;
    }

    if (req.method === "POST" && url === "/api/dm/lead") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          if (!data.username) {
            res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ error: "username is required" }));
            return;
          }
          const lead = outboundDmManager.addLead(data);
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: true, lead }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method === "POST" && url === "/api/dm/test-reply") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          const text = data.text || "";
          const profile = data.profile || "codeorcap";
          const result = await aiDmBrain.generateInboundReply(text, [], profile);
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: true, result }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Instagram Webhook Verification
    if (req.method === "GET" && (url === "/api/dm/webhook" || url.startsWith("/api/dm/webhook?"))) {
      const parsedUrl = new URL(url, `http://localhost:${PORT}`);
      const mode = parsedUrl.searchParams.get("hub.mode");
      const token = parsedUrl.searchParams.get("hub.verify_token");
      const challenge = parsedUrl.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token === (process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || "shorts_automation_dm")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(challenge);
      } else {
        res.writeHead(403);
        res.end("Forbidden");
      }
      return;
    }

    // Instagram Webhook Inbound Message Event
    if (req.method === "POST" && url === "/api/dm/webhook") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          if (data.object === "instagram" && Array.isArray(data.entry)) {
            for (const entry of data.entry) {
              if (Array.isArray(entry.messaging)) {
                for (const event of entry.messaging) {
                  if (event.message && event.message.text && !event.message.is_echo) {
                    // Trigger async handling in background
                    inboundDmManager.handleIncomingMessage(
                      event.sender?.id,
                      event.message.mid || `mid-${Date.now()}`,
                      event.message.text,
                      "codeorcap"
                    ).catch(e => pipelineLogger.error("[Webhook] DM handle error", e, "LogServer"));
                  }
                }
              }
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
        } catch (err: any) {
          res.writeHead(200);
          res.end("ok");
        }
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
    });
    res.end(getHTML());
  });

  // Watch dashboard.html for changes → notify all connected browsers
  try {
    const htmlPath = resolveHtmlPath();
    let debounceTimer: NodeJS.Timeout | null = null;
    fs.watch(htmlPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(`[LogServer] dashboard.html changed — pushing hot-reload to ${liveReloadClients.size} client(s)`);
        notifyLiveReload();
      }, 100);
    });
    console.log(`[LogServer] Hot-reload watching: ${htmlPath}`);
  } catch (e) {
    console.warn("[LogServer] Could not start file watcher for hot-reload:", e);
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(
      `[LogServer] Production Control Center & Live Logs → http://127.0.0.1:${PORT}`,
    );
  });
}
