import http from "http";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { google } from "googleapis";
import { addLogClient, removeLogClient } from "./utils/logBroadcast";
import { config, ChannelProfile, resolveTheme } from "./config";
import { getPool } from "./utils/pgClient";
import { getChannelCredentials, patchChannelCredentials } from "./utils/credentialStore";
import { getAllStoredChannelConfigs, saveChannelConfig, deleteChannelConfig, StoredChannelConfig, StoredInstagramAccount, StoredYoutubeChannel } from "./utils/channelConfigStore";
import { getAllAudienceStats } from "./utils/audienceStats";
import { activeWatchers } from "./instagram/channelWatcher";
import { DirectUploader } from "./direct-uploader";
import { ViralAnalyzer } from "./utils/viral-analyzer";
import { buildHashtagsForNiche } from "./instagram/nicheSearcher";
import { computeViralScore } from "./utils/viralScore";
import { MultiSceneGenerator } from "./video/multiSceneGenerator";
import { YouTubeService } from "./youtube";
import { pipelineLogger } from "./utils/logger";

function escapeHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let ytOAuthServer: http.Server | null = null;

function ensureYouTubeOAuthServer(): void {
  if (ytOAuthServer) return;
  try {
    const oauthPort = 3001;
    ytOAuthServer = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url || "/", `http://localhost:${oauthPort}`);
      if (parsedUrl.pathname === "/oauth2callback") {
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
          const redirectUri = `http://localhost:${oauthPort}/oauth2callback`;
          const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
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
                }
              </script>
            </body>
            </html>
          `);
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<h3>❌ Token exchange failed: ${escapeHtml(err.message)}</h3>`);
        }
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
    const bufferSize = 8192;
    const buffer = Buffer.alloc(bufferSize);
    let filePosition = fileSize;
    let lineCount = 0;
    let output = "";

    while (filePosition > 0 && lineCount <= maxLines) {
      const readLength = Math.min(bufferSize, filePosition);
      filePosition -= readLength;
      fs.readSync(fd, buffer, 0, readLength, filePosition);
      
      const chunk = buffer.toString("utf8", 0, readLength);
      output = chunk + output;
      
      let pos = -1;
      while ((pos = chunk.indexOf("\n", pos + 1)) !== -1) {
        lineCount++;
      }
    }

    fs.closeSync(fd);

    const lines = output.split("\n").filter((l) => l.trim());
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

async function getDashboardData() {
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
      niche: "humor",
      initials: "PG",
      color: "amber",
      dailyLimit: 6,
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
    path.join(process.cwd(), "src", "dashboard.html"),
    path.join(process.cwd(), "public", "dashboard.html"),
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

function getHTML(): string {
  const html = fs.readFileSync(resolveHtmlPath(), "utf8");
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

export function startLogServer(): void {
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
        const redirectUri = "http://localhost:3001/oauth2callback";

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

    // ── POST /api/meta/inspect-accounts ───────────────────────────────────
    if (
      req.method === "POST" &&
      (url === "/api/meta/inspect-accounts" || url.startsWith("/api/meta/inspect-accounts?"))
    ) {
      try {
        const body = await parseJsonBody(req);
        let token = (body.token || "").trim();

        if (!token) {
          const configs = await getAllStoredChannelConfigs();
          token = configs.find((c) => c.instagramAccessToken)?.instagramAccessToken || process.env.INSTAGRAM_ACCESS_TOKEN || "";
        }

        if (!token) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: false, message: "No Meta Access Token provided or found in environment." }));
          return;
        }

        const metaRes = await fetch(
          `https://graph.facebook.com/v19.0/me/accounts?fields=name,id,access_token,instagram_business_account{id,username,name,profile_picture_url}&access_token=${encodeURIComponent(token)}`
        );
        const metaData = (await metaRes.json()) as any;

        if (metaData.error) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: false, message: metaData.error.message || "Meta API Error" }));
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

        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ success: true, accounts }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
      return;
    }

    if (
      req.method === "GET" &&
      (url === "/api/channels" || url.startsWith("/api/channels?"))
    ) {
      try {
        const channels = await getAllStoredChannelConfigs();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "Access-Control-Allow-Origin": "*",
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
        const body = await parseJsonBody(req);
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
            telegramToken: config.telegramToken,
            youtube: {
              clientId: storedConfig.youtubeClientId || process.env.YOUTUBE_CLIENT_ID || "",
              clientSecret: storedConfig.youtubeClientSecret || process.env.YOUTUBE_CLIENT_SECRET || "",
              redirectUri: process.env.YOUTUBE_REDIRECT_URI || "http://localhost:3000/oauth2callback",
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
        res.end(JSON.stringify({ success: true, message: `Channel [${storedConfig.brandName}] configured and active.`, channel: storedConfig }));
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
                redirectUri: storedConfig?.youtubeRedirectUri || "http://localhost:3001/oauth2callback",
                channels: ytChannels.length > 0 ? ytChannels : [{ name: storedConfig?.brandName || channelKey, refreshToken: storedConfig?.youtubeRefreshToken || "" }],
              });
              const ytRes = await ytService.uploadToAllChannels(result.videoPath, {
                title: result.metadata.title,
                description: result.metadata.description,
                tags: result.metadata.tags,
              });
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
          redirectUri: storedConfig?.youtubeRedirectUri || "http://localhost:3001/oauth2callback",
          channels: ytChannels.length > 0 ? ytChannels : [{ name: storedConfig?.brandName || channelKey, refreshToken: storedConfig?.youtubeRefreshToken || "" }],
        });

        pipelineLogger.info(`Publishing video ${videoPath} to YouTube for [${storedConfig?.brandName || channelKey}]`, "LogServer");

        const uploadResults = await ytService.uploadToAllChannels(videoPath, {
          title: body.title || `${storedConfig?.brandName || 'CodeOrCap'} Video`,
          description: body.description || "",
          tags: Array.isArray(body.tags) ? body.tags : ["tech", "coding", "tutorial"],
        });

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
          jobId = await watcher.injectAndRunReel(reelUrl);
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

    // ── /api/video-preview — serve latest rendered mp4 for preview ──────────
    if (req.method === "GET" && url.startsWith("/api/video-preview")) {
      try {
        const pUrl = new URL(url, `http://localhost`);
        const jobId = pUrl.searchParams.get("jobId") || "";
        const outputDir = path.join(process.cwd(), "output");
        let targetFile = "";
        if (jobId) {
          const files = fs.readdirSync(outputDir).filter(f => f.includes(jobId) && f.endsWith(".mp4"));
          if (files.length) targetFile = path.join(outputDir, files[0]);
        }
        if (!targetFile) {
          // fallback: most recently modified mp4 in output/
          const files = fs.readdirSync(outputDir)
            .filter(f => f.endsWith(".mp4"))
            .map(f => ({ f, t: fs.statSync(path.join(outputDir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
          if (files.length) targetFile = path.join(outputDir, files[0].f);
        }
        if (!targetFile || !fs.existsSync(targetFile)) {
          res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: false, message: "No preview video found yet" }));
          return;
        }
        const stat = fs.statSync(targetFile);
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": stat.size,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        });
        fs.createReadStream(targetFile).pipe(res);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Error serving preview" }));
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

    // ── /output/* — serve mp4 files statically for <video> src ─────────────
    if (req.method === "GET" && url.startsWith("/output/")) {
      try {
        const filePath = path.join(process.cwd(), decodeURIComponent(url));
        if (!fs.existsSync(filePath) || !filePath.endsWith(".mp4")) {
          res.writeHead(404); res.end(); return;
        }
        const stat = fs.statSync(filePath);
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": stat.size,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        });
        fs.createReadStream(filePath).pipe(res);
      } catch { res.writeHead(404); res.end(); }
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
