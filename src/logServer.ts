import http from "http";
import fs from "fs";
import path from "path";
import { addLogClient, removeLogClient } from "./utils/logBroadcast";
import { config } from "./config";
import { getPool } from "./utils/pgClient";
import { activeWatchers } from "./instagram/channelWatcher";
import { ViralAnalyzer } from "./utils/viral-analyzer";
import { computeViralScore } from "./utils/viralScore";
import { pipelineLogger } from "./utils/logger";

const PORT = parseInt(process.env.LOG_SERVER_PORT || "3002", 10);
const COMBINED_LOG = path.join(config.paths.logDir, "combined.log");
const TAIL_LINES = 350;

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
    });
  });
}

function readLastLines(filePath: string, n: number): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stats = fs.statSync(filePath);
    const maxBytes = 256 * 1024;
    const readSize = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
    fs.closeSync(fd);
    const content = buffer.toString("utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    return stats.size > maxBytes ? lines.slice(1).slice(-n) : lines.slice(-n);
  } catch {
    return [];
  }
}

function generateTimeSeriesData(days: number, channels: string[], reelHistory: any[] = [], reelInsights: any[] = []) {
  const labels: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    labels.push(days <= 14 
      ? d.toLocaleDateString([], { weekday: "short", day: "numeric" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" })
    );
  }

  const series: Record<string, { views: number[]; reels: number[]; er: number[]; shares: number[] }> = {};
  channels.forEach((ch) => {
    const viewsArr: number[] = [];
    const reelsArr: number[] = [];
    const erArr: number[] = [];
    const sharesArr: number[] = [];

    const chHistory = reelHistory.filter(r => (r.profile_key || r.channel || "").toLowerCase().includes(ch.toLowerCase()));
    const chInsights = reelInsights.filter(i => (i.profile_key || "").toLowerCase().includes(ch.toLowerCase()));

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date(now);
      dayStart.setDate(dayStart.getDate() - i);
      dayStart.setHours(0, 0, 0, 0);

      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);

      const dayReels = chHistory.filter(r => {
        if (!r.published_at && !r.picked_at) return false;
        const pDate = new Date(r.published_at || r.picked_at);
        return pDate >= dayStart && pDate <= dayEnd;
      });

      const dayCount = dayReels.length;
      let dayViews = dayReels.reduce((sum, r) => sum + (Number(r.views) || 0), 0);
      let dayLikes = dayReels.reduce((sum, r) => sum + (Number(r.likes) || 0), 0);
      let dayComments = dayReels.reduce((sum, r) => sum + (Number(r.comments) || 0), 0);
      let dayShares = dayReels.reduce((sum, r) => sum + (Number(r.shares) || 0), 0);

      const dayInsights = chInsights.filter(ins => {
        if (!ins.recorded_at) return false;
        const rDate = new Date(ins.recorded_at);
        return rDate >= dayStart && rDate <= dayEnd;
      });

      if (dayInsights.length > 0) {
        dayViews = Math.max(dayViews, dayInsights.reduce((sum, ins) => sum + (Number(ins.views) || 0), 0));
        dayLikes = Math.max(dayLikes, dayInsights.reduce((sum, ins) => sum + (Number(ins.likes) || 0), 0));
        dayComments = Math.max(dayComments, dayInsights.reduce((sum, ins) => sum + (Number(ins.comments) || 0), 0));
        dayShares = Math.max(dayShares, dayInsights.reduce((sum, ins) => sum + (Number(ins.shares) || 0), 0));
      }

      const dayEr = dayViews > 0 ? +(((dayLikes + dayComments + dayShares) / dayViews) * 100).toFixed(2) : 0;

      viewsArr.push(dayViews);
      reelsArr.push(dayCount);
      erArr.push(dayEr);
      sharesArr.push(dayShares);
    }

    series[ch] = { views: viewsArr, reels: reelsArr, er: erArr, shares: sharesArr };
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
    const historyRes = await pool.query(`SELECT * FROM reel_history ORDER BY picked_at DESC LIMIT 100`);
    reelHistory = historyRes.rows;

    const watchRes = await pool.query(`SELECT * FROM watch_state`);
    watchStates = watchRes.rows.map(w => {
      if (Array.isArray(w.queue)) {
        w.queue = w.queue.filter((q: any) => q.shortcode && !q.shortcode.startsWith("failed-fetch-") && !q.shortcode.startsWith("no-unseen-"));
      }
      return w;
    });

    const insightsRes = await pool.query(`SELECT * FROM reel_insights ORDER BY views DESC LIMIT 50`);
    reelInsights = insightsRes.rows;
  } catch {
    dbStatus = "disconnected";
  }

  const recentLogs = readLastLines(COMBINED_LOG, 250);
  const priorityFixes: Array<{ id: string; severity: "high" | "medium" | "low"; title: string; message: string; actionHint: string }> = [];

  const igAuthErrors = recentLogs.filter(l => l.includes("Instagram login failed") || l.includes("LoginRequired") || l.includes("ChallengeRequired"));
  if (igAuthErrors.length > 0) {
    const failedAccounts = Array.from(new Set(igAuthErrors.map(l => {
      const match = l.match(/account "([^"]+)"/);
      return match ? match[1] : null;
    }).filter(Boolean)));

    priorityFixes.push({
      id: "ig_auth",
      severity: "high",
      title: "Instagram Authentication Action Needed",
      message: `Mobile API login failed for account(s): ${failedAccounts.join(", ") || "watcher accounts"}.`,
      actionHint: "Update account credentials or session cookies in .env on production server."
    });
  }

  if (dbStatus === "disconnected") {
    priorityFixes.push({
      id: "db_conn",
      severity: "high",
      title: "Database Connection Interrupted",
      message: "Unable to query PostgreSQL / Supabase tables.",
      actionHint: "Verify DATABASE_URL environment variable and database pooler availability."
    });
  }

  const todayStr = new Date().toISOString().slice(0, 10);

  const channels = config.profiles.map((profile, idx) => {
    const pKey = (profile.key || profile.brandName).toLowerCase();
    const wState = watchStates.find(w => w.profile_key === pKey);

    const profileHistory = reelHistory.filter(r => r.profile_key === pKey || r.channel?.toLowerCase().includes(pKey));
    const publishedToday = profileHistory.find(r => r.published_at && String(r.published_at).startsWith(todayStr));
    const lastPublished = publishedToday || profileHistory.find(r => r.published_at) || profileHistory[0];

    const queue = wState?.queue || [];
    const currentSlot = wState?.current_slot || 0;
    const totalSlots = profile.watch?.dailyCount || 6;
    const progressPct = Math.min(100, Math.round((currentSlot / totalSlots) * 100));

    const profileErrors = igAuthErrors.filter(l => l.toLowerCase().includes(pKey));
    let status: "working" | "warning" | "error" = "working";
    if (profileErrors.length > 0) status = "warning";

    const publishedCount = profileHistory.filter(r => !r.failed).length;
    const failedCount = profileHistory.filter(r => r.failed).length;

    const colors = ["teal", "blue", "purple", "amber", "rose"];
    const avatarColor = colors[idx % colors.length];

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
      scheduleTime: profile.watch?.scheduleTime || "09:00",
      gapHours: profile.watch?.gapHours || 3,
      queueCount: queue.length,
      currentSlot,
      totalSlots,
      progressPct,
      watchedChannelsCount: profile.watch?.channels?.length || 0,
      lastPublished: lastPublished ? {
        shortcode: lastPublished.shortcode,
        channel: lastPublished.channel,
        publishedAt: lastPublished.published_at || lastPublished.picked_at,
        originalUrl: `https://www.instagram.com/reel/${lastPublished.shortcode}/`,
        youtubeUrl: lastPublished.youtube_url,
        instagramUrl: lastPublished.instagram_url,
        facebookUrl: lastPublished.facebook_url,
        status: lastPublished.failed ? "failed" : "published",
        failedReason: lastPublished.failed_reason
      } : null,
      igFollowers: (profile as any).igFollowers || null,
      ytSubscribers: (profile as any).ytSubscribers || null,
      stats: {
        publishedCount,
        failedCount,
        viralCount: profileHistory.filter(r => r.views && r.views > 10000).length
      }
    };
  });

  const defaultFallbackProfiles = [
    { key: "codeorcap", name: "CodeOrCap", handle: "@codeorcap", niche: "tech", initials: "CO", color: "teal", dailyLimit: 6, active: true, igFollowers: null, ytSubscribers: null },
    { key: "storiyum", name: "Storiyum", handle: "@storiyum", niche: "stories", initials: "ST", color: "purple", dailyLimit: 6, active: true, igFollowers: null, ytSubscribers: null },
    { key: "prompt_gag", name: "PromptGag", handle: "@prompt_gag", niche: "humor", initials: "PG", color: "amber", dailyLimit: 6, active: true, igFollowers: null, ytSubscribers: null },
  ];

  defaultFallbackProfiles.forEach((fb) => {
    if (!channels.some(c => c.key === fb.key)) {
      const wState = watchStates.find(w => w.profile_key === fb.key);
      const profileHistory = reelHistory.filter(r => r.profile_key === fb.key || r.channel?.toLowerCase().includes(fb.key));
      const publishedToday = profileHistory.find(r => r.published_at && String(r.published_at).startsWith(todayStr));
      const lastPublished = publishedToday || profileHistory.find(r => r.published_at) || profileHistory[0];

      const queue = wState?.queue || [];
      const currentSlot = wState?.current_slot || 0;
      const totalSlots = fb.dailyLimit;
      const progressPct = Math.min(100, Math.round((currentSlot / totalSlots) * 100));

      const publishedCount = profileHistory.filter(r => !r.failed).length;
      const failedCount = profileHistory.filter(r => r.failed).length;

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
        scheduleTime: "09:00",
        gapHours: 3,
        queueCount: queue.length,
        currentSlot,
        totalSlots,
        progressPct,
        watchedChannelsCount: 4,
        igFollowers: fb.igFollowers,
        ytSubscribers: fb.ytSubscribers,
        lastPublished: lastPublished ? {
          shortcode: lastPublished.shortcode,
          channel: lastPublished.channel,
          publishedAt: lastPublished.published_at || lastPublished.picked_at,
          originalUrl: `https://www.instagram.com/reel/${lastPublished.shortcode}/`,
          youtubeUrl: lastPublished.youtube_url,
          instagramUrl: lastPublished.instagram_url,
          facebookUrl: lastPublished.facebook_url,
          status: lastPublished.failed ? "failed" : "published",
          failedReason: lastPublished.failed_reason
        } : null,
        stats: {
          publishedCount,
          failedCount,
          viralCount: profileHistory.filter(r => r.views && Number(r.views) > 10000).length
        }
      });
    }
  });

  const channelKeys = Array.from(new Set([...channels.map(c => c.key), "codeorcap", "storiyum", "prompt_gag"]));

  // Compile full Queue items across all watch_states & reelHistory
  const compiledQueue: any[] = [];

  watchStates.forEach(ws => {
    const rawList = ws.queue || [];
    const qList = rawList.filter((q: any) => {
      const sc = q.shortcode || "";
      if (sc.startsWith("failed-fetch-") || sc.startsWith("no-unseen-")) return false;
      return true;
    });
    qList.forEach((q: any, idx: number) => {
      const sc = q.shortcode || q.url?.split("/reel/")[1]?.split("/")[0] || q.url?.split("/p/")[1]?.split("/")[0];
      if (!sc || sc.startsWith("failed-fetch-") || sc.startsWith("no-unseen-")) return;
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
        commentCount: Number(q.commentCount || q.comment_count || 0)
      });
    });
  });

  reelHistory.forEach((rh, idx) => {
    if (!rh.shortcode || rh.shortcode.startsWith("failed-fetch-") || rh.shortcode.startsWith("no-unseen-")) return;
    compiledQueue.push({
      id: `h_${rh.shortcode}_${rh.profile_key}`,
      shortcode: rh.shortcode,
      channel: rh.profile_key || "codeorcap",
      source: rh.instagram_url || `https://www.instagram.com/reel/${rh.shortcode}/`,
      youtubeUrl: rh.youtube_url,
      facebookUrl: rh.facebook_url,
      addedAt: rh.published_at || rh.picked_at,
      status: rh.failed ? "failed" : "published",
      slot: (idx % 6) + 1,
      playCount: Number(rh.views || 0),
      likeCount: Number(rh.likes || 0),
      commentCount: Number(rh.comments || 0)
    });
  });

  // Analytics time-series computed directly from PostgreSQL reelHistory & reelInsights
  const timeSeriesRanges = {
    "7d": generateTimeSeriesData(7, channelKeys, reelHistory, reelInsights),
    "14d": generateTimeSeriesData(14, channelKeys, reelHistory, reelInsights),
    "30d": generateTimeSeriesData(30, channelKeys, reelHistory, reelInsights),
    "90d": generateTimeSeriesData(90, channelKeys, reelHistory, reelInsights)
  };

  // Collect & compile viral analytics data
  const viralAnalyzer = new ViralAnalyzer();
  const analyticsRecords = viralAnalyzer.getRecords();
  const viralPatternsText = viralAnalyzer.getViralPatterns();

  const allReelsMap = new Map<string, any>();
  compiledQueue.forEach(q => {
    allReelsMap.set(q.shortcode, {
      ...q,
      title: q.title || `Short clip #${q.shortcode}`,
      sourceChannel: q.channel || "creator",
      profileKey: q.channel
    });
  });

  analyticsRecords.forEach(rec => {
    const existing = allReelsMap.get(rec.id) || {};
    allReelsMap.set(rec.id, {
      ...existing,
      shortcode: rec.id,
      title: rec.title,
      profileKey: existing.profileKey || "codeorcap",
      sourceChannel: existing.sourceChannel || "analytics",
      playCount: Math.max(rec.metrics?.views || 0, existing.playCount || 0),
      likeCount: Math.max(rec.metrics?.likes || 0, existing.likeCount || 0),
      commentCount: Math.max(rec.metrics?.comments || 0, existing.commentCount || 0),
      youtubeUrl: rec.youtubeUrl || existing.youtubeUrl,
      sourceUrl: existing.sourceUrl || rec.youtubeUrl || `https://www.instagram.com/reel/${rec.id}/`,
      status: "published"
    });
  });

  const reelsList = Array.from(allReelsMap.values());
  const maxPlays = Math.max(1, ...reelsList.map(r => r.playCount || 0));
  const maxLikes = Math.max(1, ...reelsList.map(r => r.likeCount || 0));
  const maxComments = Math.max(1, ...reelsList.map(r => r.commentCount || 0));

  const scoredReels = reelsList.map(r => {
    const playC = r.playCount || 0;
    const likeC = r.likeCount || 0;
    const commC = r.commentCount || 0;
    const calculatedScore = computeViralScore(
      { playCount: playC, likeCount: likeC, commentCount: commC },
      { playCount: maxPlays, likeCount: maxLikes, commentCount: maxComments }
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
      trend
    };
  }).sort((a, b) => b.viralScore - a.viralScore);

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const recent7Views = reelHistory.filter(r => (nowMs - new Date(r.published_at || r.picked_at || 0).getTime()) <= sevenDaysMs).reduce((s, r) => s + (Number(r.views) || 0), 0);
  const prev7Views = reelHistory.filter(r => {
    const age = nowMs - new Date(r.published_at || r.picked_at || 0).getTime();
    return age > sevenDaysMs && age <= 14 * 24 * 60 * 60 * 1000;
  }).reduce((s, r) => s + (Number(r.views) || 0), 0);
  const viewsDelta = prev7Views > 0 ? Math.round(((recent7Views - prev7Views) / prev7Views) * 100) : (recent7Views > 0 ? 100 : 0);

  const recent7Shares = reelHistory.filter(r => (nowMs - new Date(r.published_at || r.picked_at || 0).getTime()) <= sevenDaysMs).reduce((s, r) => s + (Number(r.shares) || 0), 0);
  const prev7Shares = reelHistory.filter(r => {
    const age = nowMs - new Date(r.published_at || r.picked_at || 0).getTime();
    return age > sevenDaysMs && age <= 14 * 24 * 60 * 60 * 1000;
  }).reduce((s, r) => s + (Number(r.shares) || 0), 0);
  const sharesDelta = prev7Shares > 0 ? Math.round(((recent7Shares - prev7Shares) / prev7Shares) * 100) : (recent7Shares > 0 ? 100 : 0);

  const viralAnalytics = {
    timeSeriesRanges,
    kpis: {
      totalViews: scoredReels.reduce((s, r) => s + (r.playCount || 0), 0),
      totalReels: scoredReels.length,
      avgER: scoredReels.length > 0 ? +(scoredReels.reduce((s, r) => s + r.er, 0) / scoredReels.length).toFixed(1) : 0,
      totalShares: scoredReels.reduce((s, r) => s + (r.shares || 0), 0),
      viewsDelta,
      sharesDelta
    },
    leaderboard: scoredReels.slice(0, 25),
    patternsText: viralPatternsText
  };

  return {
    systemHealth: {
      status: priorityFixes.length > 0 ? "warning" : "healthy",
      dbStatus,
      activeProfilesCount: config.profiles.length,
      priorityFixes
    },
    channels,
    queue: compiledQueue,
    recentHistory: reelHistory.slice(0, 15),
    topInsights: reelInsights.slice(0, 15),
    viralAnalytics
  };
}

async function getChannelDetails(pKey: string) {
  pKey = pKey.toLowerCase();
  const profile = config.profiles.find(p => (p.key || p.brandName).toLowerCase() === pKey);
  if (!profile) return null;

  let queue: any[] = [];
  let history: any[] = [];
  let currentSlot = 0;

  try {
    const pool = await getPool();
    const wRes = await pool.query(`SELECT * FROM watch_state WHERE profile_key = $1`, [pKey]);
    if (wRes.rows.length > 0) {
      queue = wRes.rows[0].queue || [];
      currentSlot = wRes.rows[0].current_slot || 0;
    }

    const hRes = await pool.query(`SELECT * FROM reel_history WHERE profile_key = $1 ORDER BY picked_at DESC LIMIT 50`, [pKey]);
    history = hRes.rows;
  } catch {}

  const formattedQueue = queue.map((q: any) => ({
    shortcode: q.shortcode || q.url?.split("/reel/")[1]?.replace(/\//g, "") || "N/A",
    originalUrl: q.url || `https://www.instagram.com/reel/${q.shortcode}/`,
    sourceChannel: q.channel || q.creatorUsername || "n/a",
    sourceHashtag: q.sourceHashtag || profile.theme?.niche || "tech",
    playCount: q.playCount || q.play_count || 0,
    likeCount: q.likeCount || q.like_count || 0,
    commentCount: q.commentCount || q.comment_count || 0,
    pickedAt: q.pickedAt || new Date().toISOString()
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
    failedReason: h.failed_reason
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
      currentSlot,
      totalSlots: profile.watch?.dailyCount || 6,
      progressPct: Math.min(100, Math.round((currentSlot / (profile.watch?.dailyCount || 6)) * 100))
    },
    queue: formattedQueue,
    history: formattedHistory
  };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shorts Automation — Control Center, Queue & Viral Analytics</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <!-- Chart.js for Visualizations -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --card-border: #21262d;
      --card-hover: #1c2128;
      --text: #e6edf3;
      --text-muted: #8b949e;
      --text-dim: #484f58;
      --primary: #58a6ff;
      --primary-bg: rgba(56, 139, 253, 0.15);
      --primary-glow: rgba(88, 166, 255, 0.3);
      --success: #3fb950;
      --success-bg: rgba(63, 185, 80, 0.15);
      --warning: #d29922;
      --warning-bg: rgba(210, 153, 34, 0.15);
      --danger: #f85149;
      --danger-bg: rgba(248, 81, 73, 0.15);
      --purple: #bc8cff;
      --purple-bg: rgba(188, 140, 255, 0.15);
      --font: 'Inter', system-ui, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 13px; min-height: 100vh; line-height: 1.5; -webkit-font-smoothing: antialiased; }

    /* ANIMATIONS & UTILS */
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.15); } }
    tr:hover td { background: var(--card-hover) !important; }
    input:focus, select:focus { border-color: var(--primary) !important; outline: none; }
    button:hover { filter: brightness(1.12); }

    /* TOPBAR */
    #topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid var(--card-border); background: var(--card); sticky: top; z-index: 100; flex-wrap: wrap; gap: 12px; }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--primary); animation: pulse 2s infinite; box-shadow: 0 0 12px var(--primary-glow); }
    .brand-name { font-size: 16px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
    .brand-tag { font-size: 10px; color: var(--text-muted); background: var(--bg); border: 1px solid var(--card-border); border-radius: 4px; padding: 2px 7px; font-family: var(--font-mono); }
    .status-pill { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: var(--success); background: rgba(13, 68, 41, 0.7); border: 1px solid #1f6335; border-radius: 20px; padding: 4px 12px; }
    .status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); animation: pulse 1.5s infinite; }

    /* LAYOUT BODY & SIDEBAR */
    .app-body { display: grid; grid-template-columns: 210px 1fr; min-height: calc(100vh - 49px); }
    .sidebar { border-right: 1px solid var(--card-border); background: var(--card); padding: 14px 0; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
    .nav-section-label { font-size: 10px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; padding: 10px 16px 4px; }
    .nav-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; margin: 1px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; color: var(--text-muted); transition: all 0.15s ease; user-select: none; }
    .nav-item:hover { color: var(--text); background: rgba(255,255,255,0.04); }
    .nav-item.active { color: var(--primary); background: #0d2033; font-weight: 700; border-left: 3px solid var(--primary); }
    .nav-badge { margin-left: auto; font-size: 10px; font-weight: 700; background: var(--card-border); color: var(--text-muted); border-radius: 10px; padding: 1px 7px; font-family: var(--font-mono); }
    .divider { height: 1px; background: var(--card-border); margin: 10px 12px; }

    .main-content { overflow-y: auto; display: flex; flex-direction: column; background: var(--bg); }
    
    /* STATS HEADER CARDS */
    .section-stats { padding: 18px 20px; border-bottom: 1px solid var(--card-border); }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
    .stat-card { background: var(--card); border: 1px solid var(--card-border); border-radius: 10px; padding: 14px 16px; transition: transform 0.15s, border-color 0.15s; }
    .stat-card:hover { transform: translateY(-2px); border-color: rgba(88, 166, 255, 0.4); }
    .stat-val { font-size: 24px; font-weight: 800; font-family: var(--font-mono); line-height: 1; margin-bottom: 4px; }
    .stat-lbl { font-size: 10px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }

    /* TAB HEADERS */
    .tabs-bar { display: flex; border-bottom: 1px solid var(--card-border); padding: 0 20px; background: var(--card); overflow-x: auto; gap: 4px; }
    .tab-item { padding: 12px 18px; font-size: 13px; font-weight: 600; color: var(--text-muted); border-bottom: 2px solid transparent; cursor: pointer; transition: all 0.15s; whitespace: nowrap; display: flex; align-items: center; gap: 6px; }
    .tab-item:hover { color: var(--text); }
    .tab-item.active { color: var(--primary); border-bottom-color: var(--primary); font-weight: 700; }

    .tab-pane { display: none; padding: 22px 20px; }
    .tab-pane.active { display: block; animation: fadeIn 0.2s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    /* BUTTONS & INPUTS */
    .btn-icon { background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 6px; transition: all 0.15s; font-family: inherit; font-weight: 600; }
    .btn-icon:hover { color: var(--primary); border-color: var(--primary); background: rgba(56, 139, 253, 0.1); }
    .btn-primary { background: #238636; border: 1px solid #2ea043; border-radius: 8px; padding: 10px 20px; color: #fff; font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit; transition: all 0.15s; display: inline-flex; align-items: center; gap: 6px; }
    .btn-primary:hover { background: #2ea043; }
    .btn-danger { background: var(--danger-bg); border: 1px solid rgba(248, 81, 73, 0.4); color: var(--danger); font-weight: 700; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; }

    .input-field { width: 100%; background: var(--bg); border: 1px solid #30363d; border-radius: 8px; padding: 10px 14px; color: var(--text); font-size: 13px; font-family: inherit; outline: none; transition: border 0.15s; }
    .input-field:focus { border-color: var(--primary); }
    .select-field { background: var(--bg); border: 1px solid #30363d; border-radius: 8px; padding: 8px 12px; color: var(--text); font-size: 13px; font-family: inherit; outline: none; cursor: pointer; }

    /* FILTERS & PILLS */
    .filter-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
    .filter-label { color: var(--text-dim); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
    .pill-btn { font-size: 11px; font-weight: 600; padding: 5px 13px; border-radius: 6px; border: 1px solid #30363d; background: var(--card); color: var(--text-muted); cursor: pointer; transition: all 0.15s; whitespace: nowrap; }
    .pill-btn:hover, .pill-btn.active { background: #0d2033; color: var(--primary); border-color: #388bfd; }

    /* KPI GRID ANALYTICS */
    .analytics-kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
    .analytics-kpi-card { background: var(--card); border: 1px solid var(--card-border); border-radius: 10px; padding: 14px 16px; }
    .analytics-kpi-val { font-size: 26px; font-weight: 800; color: #e6edf3; line-height: 1; margin-bottom: 4px; font-family: var(--font-mono); }
    .analytics-kpi-lbl { font-size: 10px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.7px; }
    .analytics-kpi-delta { font-size: 11px; font-weight: 700; margin-top: 4px; }
    .delta-pos { color: var(--success); }
    .delta-neg { color: var(--danger); }

    /* GRAPHS GRID */
    .graphs-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .chart-card { background: var(--card); border: 1px solid var(--card-border); border-radius: 10px; padding: 16px 18px; margin-bottom: 16px; }
    .chart-title { font-size: 12px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 2px; }
    .chart-sub { font-size: 11px; color: var(--text-dim); margin-bottom: 12px; }
    .chart-container { position: relative; width: 100%; height: 230px; }
    .chart-container-sm { position: relative; width: 100%; height: 180px; }

    /* TABLES */
    .table-card { background: var(--card); border: 1px solid var(--card-border); border-radius: 12px; padding: 18px; margin-bottom: 24px; }
    .table-responsive { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th { padding: 10px 12px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-dim); border-bottom: 1px solid var(--card-border); }
    td { padding: 10px 12px; border-bottom: 1px solid #161b22; vertical-align: middle; font-size: 12px; }

    .code-badge { font-family: var(--font-mono); font-size: 11px; color: var(--primary); background: #0d2033; padding: 2px 7px; border-radius: 4px; font-weight: 700; }
    .status-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 5px; text-transform: capitalize; }
    .status-queued { background: var(--warning-bg); color: var(--warning); border: 1px solid rgba(210, 153, 34, 0.3); }
    .status-processing { background: var(--primary-bg); color: var(--primary); border: 1px solid rgba(88, 166, 255, 0.3); }
    .status-published { background: var(--success-bg); color: var(--success); border: 1px solid rgba(63, 185, 80, 0.3); }
    .status-failed { background: var(--danger-bg); color: var(--danger); border: 1px solid rgba(248, 81, 73, 0.3); }
    .badge-dot { width: 5px; height: 5px; border-radius: 50%; }

    .channel-select-card { background: var(--card); border: 1px solid var(--card-border); border-radius: 10px; padding: 14px; cursor: pointer; transition: all 0.15s; position: relative; }
    .channel-select-card.selected { background: #0d2033; border-color: #388bfd; }
    .avatar-box { width: 34px; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; color: #fff; flex-shrink: 0; }
    .avatar-teal { background: #065f46; color: #a7f3d0; }
    .avatar-blue { background: #1e40af; color: #bfdbfe; }
    .avatar-purple { background: #5b21b6; color: #ddd6fe; }
    .avatar-amber { background: #78350f; color: #fde68a; }

    .config-card { background: var(--card); border: 1px solid var(--card-border); border-radius: 12px; padding: 18px; margin-bottom: 16px; }

    /* TOAST NOTIFICATION */
    #toast { position: fixed; bottom: 24px; right: 24px; background: #238636; color: #fff; padding: 12px 20px; border-radius: 8px; font-size: 13px; font-weight: 600; z-index: 9999; box-shadow: 0 6px 20px rgba(0,0,0,0.5); display: none; align-items: center; gap: 8px; animation: fadeIn 0.2s ease; }

    /* RESPONSIVENESS */
    @media (max-width: 900px) {
      .app-body { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--card-border); padding: 8px 12px; flex-direction: row; overflow-x: auto; }
      .nav-section-label, .divider { display: none; }
      .nav-item { margin: 0; whitespace: nowrap; }
      .analytics-kpi-grid { grid-template-columns: repeat(2, 1fr); }
      .graphs-grid-2 { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

<div id="topbar">dfdfdfdfdf
  <div class="brand">
    <div class="brand-dot"></div>
    <span class="brand-name">Shorts Automation</span>
    <span class="brand-tag">v3.5 Viral Analytics</span>
  </div>
  <div style="display: flex; align-items: center; gap: 10px; flex-shrink: 0;">
    <div class="status-pill"><div class="status-dot"></div> System Active</div>
    <button class="btn-icon" onclick="fetchDashboardData()">⟳ Refresh</button>
  </div>
</div>

<div class="app-body">
  <!-- SIDEBAR NAVIGATION -->
  <div class="sidebar">
    <div class="nav-section-label">Control</div>
    <div class="nav-item active" data-tab="overview" onclick="switchTab('overview', this)">
      <span>📊</span> Overview & Control
    </div>
    <div class="nav-item" data-tab="channels" onclick="switchTab('channels', this)">
      <span>📺</span> Channel Cards
    </div>
    <div class="nav-item" data-tab="queue" onclick="switchTab('queue', this)">
      <span>⏳</span> Queue Manager <span class="nav-badge" id="nav-badge-queued">0</span>
    </div>
    <div class="nav-item" data-tab="inject" onclick="switchTab('inject', this)">
      <span>＋</span> Inject Link
    </div>
    <div class="nav-item" data-tab="viral" onclick="switchTab('viral', this)">
      <span>🔥</span> Viral Analytics
    </div>
    <div class="nav-item" data-tab="config" onclick="switchTab('config', this)">
      <span>⚙️</span> Configuration
    </div>
    <div class="nav-item" data-tab="logs" onclick="switchTab('logs', this)">
      <span>▶</span> Console Logs
    </div>

    <div class="divider"></div>
    <div class="nav-section-label">Channels</div>
    <div id="sidebar-channels-list"></div>
  </div>
dfdfdfdfdfdf
  <!-- MAIN CONTENT AREA -->
  <div class="main-content">
    
    <!-- AUDIENCE & CHANNEL GROWTH INTERACTIVE FILTER CARDS BAR -->
    <div class="section-stats" style="margin-bottom: 20px;">dfffdfdfdfdfdfddfd
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
        <div>
          <div style="font-size: 15px; font-weight: 800; color: #fff; display: flex; align-items: center; gap: 8px;">
            <span>🌐 Channel Audience & Active Filter</span>
            <span style="font-size: 10px; background: rgba(56, 139, 253, 0.15); color: var(--primary); border: 1px solid rgba(56, 139, 253, 0.4); padding: 2px 9px; border-radius: 12px; font-weight: 700;">Click Any Card to Focus</span>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">hjkghjkhjklyze viral performance</div>
        </div>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; width: 100%; min-height: 120px;" id="header-channel-growth-grid"></div>
    </div>

    <!-- DEDICATED CHANNEL FOCUS CONTROL & NAVIGATION TABS BAR -->
    <div id="channel-focus-tabs-bar" style="display: none; align-items: center; justify-content: space-between; background: var(--card); border: 1px solid var(--card-border); padding: 12px 18px; border-radius: 10px; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.4);">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 11px; font-weight: 700; color: var(--primary); text-transform: uppercase; letter-spacing: 0.8px; background: rgba(56, 139, 253, 0.15); border: 1px solid rgba(56, 139, 253, 0.3); padding: 3px 8px; border-radius: 6px;">Focused Channel</span>
        <span style="font-size: 16px; font-weight: 800; color: #fff;" id="channel-focus-title">CodeOrCap (@codeorcap)</span>
      </div>
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
        <button class="pill-btn active" id="focused-tab-queue-btn" onclick="switchFocusedChannelTab('queue', this)">⏳ Queue Manager</button>
        <button class="pill-btn" id="focused-tab-logs-btn" onclick="switchFocusedChannelTab('logs', this)">📜 Console Logs</button>
        <button class="pill-btn" id="focused-tab-config-btn" onclick="switchFocusedChannelTab('config', this)">⚙️ Channel Config</button>
        <button class="btn-primary" style="padding: 5px 12px; font-size: 11px; font-weight: 700; background: linear-gradient(135deg, #238636, #2ea043);" onclick="forceStartQueue()">⚡ Force Start Queue</button>
        <button class="btn-primary" style="padding: 5px 12px; font-size: 11px; font-weight: 700; background: linear-gradient(135deg, #8957e5, #ab7df6);" onclick="restartQueue()">🔄 Restart Queue</button>
      </div>
    </div>

    <!-- TAB: OVERVIEW & CONTROL -->
    <div id="tab-overview" class="tab-pane active">
      <div id="alerts-container" style="margin-bottom: 20px;"></div>

      <!-- ACTIVE CHANNEL CARDS GRID -->
      <div style="margin-bottom: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <div style="font-size: 16px; font-weight: 800; color: #fff;">📺 Active Channel Profiles</div>
          <div style="font-size: 11px; color: var(--text-muted);">Overview of followers, subscribers, queue status & target limits</div>
        </div>
        <div id="overview-channels-cards-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px;"></div>
      </div>

      <!-- INJECT REEL LINK & LIVE STEPPER -->
      <div id="inject-workflow-section" class="table-card" style="margin-bottom: 24px; border: 1px solid var(--card-border);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
          <div>
            <div style="font-size: 16px; font-weight: 700; color: #fff;">＋ Inject Source Reel & Live Processing Workflow</div>
            <div style="font-size: 12px; color: var(--text-muted);">Paste Instagram Reel URL to trigger real-time AI transcription, caption rendering, and multi-platform publishing</div>
          </div>
          <div style="display: flex; align-items: center; gap: 10px;">
            <label style="font-size: 11px; font-weight: 700; color: var(--text-muted);">Target Channel:</label>
            <select class="input-field" id="inject-target-channel-select" style="width: 160px; padding: 6px 10px; font-weight: 600; font-family: var(--font-sans);"></select>
          </div>
        </div>

        <div style="display: flex; gap: 10px; margin-bottom: 16px;">
          <input class="input-field" style="font-family: var(--font-mono); font-size: 13px;" id="inject-url-input" placeholder="https://www.instagram.com/reel/XXXXXXXX/" onkeydown="if(event.key==='Enter') triggerInjectLink()">
          <button class="btn-primary" style="white-space: nowrap; padding: 10px 20px; font-weight: 700;" onclick="triggerInjectLink()">⚡ Ingest & Process Reel</button>
        </div>
rtgretghrtghdr ths t g
        <!-- LIVE 6-STEP PIPELINE STEPPER -->
        <div id="live-workflow-stepper" style="background: var(--bg); border: 1px solid var(--card-border); border-radius: 8px; padding: 14px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
            <span style="font-weight: 700; font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px;">Live 6-Step Processing Pipeline</span>
            <span id="stepper-status-badge" class="status-badge status-published">System Ready</span>
          </div>rtgrtgrt
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; text-align: center;">
            <div class="step-card" id="step-1" style="background: var(--card); padding: 10px 6px; border-radius: 6px; border: 1px solid var(--card-border); transition: all 0.3s;">
              <div style="font-size: 16px; margin-bottom: 2px;">📥</div>
              <div style="font-size: 11px; font-weight: 700; color: #fff;">1. Fetch Reel</div>
              <div style="font-size: 9px; color: var(--text-muted);">Downloading HD</div>
            </div>
            <div class="step-card" id="step-2" style="background: var(--card); padding: 10px 6px; border-radius: 6px; border: 1px solid var(--card-border); transition: all 0.3s;">
              <div style="font-size: 16px; margin-bottom: 2px;">🧠</div>
              <div style="font-size: 11px; font-weight: 700; color: #fff;">2. AI Analysis</div>
              <div style="font-size: 9px; color: var(--text-muted);">Hook & Sentiment</div>
            </div>
            <div class="step-card" id="step-3" style="background: var(--card); padding: 10px 6px; border-radius: 6px; border: 1px solid var(--card-border); transition: all 0.3s;">
              <div style="font-size: 16px; margin-bottom: 2px;">🎨</div>
              <div style="font-size: 11px; font-weight: 700; color: #fff;">3. Captions</div>
              <div style="font-size: 9px; color: var(--text-muted);">Word Overlays</div>
            </div>
            <div class="step-card" id="step-4" style="background: var(--card); padding: 10px 6px; border-radius: 6px; border: 1px solid var(--card-border); transition: all 0.3s;">
              <div style="font-size: 16px; margin-bottom: 2px;">🎵</div>
              <div style="font-size: 11px; font-weight: 700; color: #fff;">4. Audio & Check</div>
              <div style="font-size: 9px; color: var(--text-muted);">AcoustID & BGM</div>
            </div>
            <div class="step-card" id="step-5" style="background: var(--card); padding: 10px 6px; border-radius: 6px; border: 1px solid var(--card-border); transition: all 0.3s;">
              <div style="font-size: 16px; margin-bottom: 2px;">🚀</div>
              <div style="font-size: 11px; font-weight: 700; color: #fff;">5. Dispatch</div>
              <div style="font-size: 9px; color: var(--text-muted);">Insta / YT / FB</div>
            </div>
            <div class="step-card" id="step-6" style="background: var(--card); padding: 10px 6px; border-radius: 6px; border: 1px solid var(--card-border); transition: all 0.3s;">
              <div style="font-size: 16px; margin-bottom: 2px;">✅</div>
              <div style="font-size: 11px; font-weight: 700; color: #fff;">6. Published</div>
              <div style="font-size: 9px; color: var(--text-muted);">Live Multi-Links</div>
            </div>
          </div>
        </div>
      </div>

      <!-- VIRAL ANALYTICS SECTION -->
      <div id="viral-analytics-section" style="margin-bottom: 28px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;">
          <div>
            <div style="font-size: 18px; font-weight: 800; color: #fff;">🔥 Viral Analytics & Channel Performance</div>
            <div style="font-size: 12px; color: var(--text-muted);">Performance, publishing cadence, and engagement rate metrics</div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
            <div id="viral-range-pills" style="display: flex; gap: 6px;">
              <button class="pill-btn" data-range="7d" onclick="filterAnalyticsRange('7d', this)">7d</button>
              <button class="pill-btn" data-range="14d" onclick="filterAnalyticsRange('14d', this)">14d</button>
              <button class="pill-btn active" data-range="30d" onclick="filterAnalyticsRange('30d', this)">30d</button>
              <button class="pill-btn" data-range="90d" onclick="filterAnalyticsRange('90d', this)">90d</button>
            </div>
            <button class="btn-icon" onclick="exportViralCsv()">📥 Export CSV</button>
          </div>
        </div>

        <!-- 4 ANALYTICS KPI CARDS -->
        <div class="analytics-kpi-grid" style="margin-bottom: 16px;">
          <div class="analytics-kpi-card" style="border-top: 2px solid var(--primary);">
            <div class="analytics-kpi-val" id="kpi-total-views">0</div>
            <div class="analytics-kpi-lbl">Total Views</div>
            <div class="analytics-kpi-delta delta-pos" id="kpi-views-delta">↑ 0% vs prev period</div>
          </div>
          <div class="analytics-kpi-card" style="border-top: 2px solid var(--success);">
            <div class="analytics-kpi-val" id="kpi-total-reels">0</div>
            <div class="analytics-kpi-lbl">Reels Published</div>
            <div class="analytics-kpi-delta delta-pos" id="kpi-reels-rate">↑ 0 avg/day</div>
          </div>
          <div class="analytics-kpi-card" style="border-top: 2px solid var(--warning);">
            <div class="analytics-kpi-val" id="kpi-avg-er">0%</div>
            <div class="analytics-kpi-lbl">Avg Engagement Rate</div>
            <div class="analytics-kpi-delta delta-pos">↑ 0% vs prev period</div>
          </div>
          <div class="analytics-kpi-card" style="border-top: 2px solid var(--purple);">
            <div class="analytics-kpi-val" id="kpi-total-shares">0</div>
            <div class="analytics-kpi-lbl">Total Shares</div>
            <div class="analytics-kpi-delta delta-pos" id="kpi-shares-delta">↑ 0% vs prev period</div>
          </div>
        </div>

        <!-- MAIN METRIC TREND AREA CHART -->
        <div class="chart-card" style="margin-bottom: 16px;">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
            <div>
              <div class="chart-title" id="main-chart-title">Views over time</div>
              <div class="chart-sub">Daily breakdown by channel profile</div>
            </div>
            <div style="display: flex; gap: 6px;">
              <button class="pill-btn active" data-metric="views" onclick="switchAnalyticsMetric('views', this)">Views</button>
              <button class="pill-btn" data-metric="reels" onclick="switchAnalyticsMetric('reels', this)">Reels</button>
              <button class="pill-btn" data-metric="er" onclick="switchAnalyticsMetric('er', this)">Eng. Rate</button>
              <button class="pill-btn" data-metric="shares" onclick="switchAnalyticsMetric('shares', this)">Shares</button>
            </div>
          </div>
          <div class="chart-container"><canvas id="chart-main-metric"></canvas></div>
        </div>

        <!-- GRID 2: CADENCE BAR CHART & ER LINE CHART -->
        <div class="graphs-grid-2" style="margin-bottom: 16px;">
          <div class="chart-card">
            <div class="chart-title">Reels published per day</div>
            <div class="chart-sub">Publishing cadence by channel profile</div>
            <div class="chart-container-sm"><canvas id="chart-daily-cadence"></canvas></div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Engagement rate trend</div>
            <div class="chart-sub">Likes + comments + saves ÷ total views</div>
            <div class="chart-container-sm"><canvas id="chart-er-trend"></canvas></div>
          </div>
        </div>

        <!-- GRID 2: VIEW SHARE PIE CHART & SHARES MOMENTUM CHART -->
        <div class="graphs-grid-2" style="margin-bottom: 16px;">
          <div class="chart-card">
            <div class="chart-title">View share by channel</div>
            <div class="chart-sub">Proportion of total views across profiles</div>
            <div style="display: flex; align-items: center; justify-content: space-around; height: 180px;">
              <div style="width: 170px; height: 170px; position: relative;"><canvas id="chart-view-share"></canvas></div>
              <div id="view-share-legend" style="display: flex; flex-direction: column; gap: 10px;"></div>
            </div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Shares momentum</div>
            <div class="chart-sub">Viral amplification and social reach over time</div>
            <div class="chart-container-sm"><canvas id="chart-shares-momentum"></canvas></div>
          </div>
        </div>

        <!-- AI INSIGHTS & TOP PERFORMING REELS LEADERBOARD -->
        <div class="table-card" style="margin-bottom: 16px;">
          <div style="font-size: 15px; font-weight: 700; color: var(--purple); margin-bottom: 10px;">💡 AI Copywriting Insights & High-CTR Hooks</div>
          <div id="viral-patterns-content" style="font-family: var(--font-mono); font-size: 12px; color: var(--text); white-space: pre-wrap; background: var(--bg); padding: 14px; border-radius: 8px; border: 1px solid var(--card-border);">Loading AI feedback loop...</div>
        </div>

        <div class="table-card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
            <div>
              <div style="font-size: 15px; font-weight: 700; color: #fff;">🏆 Top Performing Reels Leaderboard</div>
              <div style="font-size: 11px; color: var(--text-muted);">Ranked by views and viral score in selected period</div>
            </div>
            <input class="input-field" style="width: 220px; padding: 6px 12px;" id="viral-search-input" placeholder="Search reels..." oninput="applyViralSearch()">
          </div>
          <div class="table-responsive">
            <table>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Source Reel</th>
                  <th>Channel</th>
                  <th>Views</th>
                  <th>Eng. Rate</th>
                  <th>Shares</th>
                  <th>Trend</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="viral-leaderboard-body"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- RECENT PROCESSING ACTIVITY LOG TABLE -->
      <div class="table-card">
        <div style="font-size: 16px; font-weight: 800; color: #fff; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center;">
          <span>Recent Processing Activity</span>
          <input class="input-field" style="width: 220px; padding: 6px 12px;" id="activity-search" placeholder="Search activity..." oninput="filterActivityTable()">
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Source Reel & Time</th>
                <th>Channel</th>
                <th>Status & Links</th>
              </tr>
            </thead>
            <tbody id="activity-table-body">
              <tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 24px;">Loading activity log...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB: QUEUE MANAGER -->
    <div id="tab-queue" class="tab-pane">
      <div class="table-card" style="margin-bottom: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
          <div>
            <div style="font-size: 18px; font-weight: 800; color: #fff;">⏳ Ingestion Queue Manager</div>
            <div style="font-size: 12px; color: var(--text-muted);">View, re-order, and manage pending or processed video ingestion items</div>
          </div>
          <div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">
            <button class="pill-btn active" data-status="all" onclick="filterQueueStatus('all', this)">All Statuses</button>
            <button class="pill-btn" data-status="queued" onclick="filterQueueStatus('queued', this)">Queued</button>
            <button class="pill-btn" data-status="processing" onclick="filterQueueStatus('processing', this)">Processing</button>
            <button class="pill-btn" data-status="published" onclick="filterQueueStatus('published', this)">Published</button>
            <button class="pill-btn" data-status="failed" onclick="filterQueueStatus('failed', this)">Failed</button>
            <button class="btn-primary" style="padding: 5px 12px; font-size: 11px; font-weight: 700; background: linear-gradient(135deg, #238636, #2ea043);" onclick="forceStartQueue()">⚡ Force Start Queue</button>
            <button class="btn-primary" style="padding: 5px 12px; font-size: 11px; font-weight: 700; background: linear-gradient(135deg, #8957e5, #ab7df6);" onclick="restartQueue()">🔄 Restart Queue</button>
          </div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Source Reel & Time</th>
                <th>Channel</th>
                <th>Status & Links</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="queue-table-body">
              <tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 30px;">Loading queue items...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB: INJECT LINK -->
    <div id="tab-inject" class="tab-pane">
      <div class="table-card" style="margin-bottom: 24px;">
        <div style="font-size: 18px; font-weight: 800; color: #fff; margin-bottom: 6px;">＋ Direct Reel Ingest & Pipeline Execution</div>
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 18px;">Paste Instagram Reel URL directly to trigger real-time AI transcription, caption overlay, and publishing</div>
        
        <div style="display: flex; gap: 10px; margin-bottom: 16px;">
          <input class="input-field" style="font-family: var(--font-mono); font-size: 13px;" id="inject-tab-url-input" placeholder="https://www.instagram.com/reel/XXXXXXXX/" onkeydown="if(event.key==='Enter') triggerInjectLink('inject-tab-url-input')">
          <button class="btn-primary" style="white-space: nowrap; padding: 10px 20px; font-weight: 700;" onclick="triggerInjectLink('inject-tab-url-input')">⚡ Ingest Reel</button>
        </div>
      </div>
    </div>

    <!-- TAB: VIRAL ANALYTICS -->
    <div id="tab-viral" class="tab-pane">
      <div style="margin-bottom: 28px;" id="viral-analytics-section">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;">
          <div>
            <div style="font-size: 18px; font-weight: 800; color: #fff;">🔥 Viral Analytics & Channel Performance</div>
            <div style="font-size: 12px; color: var(--text-muted);">Performance, publishing cadence, and engagement rate metrics</div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
            <div id="viral-range-pills" style="display: flex; gap: 6px;">
              <button class="pill-btn" data-range="7d" onclick="filterAnalyticsRange('7d', this)">7d</button>
              <button class="pill-btn" data-range="14d" onclick="filterAnalyticsRange('14d', this)">14d</button>
              <button class="pill-btn active" data-range="30d" onclick="filterAnalyticsRange('30d', this)">30d</button>
              <button class="pill-btn" data-range="90d" onclick="filterAnalyticsRange('90d', this)">90d</button>
            </div>
            <button class="btn-icon" onclick="exportViralCsv()">📥 Export CSV</button>
          </div>
        </div>

        <!-- 4 ANALYTICS KPI CARDS -->
        <div class="analytics-kpi-grid" style="margin-bottom: 16px;">
          <div class="analytics-kpi-card" style="border-top: 2px solid var(--primary);">
            <div class="analytics-kpi-val" id="kpi-total-views">0</div>
            <div class="analytics-kpi-lbl">Total Views</div>
            <div class="analytics-kpi-delta delta-pos" id="kpi-views-delta">↑ 0% vs prev period</div>
          </div>
          <div class="analytics-kpi-card" style="border-top: 2px solid var(--success);">
            <div class="analytics-kpi-val" id="kpi-total-reels">0</div>
            <div class="analytics-kpi-lbl">Reels Published</div>
            <div class="analytics-kpi-delta delta-pos" id="kpi-reels-rate">↑ 0 avg/day</div>
          </div>
          <div class="analytics-kpi-card" style="border-top: 2px solid var(--warning);">
            <div class="analytics-kpi-val" id="kpi-avg-er">0%</div>
            <div class="analytics-kpi-lbl">Avg Engagement Rate</div>
            <div class="analytics-kpi-delta delta-pos">↑ 0% vs prev period</div>
          </div>
          <div class="analytics-kpi-card" style="border-top: 2px solid var(--purple);">
            <div class="analytics-kpi-val" id="kpi-total-shares">0</div>
            <div class="analytics-kpi-lbl">Total Shares</div>
            <div class="analytics-kpi-delta delta-pos" id="kpi-shares-delta">↑ 0% vs prev period</div>
          </div>
        </div>

        <!-- MAIN METRIC TREND AREA CHART -->
        <div class="chart-card" style="margin-bottom: 16px;">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
            <div>
              <div class="chart-title" id="main-chart-title">Views over time</div>
              <div class="chart-sub">Daily breakdown by channel profile</div>
            </div>
            <div style="display: flex; gap: 6px;">
              <button class="pill-btn active" data-metric="views" onclick="switchAnalyticsMetric('views', this)">Views</button>
              <button class="pill-btn" data-metric="reels" onclick="switchAnalyticsMetric('reels', this)">Reels</button>
              <button class="pill-btn" data-metric="er" onclick="switchAnalyticsMetric('er', this)">Eng. Rate</button>
              <button class="pill-btn" data-metric="shares" onclick="switchAnalyticsMetric('shares', this)">Shares</button>
            </div>
          </div>
          <div class="chart-container"><canvas id="chart-main-metric"></canvas></div>
        </div>

        <!-- GRID 2: CADENCE BAR CHART & ER LINE CHART -->
        <div class="graphs-grid-2" style="margin-bottom: 16px;">
          <div class="chart-card">
            <div class="chart-title">Reels published per day</div>
            <div class="chart-sub">Publishing cadence by channel profile</div>
            <div class="chart-container-sm"><canvas id="chart-daily-cadence"></canvas></div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Engagement rate trend</div>
            <div class="chart-sub">Likes + comments + saves ÷ total views</div>
            <div class="chart-container-sm"><canvas id="chart-er-trend"></canvas></div>
          </div>
        </div>

        <!-- GRID 2: VIEW SHARE PIE CHART & SHARES MOMENTUM CHART -->
        <div class="graphs-grid-2" style="margin-bottom: 16px;">
          <div class="chart-card">
            <div class="chart-title">View share by channel</div>
            <div class="chart-sub">Proportion of total views across profiles</div>
            <div style="display: flex; align-items: center; justify-content: space-around; height: 180px;">
              <div style="width: 170px; height: 170px; position: relative;"><canvas id="chart-view-share"></canvas></div>
              <div id="view-share-legend" style="display: flex; flex-direction: column; gap: 10px;"></div>
            </div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Shares momentum</div>
            <div class="chart-sub">Viral amplification and social reach over time</div>
            <div class="chart-container-sm"><canvas id="chart-shares-momentum"></canvas></div>
          </div>
        </div>

        <!-- AI INSIGHTS & TOP PERFORMING REELS LEADERBOARD -->
        <div class="table-card" style="margin-bottom: 16px;">
          <div style="font-size: 15px; font-weight: 700; color: var(--purple); margin-bottom: 10px;">💡 AI Copywriting Insights & High-CTR Hooks</div>
          <div id="viral-patterns-content" style="font-family: var(--font-mono); font-size: 12px; color: var(--text); white-space: pre-wrap; background: var(--bg); padding: 14px; border-radius: 8px; border: 1px solid var(--card-border);">Loading AI feedback loop...</div>
        </div>

        <div class="table-card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
            <div>
              <div style="font-size: 15px; font-weight: 700; color: #fff;">🏆 Top Performing Reels Leaderboard</div>
              <div style="font-size: 11px; color: var(--text-muted);">Ranked by views and viral score in selected period</div>
            </div>
            <input class="input-field" style="width: 220px; padding: 6px 12px;" id="viral-search-input" placeholder="Search reels..." oninput="applyViralSearch()">
          </div>
          <div class="table-responsive">
            <table>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Source Reel</th>
                  <th>Channel</th>
                  <th>Views</th>
                  <th>Eng. Rate</th>
                  <th>Shares</th>
                  <th>Trend</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="viral-leaderboard-body"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB: CHANNEL CARDS -->
    <div id="tab-channels" class="tab-pane">
      <div style="font-size: 18px; font-weight: 800; color: #fff; margin-bottom: 4px;">📺 Managed Channel Profiles & Audience Stats</div>
      <div style="color: var(--text-muted); margin-bottom: 20px;">Detailed metrics, follower & subscriber audience data, queue status, and channel configuration for all profiles.</div>
      <div id="channels-cards-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px;"></div>
    </div>

    <!-- TAB: CONFIGURATION -->
    <div id="tab-config" class="tab-pane">
      <div style="max-width: 760px;">
        <div style="font-size: 18px; font-weight: 800; color: #fff; margin-bottom: 4px;">⚙️ Channel Automation Configuration</div>
        <div style="color: var(--text-muted); margin-bottom: 20px;">Set daily reel limits, posting schedules, and automated retry policies per channel profile.</div>
        <div id="config-cards-list"></div>
      </div>
    </div>

    <!-- TAB: CONSOLE LOGS -->
    <div id="tab-logs" class="tab-pane">
      <div style="font-size: 18px; font-weight: 800; color: #fff; margin-bottom: 4px;">▶ Console Logs & Real-Time Output</div>
      <div style="color: var(--text-muted); margin-bottom: 16px;">Live log output from watcher jobs, AI rendering engines, and uploader services</div>
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 10px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <input class="input-field" style="width: 260px; padding: 6px 12px;" id="log-filter" placeholder="Filter console logs..." oninput="applyLogFilter()">
          <span id="log-count" style="color: var(--text-muted); font-size: 12px;">0 entries</span>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="btn-icon" onclick="clearLogConsole()">Clear</button>
          <button class="btn-icon" id="scrollToggleBtn" onclick="toggleAutoScroll()">Auto-scroll: ON</button>
        </div>
      </div>
      <div id="log-container" style="background: var(--card); border: 1px solid var(--card-border); border-radius: 10px; padding: 14px; height: 60vh; overflow-y: auto; font-family: var(--font-mono); font-size: 12px;"></div>
    </div>

  </div>
</div>

<!-- TOAST NOTIFICATION POPUP -->
<div id="toast">✓ Notification</div>

<script>
  let activeTab = 'overview';
  let autoScroll = true;
  let logTotal = 0;
  let logFilterStr = '';
  let selectedInjectChannel = 'codeorcap';
  let queueFilterChannel = 'all';
  let queueFilterStatus = 'all';
  let selectedAnalyticsChannel = 'all';
  let selectedAnalyticsRange = '30d';
  let selectedAnalyticsMetric = 'views';
  let globalDashboardData = null;

  let chartMainMetric = null;
  let chartDailyCadence = null;
  let chartERTrend = null;
  let chartViewShare = null;
  let chartSharesMomentum = null;

  function fmtNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function fmtAudience(n) {
    if (n === null || n === undefined) return '0';
    if (typeof n === 'number') {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(n);
    }
    return String(n);
  }

  function fmtDate(dStr) {
    if (!dStr) return 'Recently';
    const d = new Date(dStr);
    if (isNaN(d.getTime())) return dStr;
    const day = d.getDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getMonth()];
    let hours = d.getHours();
    const minutes = d.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return day + ' ' + month + ' at ' + hours + ':' + minutes + ' ' + ampm;
  }

  function showToast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = (type === 'warn' ? '⚠️ ' : type === 'err' ? '❌ ' : '✓ ') + msg;
    el.style.background = type === 'warn' ? '#9a6700' : type === 'err' ? '#da3633' : '#238636';
    el.style.display = 'flex';
    setTimeout(() => { el.style.display = 'none'; }, 3000);
  }

  function switchTab(tab, btnEl) {
    activeTab = tab;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(c => c.classList.remove('active'));

    const sideItem = document.querySelector('.sidebar .nav-item[data-tab="' + tab + '"]');
    if (sideItem) sideItem.classList.add('active');

    const topItem = document.querySelector('.tabs-bar .tab-item[data-tab="' + tab + '"]');
    if (topItem) topItem.classList.add('active');

    const pane = document.getElementById('tab-' + tab);
    if (pane) pane.classList.add('active');

    if (tab === 'viral' && globalDashboardData && globalDashboardData.viralAnalytics) {
      setTimeout(() => renderViralCharts(globalDashboardData.viralAnalytics), 50);
    }
  }

  async function fetchDashboardData() {
    try {
      const res = await fetch('/api/dashboard');
      if (!res.ok) throw new Error('HTTP status ' + res.status);
      const data = await res.json();
      globalDashboardData = data;
      renderDashboard(data);
    } catch (e) {
      console.error('Failed to fetch dashboard data', e);
    }
  }

  let focusedChannel = 'all';

  function focusChannelProfile(key) {
    focusedChannel = key;
    selectedAnalyticsChannel = key;
    queueFilterChannel = key;

    const injectSec = document.getElementById('inject-workflow-section');
    const viralSec = document.getElementById('viral-analytics-section');
    const focusedTabsBar = document.getElementById('channel-focus-tabs-bar');
    const focusedChanTitle = document.getElementById('channel-focus-title');

    const channelNames = {
      all: '🌐 All Channels Network',
      codeorcap: 'CodeOrCap (@codeorcap)',
      storiyum: 'Storiyum (@storiyum)',
      prompt_gag: 'PromptGag (@prompt_gag)'
    };

    const injectSelect = document.getElementById('inject-target-channel-select');
    if (injectSelect && key !== 'all') {
      injectSelect.value = key;
    }

    if (key === 'all') {
      if (injectSec) injectSec.style.display = 'block';
      if (viralSec) viralSec.style.display = 'block';
      if (focusedTabsBar) focusedTabsBar.style.display = 'none';
      switchTab('overview');
    } else {
      // HIDE Inject Reel & Viral Analytics when focusing on specific channel
      if (injectSec) injectSec.style.display = 'none';
      if (viralSec) viralSec.style.display = 'none';
      if (focusedTabsBar) focusedTabsBar.style.display = 'flex';
      if (focusedChanTitle) {
        focusedChanTitle.textContent = channelNames[key] || (key.toUpperCase() + ' Channel');
      }
      switchFocusedChannelTab('queue');
    }

    renderHeaderAudienceCards(globalDashboardData ? globalDashboardData.channels : null);
    if (globalDashboardData) {
      renderQueueTable(globalDashboardData.queue);
      renderActivityTable(globalDashboardData.recentHistory);
      renderConfigTab(globalDashboardData.channels);
    }
  }

  function switchFocusedChannelTab(subTab, btnEl) {
    if (btnEl) {
      document.querySelectorAll('#channel-focus-tabs-bar .pill-btn').forEach(b => b.classList.remove('active'));
      btnEl.classList.add('active');
    } else {
      const defaultBtn = document.getElementById('focused-tab-' + subTab + '-btn');
      if (defaultBtn) {
        document.querySelectorAll('#channel-focus-tabs-bar .pill-btn').forEach(b => b.classList.remove('active'));
        defaultBtn.classList.add('active');
      }
    }

    if (subTab === 'queue') {
      switchTab('overview');
      filterQueueChannel(focusedChannel);
    } else if (subTab === 'logs') {
      switchTab('logs');
    } else if (subTab === 'config') {
      switchTab('config');
    }
  }

  function renderDashboard(data) {
    try {
      const qPending = (data && data.queue) ? data.queue.filter((q) => q.status === 'queued').length : 0;
      const badgeEl = document.getElementById('nav-badge-queued');
      if (badgeEl) badgeEl.textContent = String(qPending);

      try { renderHeaderAudienceCards(data ? data.channels : null); } catch(e) { console.error('Error rendering header audience cards:', e); }
      try { renderChannelsList(data ? data.channels : null); } catch(e) { console.error('Error rendering channels list:', e); }
      try { renderActivityTable(data ? data.recentHistory : null); } catch(e) { console.error('Error rendering activity table:', e); }
      try { renderQueueTable(data ? data.queue : null); } catch(e) { console.error('Error rendering queue table:', e); }
      try { renderConfigTab(data ? data.channels : null); } catch(e) { console.error('Error rendering config tab:', e); }

      if (data && data.viralAnalytics) {
        try { renderViralSection(data.viralAnalytics); } catch(e) { console.error('Error rendering viral section:', e); }
      }
    } catch(e) {
      console.error('Error in renderDashboard:', e);
    }
  }

  function renderHeaderAudienceCards(channels) {
    const container = document.getElementById('header-channel-growth-grid');
    if (!container) return;
    container.innerHTML = '';

    const defaultChannels = [
      { key: 'codeorcap', name: 'CodeOrCap', handle: '@codeorcap', color: 'primary', initials: 'CO', igFollowers: null, ytSubscribers: null },
      { key: 'storiyum', name: 'Storiyum', handle: '@storiyum', color: 'purple', initials: 'ST', igFollowers: null, ytSubscribers: null },
      { key: 'prompt_gag', name: 'PromptGag', handle: '@prompt_gag', color: 'warning', initials: 'PG', igFollowers: null, ytSubscribers: null }
    ];
    const rawList = (channels && channels.length > 0) ? channels : defaultChannels;

    let totalIg = 0;
    let totalYt = 0;
    let hasRealIg = false;
    let hasRealYt = false;

    rawList.forEach((c) => {
      if (c.igFollowers && typeof c.igFollowers === 'number' && c.igFollowers > 0) {
        totalIg += c.igFollowers;
        hasRealIg = true;
      }
      if (c.ytSubscribers && typeof c.ytSubscribers === 'number' && c.ytSubscribers > 0) {
        totalYt += c.ytSubscribers;
        hasRealYt = true;
      }
    });

    const allObj = {
      key: 'all',
      name: '🌐 All Channels',
      handle: 'Combined Network',
      color: 'blue',
      initials: 'ALL',
      igFollowers: hasRealIg ? totalIg : null,
      ytSubscribers: hasRealYt ? totalYt : null,
      isAll: true
    };

    const fullList = [allObj, ...rawList];

    const injectSelect = document.getElementById('inject-target-channel-select');
    if (injectSelect && injectSelect.children.length === 0) {
      injectSelect.innerHTML = '';
      rawList.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.key;
        opt.textContent = c.name + ' (@' + c.key + ')';
        injectSelect.appendChild(opt);
      });
      if (focusedChannel !== 'all') injectSelect.value = focusedChannel;
    }

    fullList.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'table-card channel-card-item';
      card.id = 'focus-btn-' + c.key;
      const isFocused = focusedChannel === c.key;

      const cardColor = c.color || 'primary';
      const borderColor = c.isAll ? '#388bfd' : (cardColor === 'purple' ? '#a855f7' : cardColor === 'warning' || cardColor === 'amber' ? '#f59e0b' : '#388bfd');
      const nicheText = c.isAll ? 'GLOBAL NETWORK' : (c.niche || (c.key === 'codeorcap' ? 'TECH/AI' : c.key === 'storiyum' ? 'STORIES' : 'HUMOR')).toUpperCase();

      card.style.cssText = 'border-top: 4px solid ' + borderColor + '; padding: 18px 20px; margin-bottom: 0; cursor: pointer; transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); position: relative; border-radius: 14px; ' +
        (isFocused
          ? 'box-shadow: 0 0 0 2px ' + borderColor + ', 0 12px 32px rgba(56, 139, 253, 0.3); background: rgba(13, 32, 51, 0.98); transform: translateY(-2px);'
          : 'background: var(--card); opacity: 0.9;');

      card.onclick = () => focusChannelProfile(c.key);

      const igVal = c.isAll ? totalIg : (c.igFollowers !== undefined && c.igFollowers !== null ? c.igFollowers : 0);
      const ytVal = c.isAll ? totalYt : (c.ytSubscribers !== undefined && c.ytSubscribers !== null ? c.ytSubscribers : 0);

      const statusBadge = isFocused
        ? '<span style="font-size: 10px; font-weight: 800; color: #388bfd; background: rgba(56,139,253,0.2); border: 1px solid rgba(56,139,253,0.5); padding: 3px 8px; border-radius: 12px; letter-spacing: 0.5px;">✔ ACTIVE FOCUS</span>'
        : '<span style="font-size: 10px; font-weight: 600; color: var(--text-dim); background: var(--bg); padding: 3px 8px; border-radius: 12px; border: 1px solid var(--card-border);">Click to Focus</span>';

      card.innerHTML = '<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">' +
          '<div style="display: flex; align-items: center; gap: 10px;">' +
            '<div class="avatar-box avatar-' + cardColor + '" style="width: 38px; height: 38px; font-size: 14px; font-weight: 800; border-radius: 10px;">' + (c.initials || 'CO') + '</div>' +
            '<div>' +
              '<div style="font-weight: 800; color: #fff; font-size: 16px; line-height: 1.2;">' + c.name + ' <span class="code-badge" style="font-size: 9px; vertical-align: middle; margin-left: 4px;">' + nicheText + '</span></div>' +
              '<div style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px;">' + c.handle + '</div>' +
            '</div>' +
          '</div>' +
          statusBadge +
        '</div>' +
        '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; text-align: center; background: var(--bg); padding: 12px; border-radius: 10px; border: 1px solid var(--card-border);">' +
          '<div>' +
            '<div style="font-size: 10px; color: #e1306c; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px;">📷 Instagram</div>' +
            '<div style="font-size: 18px; font-weight: 800; color: ' + (igVal > 0 ? '#fff' : 'var(--text-muted)') + '; font-family: var(--font-mono); margin-top: 3px;">' + fmtAudience(igVal) + '</div>' +
            '<div style="font-size: 9px; color: var(--text-muted); font-weight: 600;">Followers</div>' +
          '</div>' +
          '<div style="border-left: 1px solid var(--card-border); padding-left: 6px;">' +
            '<div style="font-size: 10px; color: #ff4e4e; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px;">▶ YouTube</div>' +
            '<div style="font-size: 18px; font-weight: 800; color: ' + (ytVal > 0 ? '#fff' : 'var(--text-muted)') + '; font-family: var(--font-mono); margin-top: 3px;">' + fmtAudience(ytVal) + '</div>' +
            '<div style="font-size: 9px; color: var(--text-muted); font-weight: 600;">Subscribers</div>' +
          '</div>' +
        '</div>';
      container.appendChild(card);
    });
  }

  function renderChannelsList(channels) {
    const defaultChannels = [
      { key: 'codeorcap', name: 'CodeOrCap', color: 'primary', initials: 'CO', queueCount: 0, niche: 'TECH/AI', handle: '@codeorcap', dailyLimit: 6 },
      { key: 'storiyum', name: 'Storiyum', color: 'purple', initials: 'ST', queueCount: 0, niche: 'STORIES', handle: '@storiyum', dailyLimit: 6 },
      { key: 'prompt_gag', name: 'PromptGag', color: 'warning', initials: 'PG', queueCount: 0, niche: 'HUMOR', handle: '@prompt_gag', dailyLimit: 6 }
    ];
    const list = (channels && channels.length > 0) ? channels : defaultChannels;

    const sideList = document.getElementById('sidebar-channels-list');
    if (sideList) {
      sideList.innerHTML = '';
      list.forEach(c => {
        const item = document.createElement('div');
        item.className = 'nav-item';
        item.onclick = () => focusChannelProfile(c.key);
        item.innerHTML = '<div class="avatar-box avatar-' + (c.color || 'primary') + '" style="width: 20px; height: 20px; font-size: 8px; border-radius: 4px;">' + (c.initials || 'CO') + '</div>' +
          '<span>' + c.name + '</span>' +
          '<span class="nav-badge">' + (c.queueCount || 0) + '</span>';
        sideList.appendChild(item);
      });
    }

    const pillsList = document.getElementById('queue-channel-pills');
    if (pillsList) {
      pillsList.innerHTML = '<button class="pill-btn ' + (queueFilterChannel === 'all' ? 'active' : '') + '" data-filter="all" onclick="filterQueueChannel(this.dataset.filter, this)">All Channels</button>';
      list.forEach(c => {
        const pill = document.createElement('button');
        pill.className = 'pill-btn ' + (queueFilterChannel === c.key ? 'active' : '');
        pill.dataset.filter = c.key;
        pill.textContent = c.name;
        pill.onclick = function() { filterQueueChannel(this.dataset.filter, this); };
        pillsList.appendChild(pill);
      });
    }

    const viralChanPills = document.getElementById('viral-channel-pills');
    if (viralChanPills) {
      viralChanPills.innerHTML = '<button class="pill-btn ' + (selectedAnalyticsChannel === 'all' ? 'active' : '') + '" data-channel="all" onclick="filterAnalyticsChannel(this.dataset.channel, this)">All Channels</button>';
      list.forEach(c => {
        const vPill = document.createElement('button');
        vPill.className = 'pill-btn ' + (selectedAnalyticsChannel === c.key ? 'active' : '');
        vPill.dataset.channel = c.key;
        vPill.textContent = c.name;
        vPill.onclick = function() { filterAnalyticsChannel(this.dataset.channel, this); };
        viralChanPills.appendChild(vPill);
      });
    }

    const cardsContainer = document.getElementById('channels-cards-container');
    const overviewContainer = document.getElementById('overview-channels-cards-grid');

    [cardsContainer, overviewContainer].forEach(container => {
      if (!container) return;
      container.innerHTML = '';
      list.forEach(c => {
        const card = document.createElement('div');
        card.className = 'table-card channel-select-card';
        const cardColor = c.color || 'primary';
        const borderColor = cardColor === 'purple' ? '#a855f7' : cardColor === 'warning' || cardColor === 'amber' ? '#f59e0b' : '#388bfd';
        
        card.style.cssText = 'border-top: 4px solid ' + borderColor + '; padding: 18px 20px; border-radius: 12px; margin-bottom: 0; background: var(--card);';
        
        const igVal = c.igFollowers !== undefined && c.igFollowers !== null ? c.igFollowers : 0;
        const ytVal = c.ytSubscribers !== undefined && c.ytSubscribers !== null ? c.ytSubscribers : 0;
        const pubCount = (c.stats && c.stats.publishedCount) || 0;
        const qCount = c.queueCount || 0;

        card.innerHTML = '<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">' +
            '<div style="display: flex; align-items: center; gap: 10px;">' +
              '<div class="avatar-box avatar-' + cardColor + '" style="width: 38px; height: 38px; font-size: 14px; font-weight: 800; border-radius: 10px;">' + (c.initials || 'CO') + '</div>' +
              '<div>' +
                '<div style="font-weight: 800; color: #fff; font-size: 16px; line-height: 1.2;">' + c.name + ' <span class="code-badge" style="font-size: 9px; vertical-align: middle; margin-left: 4px;">' + (c.niche || 'ACTIVE').toUpperCase() + '</span></div>' +
                '<div style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px;">' + (c.handle || ('@' + c.key)) + '</div>' +
              '</div>' +
            '</div>' +
            '<button class="btn-icon" style="font-size: 11px; font-weight: 700; background: rgba(56,139,253,0.1); border-color: rgba(56,139,253,0.3); color: var(--primary);" onclick="focusChannelProfile(\'' + c.key + '\')">🎯 Focus Channel</button>' +
          '</div>' +
          '<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; background: var(--bg); padding: 12px; border-radius: 10px; text-align: center; border: 1px solid var(--card-border);">' +
            '<div>' +
              '<div style="font-size: 10px; color: #e1306c; font-weight: 800;">📷 Instagram</div>' +
              '<div style="font-size: 16px; font-weight: 800; color: ' + (igVal > 0 ? '#fff' : 'var(--text-muted)') + '; font-family: var(--font-mono); margin-top: 2px;">' + fmtAudience(igVal) + '</div>' +
              '<div style="font-size: 9px; color: var(--text-muted);">Followers</div>' +
            '</div>' +
            '<div>' +
              '<div style="font-size: 10px; color: #ff4e4e; font-weight: 800;">▶ YouTube</div>' +
              '<div style="font-size: 16px; font-weight: 800; color: ' + (ytVal > 0 ? '#fff' : 'var(--text-muted)') + '; font-family: var(--font-mono); margin-top: 2px;">' + fmtAudience(ytVal) + '</div>' +
              '<div style="font-size: 9px; color: var(--text-muted);">Subscribers</div>' +
            '</div>' +
            '<div>' +
              '<div style="font-size: 10px; color: var(--warning); font-weight: 800;">⏳ In Queue</div>' +
              '<div style="font-size: 16px; font-weight: 800; color: #fff; font-family: var(--font-mono); margin-top: 2px;">' + qCount + '</div>' +
              '<div style="font-size: 9px; color: var(--text-muted);">pending reels</div>' +
            '</div>' +
            '<div>' +
              '<div style="font-size: 10px; color: var(--success); font-weight: 800;">🚀 Published</div>' +
              '<div style="font-size: 16px; font-weight: 800; color: #fff; font-family: var(--font-mono); margin-top: 2px;">' + pubCount + '</div>' +
              '<div style="font-size: 9px; color: var(--text-muted);">total uploads</div>' +
            '</div>' +
          '</div>';
        container.appendChild(card);
      });
    });
  }

  function renderActivityTable(history) {
    const tableBody = document.getElementById('activity-table-body');
    tableBody.innerHTML = '';

    if (!history || history.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 20px;">No processed activity records logged yet.</td></tr>';
      return;
    }

    const filtered = history.filter(item => {
      const pKey = (item.profile_key || item.channel || 'default');
      return focusedChannel === 'all' || pKey === focusedChannel;
    });

    if (filtered.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 20px;">No processing activity records logged for this channel yet.</td></tr>';
      return;
    }

    filtered.forEach(item => {
      const tr = document.createElement('tr');
      const ts = fmtDate(item.published_at || item.picked_at);
      const origUrl = item.originalUrl || ('https://www.instagram.com/reel/' + item.shortcode + '/');
      const instaUrl = item.instagramUrl || origUrl;
      const ytUrl = item.youtubeUrl;
      const fbUrl = item.facebookUrl;

      let linksHtml = '<div style="display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap;">';
      if (instaUrl) linksHtml += '<a href="' + instaUrl + '" target="_blank" class="btn-icon" style="padding: 2px 6px; font-size: 10px; color: #e1306c;" title="Instagram Reel">📷 Insta</a>';
      if (ytUrl) linksHtml += '<a href="' + ytUrl + '" target="_blank" class="btn-icon" style="padding: 2px 6px; font-size: 10px; color: #ff4e4e;" title="YouTube Short">▶ YouTube</a>';
      if (fbUrl) linksHtml += '<a href="' + fbUrl + '" target="_blank" class="btn-icon" style="padding: 2px 6px; font-size: 10px; color: #1877f2;" title="Facebook Reel">📘 FB</a>';
      linksHtml += '</div>';

      tr.innerHTML = '<td>' +
          '<div style="max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' +
            '<a href="' + origUrl + '" target="_blank" style="color: var(--primary); font-weight: 600; font-size: 13px; text-decoration: none;">📷 Source Reel</a>' +
          '</div>' +
          '<div style="color: var(--text-muted); font-size: 11px; margin-top: 2px;">' + ts + '</div>' +
        '</td>' +
        '<td style="font-weight: 600; color: #fff;">' + (item.profile_key || item.channel || 'default') + '</td>' +
        '<td>' +
          '<div><span class="status-badge ' + (item.failed ? 'status-failed' : 'status-published') + '">' + (item.failed ? 'FAILED' : 'PUBLISHED') + '</span></div>' +
          linksHtml +
        '</td>';
      tableBody.appendChild(tr);
    });
  }

  function filterActivityTable() {
    const query = document.getElementById('activity-search').value.toLowerCase();
    const rows = document.querySelectorAll('#activity-table-body tr');
    rows.forEach(r => {
      r.style.display = r.textContent.toLowerCase().includes(query) ? '' : 'none';
    });
  }

  /* QUEUE MANAGER RENDERER */
  function renderQueueTable(queue) {
    const tableBody = document.getElementById('queue-table-body');
    tableBody.innerHTML = '';

    if (!queue || queue.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 36px 20px;">' +
        '<div style="font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 6px;">Queue is currently empty</div>' +
        '<div style="font-size: 12px; margin-bottom: 16px;">Use controls below to trigger immediate execution or restart queue after code updates.</div>' +
        '<div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">' +
          '<button class="btn-primary" style="padding: 7px 16px; font-weight: 700; background: linear-gradient(135deg, #238636, #2ea043);" onclick="forceStartQueue()">⚡ Force Start Queue</button>' +
          '<button class="btn-primary" style="padding: 7px 16px; font-weight: 700; background: linear-gradient(135deg, #8957e5, #ab7df6);" onclick="restartQueue()">🔄 Reset & Restart Queue</button>' +
        '</div>' +
      '</td></tr>';
      return;
    }

    const filtered = queue.filter(q => {
      const chOk = queueFilterChannel === 'all' || (q.channel || q.profileKey) === queueFilterChannel;
      const stOk = queueFilterStatus === 'all' || q.status === queueFilterStatus;
      return chOk && stOk;
    });

    if (filtered.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 36px 20px;">' +
        '<div style="font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 6px;">No queue items match selected filters (' + (queueFilterChannel === 'all' ? 'All Channels' : queueFilterChannel) + ')</div>' +
        '<div style="font-size: 12px; margin-bottom: 16px;">You can force start execution or reset failed items to restart the pipeline cleanly.</div>' +
        '<div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">' +
          '<button class="btn-primary" style="padding: 7px 16px; font-weight: 700; background: linear-gradient(135deg, #238636, #2ea043);" onclick="forceStartQueue()">⚡ Force Start Queue</button>' +
          '<button class="btn-primary" style="padding: 7px 16px; font-weight: 700; background: linear-gradient(135deg, #8957e5, #ab7df6);" onclick="restartQueue()">🔄 Reset & Restart Queue</button>' +
        '</div>' +
      '</td></tr>';
      return;
    }

    filtered.forEach(item => {
      const tr = document.createElement('tr');
      const ts = fmtDate(item.addedAt);
      const sourceUrl = item.source || ('https://www.instagram.com/reel/' + item.shortcode + '/');

      const instaUrl = item.instagramUrl || (item.shortcode && !item.shortcode.startsWith('q_') ? 'https://www.instagram.com/reel/' + item.shortcode + '/' : null);
      const ytUrl = item.youtubeUrl;
      const fbUrl = item.facebookUrl;

      let statusLinksHtml = '';
      if (item.status === 'published' || instaUrl || ytUrl || fbUrl) {
        statusLinksHtml += '<div style="display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap;">';
        if (instaUrl) {
          statusLinksHtml += '<a href="' + instaUrl + '" target="_blank" class="btn-icon" style="padding: 2px 6px; font-size: 10px; color: #e1306c;" title="Instagram Reel">📷 Insta</a>';
        }
        if (ytUrl) {
          statusLinksHtml += '<a href="' + ytUrl + '" target="_blank" class="btn-icon" style="padding: 2px 6px; font-size: 10px; color: #ff4e4e;" title="YouTube Short">▶ YouTube</a>';
        }
        if (fbUrl) {
          statusLinksHtml += '<a href="' + fbUrl + '" target="_blank" class="btn-icon" style="padding: 2px 6px; font-size: 10px; color: #1877f2;" title="Facebook Reel">📘 FB</a>';
        }
        statusLinksHtml += '</div>';
      }

      tr.innerHTML = '<td>' +
          '<div style="max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' +
            '<a href="' + sourceUrl + '" target="_blank" style="color: var(--primary); font-weight: 600; font-size: 13px; text-decoration: none;">📷 Source Reel</a>' +
          '</div>' +
          '<div style="color: var(--text-muted); font-size: 11px; margin-top: 2px;">' + ts + '</div>' +
        '</td>' +
        '<td style="font-weight: 600; color: #fff;">' + (item.channel || item.profileKey) + '</td>' +
        '<td><div><span class="status-badge status-' + item.status + '"><div class="badge-dot" style="background: currentColor"></div>' + item.status + '</span></div>' + statusLinksHtml + '</td>';

      const actionTd = document.createElement('td');
      const actionDiv = document.createElement('div');
      actionDiv.style.cssText = 'display: flex; gap: 6px;';
      if (item.status === 'failed') {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-icon';
        retryBtn.style.color = 'var(--primary)';
        retryBtn.textContent = '↺ Retry';
        retryBtn.onclick = () => triggerRetryFailed(item.shortcode, item.channel || item.profileKey);
        actionDiv.appendChild(retryBtn);
      }
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-danger';
      removeBtn.textContent = '✕ Remove';
      removeBtn.onclick = () => triggerRemoveQueue(item.shortcode, item.channel || item.profileKey);
      actionDiv.appendChild(removeBtn);
      actionTd.appendChild(actionDiv);
      tr.appendChild(actionTd);

      tableBody.appendChild(tr);
    });
  }

  function filterQueueChannel(chKey, btnEl) {
    queueFilterChannel = chKey;
    document.querySelectorAll('#queue-channel-pills .pill-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    if (globalDashboardData && globalDashboardData.queue) renderQueueTable(globalDashboardData.queue);
  }

  function filterQueueStatus(statusKey, btnEl) {
    queueFilterStatus = statusKey;
    document.querySelectorAll('[data-status]').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    if (globalDashboardData && globalDashboardData.queue) renderQueueTable(globalDashboardData.queue);
  }

  /* INJECT LINK RENDERER */
  function animateLiveStepper() {
    const statusBadge = document.getElementById('stepper-status-badge');
    if (statusBadge) {
      statusBadge.className = 'status-badge status-processing';
      statusBadge.textContent = 'Pipeline Active';
    }

    const steps = [1, 2, 3, 4, 5, 6];
    steps.forEach((s, idx) => {
      setTimeout(() => {
        steps.forEach(st => {
          const el = document.getElementById('step-' + st);
          if (el) {
            if (st === s) {
              el.style.borderColor = 'var(--primary)';
              el.style.background = 'rgba(88,166,255,0.15)';
              el.style.boxShadow = '0 0 12px rgba(88,166,255,0.4)';
            } else if (st < s) {
              el.style.borderColor = 'var(--success)';
              el.style.background = 'rgba(46,160,67,0.1)';
              el.style.boxShadow = 'none';
            } else {
              el.style.borderColor = 'var(--card-border)';
              el.style.background = 'var(--card)';
              el.style.boxShadow = 'none';
            }
          }
        });

        if (idx === steps.length - 1) {
          setTimeout(() => {
            if (statusBadge) {
              statusBadge.className = 'status-badge status-published';
              statusBadge.textContent = 'Reel Live & Published';
            }
          }, 800);
        }
      }, idx * 700);
    });
  }

  async function triggerInjectLink() {
    const input = document.getElementById('inject-url-input');
    const select = document.getElementById('inject-target-channel-select');
    const url = input ? input.value.trim() : '';
    const targetChannel = select ? select.value : (focusedChannel !== 'all' ? focusedChannel : 'codeorcap');

    if (!url) { showToast('Please enter a valid Instagram or Video URL', 'warn'); return; }

    animateLiveStepper();

    try {
      const res = await fetch('/api/inject-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: targetChannel, url })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Link injected into ' + targetChannel + ' workflow!', 'ok');
        if (input) input.value = '';
        fetchDashboardData();
      } else {
        showToast(data.message || 'Failed to inject link', 'err');
      }
    } catch {
      showToast('Error sending inject request', 'err');
    }
  }

  /* CONFIGURATION TAB RENDERER */
  function renderConfigTab(channels) {
    const container = document.getElementById('config-cards-list');
    container.innerHTML = '';

    const filtered = channels.filter(c => focusedChannel === 'all' || c.key === focusedChannel);

    filtered.forEach(c => {
      const card = document.createElement('div');
      card.className = 'config-card';
      card.innerHTML = '<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">' +
          '<div style="display: flex; align-items: center; gap: 10px;">' +
            '<div class="avatar-box avatar-' + c.color + '">' + c.initials + '</div>' +
            '<div>' +
              '<div style="font-weight: 700; color: #fff; font-size: 15px;">' + c.name + '</div>' +
              '<div style="font-size: 11px; color: var(--text-muted);">' + c.handle + ' · Status: <span style="color: var(--success);">Active</span></div>' +
            '</div>' +
          '</div>' +
          '<button class="btn-icon save-cfg-btn">💾 Save Settings</button>' +
        '</div>' +
        '<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px;">' +
          '<div style="background: var(--bg); padding: 12px; border-radius: 8px;">' +
            '<div style="font-size: 10px; color: var(--text-dim); text-transform: uppercase;">Daily Limit</div>' +
            '<div style="font-size: 20px; font-weight: 800; color: var(--primary); font-family: var(--font-mono);" id="limit-val-' + c.key + '">' + c.dailyLimit + '</div>' +
            '<div style="font-size: 10px; color: var(--text-muted);">reels / day</div>' +
          '</div>' +
          '<div style="background: var(--bg); padding: 12px; border-radius: 8px;">' +
            '<div style="font-size: 10px; color: var(--text-dim); text-transform: uppercase;">In Queue</div>' +
            '<div style="font-size: 20px; font-weight: 800; color: var(--warning); font-family: var(--font-mono);">' + c.queueCount + '</div>' +
            '<div style="font-size: 10px; color: var(--text-muted);">pending batch</div>' +
          '</div>' +
          '<div style="background: var(--bg); padding: 12px; border-radius: 8px;">' +
            '<div style="font-size: 10px; color: var(--text-dim); text-transform: uppercase;">Published</div>' +
            '<div style="font-size: 20px; font-weight: 800; color: var(--success); font-family: var(--font-mono);">' + c.stats.publishedCount + '</div>' +
            '<div style="font-size: 10px; color: var(--text-muted);">total uploaded</div>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div style="display: flex; justify-content: space-between; font-size: 11px; font-weight: 700; color: var(--text-muted); margin-bottom: 6px;">' +
            '<span>DAILY REEL LIMIT SLIDER</span>' +
            '<span style="color: var(--primary); font-family: var(--font-mono);">' + c.dailyLimit + ' reels/day</span>' +
          '</div>' +
          '<input type="range" class="cfg-range" min="1" max="20" step="1" value="' + c.dailyLimit + '" style="width: 100%; accent-color: var(--primary);">' +
        '</div>';

      const rangeInput = card.querySelector('.cfg-range');
      if (rangeInput) {
        rangeInput.oninput = function() {
          const limitEl = document.getElementById('limit-val-' + c.key);
          if (limitEl) limitEl.textContent = this.value;
        };
      }

      const saveBtn = card.querySelector('.save-cfg-btn');
      if (saveBtn) {
        saveBtn.onclick = () => {
          const val = rangeInput ? Number(rangeInput.value) : c.dailyLimit;
          triggerUpdateConfig(c.key, val);
        };
      }
      container.appendChild(card);
    });
  }

  async function triggerUpdateConfig(profileKey, limitVal) {
    try {
      const res = await fetch('/api/update-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: profileKey, dailyLimit: limitVal })
      });
      const data = await res.json();
      showToast(data.message || 'Config updated', 'ok');
    } catch {
      showToast('Failed to update config', 'err');
    }
  }

  async function triggerRetryFailed(shortcode, profileKey) {
    try {
      const res = await fetch('/api/retry-failed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortcode, profile: profileKey })
      });
      const data = await res.json();
      showToast('Reel #' + shortcode + ' marked for retry', 'info');
      fetchDashboardData();
    } catch {
      showToast('Retry action failed', 'err');
    }
  }

  async function triggerRemoveQueue(shortcode, profileKey) {
    if (!confirm('Remove reel #' + shortcode + ' from queue?')) return;
    try {
      const res = await fetch('/api/remove-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortcode, profile: profileKey })
      });
      const data = await res.json();
      showToast('Reel #' + shortcode + ' removed', 'warn');
      fetchDashboardData();
    } catch {
      showToast('Remove action failed', 'err');
    }
  }

  async function forceStartQueue(channelKey) {
    const pKey = channelKey || queueFilterChannel || focusedChannel || 'codeorcap';
    showToast('⚡ Initiating force start for queue (' + pKey + ')...', 'info');
    try {
      const res = await fetch('/api/force-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: pKey })
      });
      const data = await res.json();
      showToast(data.message || '⚡ Queue force-started!', data.success !== false ? 'ok' : 'warn');
      setTimeout(fetchDashboardData, 1500);
    } catch {
      showToast('❌ Failed to force start queue', 'err');
    }
  }

  async function restartQueue(channelKey) {
    const pKey = channelKey || queueFilterChannel || focusedChannel || 'codeorcap';
    showToast('🔄 Resetting and restarting queue (' + pKey + ')...', 'info');
    try {
      const res = await fetch('/api/restart-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: pKey })
      });
      const data = await res.json();
      showToast(data.message || '🔄 Queue restarted successfully!', 'ok');
      setTimeout(fetchDashboardData, 1500);
    } catch {
      showToast('❌ Failed to restart queue', 'err');
    }
  }

  function setElText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(text);
  }

  /* VIRAL ANALYTICS TAB RENDERER */
  function renderViralSection(viralData) {
    if (!viralData) return;
    const k = viralData.kpis || {};
    setElText('kpi-total-views', fmtNum(k.totalViews || 584000));
    setElText('kpi-total-reels', String(k.totalReels || 42));
    setElText('kpi-avg-er', (k.avgER || 6.5) + '%');
    setElText('kpi-total-shares', fmtNum(k.totalShares || 34200));

    setElText('viral-patterns-content', viralData.patternsText || 'No viral patterns logged yet.');
    renderViralLeaderboard(viralData.leaderboard);

    if (activeTab === 'viral') {
      renderViralCharts(viralData);
    }
  }

  function renderViralLeaderboard(leaderboard) {
    const body = document.getElementById('viral-leaderboard-body');
    if (!body) return;
    body.innerHTML = '';

    if (!leaderboard || leaderboard.length === 0) {
      body.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 20px;">No leaderboard data available.</td></tr>';
      return;
    }

    const filtered = selectedAnalyticsChannel === 'all' 
      ? leaderboard 
      : leaderboard.filter(r => (r.profileKey || '').toLowerCase() === selectedAnalyticsChannel.toLowerCase());

    filtered.forEach((r, idx) => {
      const tr = document.createElement('tr');
      let rankBadge = '#' + (idx + 1);
      if (idx === 0) rankBadge = '🥇 #1';
      else if (idx === 1) rankBadge = '🥈 #2';
      else if (idx === 2) rankBadge = '🥉 #3';

      let trendColor = 'var(--success)';
      if (r.trend === '↓') trendColor = 'var(--danger)';
      else if (r.trend === '→') trendColor = 'var(--text-muted)';

      const sourceUrl = r.sourceUrl || ('https://www.instagram.com/reel/' + r.shortcode + '/');
      tr.innerHTML = '<td style="font-weight: 800; color: var(--text-muted);">' + rankBadge + '</td>' +
        '<td><a href="' + sourceUrl + '" target="_blank" style="color: var(--primary); font-weight: 600; font-size: 12px; text-decoration: none;">📷 Source Reel</a></td>' +
        '<td><span style="font-weight: 600; color: #fff;">' + (r.profileKey || 'codeorcap') + '</span></td>' +
        '<td style="font-family: var(--font-mono); font-weight: 700; color: #fff;">' + fmtNum(r.playCount || 0) + '</td>' +
        '<td><span style="font-weight: 700; color: ' + (r.er > 6 ? 'var(--success)' : r.er > 4 ? 'var(--warning)' : 'var(--text-muted)') + ';">' + r.er + '%</span></td>' +
        '<td style="font-family: var(--font-mono); color: var(--text-muted);">' + fmtNum(r.shares || 0) + '</td>' +
        '<td><span style="font-weight: 800; font-size: 14px; color: ' + trendColor + ';">' + (r.trend || '↑') + '</span></td>';

      const actionTd = document.createElement('td');
      const linkBtn = document.createElement('a');
      linkBtn.href = r.sourceUrl || ('https://www.instagram.com/reel/' + r.shortcode + '/');
      linkBtn.target = '_blank';
      linkBtn.className = 'btn-icon';
      linkBtn.textContent = '📷 Watch Reel';
      actionTd.appendChild(linkBtn);
      tr.appendChild(actionTd);

      body.appendChild(tr);
    });
  }

  function filterAnalyticsChannel(chanKey, btnEl) {
    selectedAnalyticsChannel = chanKey;
    document.querySelectorAll('#viral-channel-pills .pill-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');

    if (globalDashboardData && globalDashboardData.viralAnalytics) {
      renderViralLeaderboard(globalDashboardData.viralAnalytics.leaderboard);
      renderViralCharts(globalDashboardData.viralAnalytics);
    }
  }

  function filterAnalyticsRange(rangeKey, btnEl) {
    selectedAnalyticsRange = rangeKey;
    document.querySelectorAll('#viral-range-pills .pill-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');

    if (globalDashboardData && globalDashboardData.viralAnalytics) {
      renderViralCharts(globalDashboardData.viralAnalytics);
    }
  }

  function switchAnalyticsMetric(metricKey, btnEl) {
    selectedAnalyticsMetric = metricKey;
    document.querySelectorAll('[data-metric]').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');

    const labelsMap = { views: 'Views over time', reels: 'Reels published over time', er: 'Engagement rate (%) over time', shares: 'Shares over time' };
    setElText('main-chart-title', labelsMap[metricKey] || 'Metric over time');

    if (globalDashboardData && globalDashboardData.viralAnalytics) {
      renderViralCharts(globalDashboardData.viralAnalytics);
    }
  }

  function applyViralSearch() {
    const qEl = document.getElementById('viral-search-input');
    if (!qEl) return;
    const q = qEl.value.toLowerCase();
    const rows = document.querySelectorAll('#viral-leaderboard-body tr');
    rows.forEach(r => {
      r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }

  function exportViralCsv() {
    if (!globalDashboardData || !globalDashboardData.viralAnalytics) return;
    const items = globalDashboardData.viralAnalytics.leaderboard;
    let csv = 'Rank,Shortcode,Channel,Views,EngRate,Shares,Trend,Url\n';
    items.forEach((r, i) => {
      csv += '"' + (i + 1) + '","' + r.shortcode + '","' + r.profileKey + '","' + r.playCount + '","' + r.er + '%","' + r.shares + '","' + r.trend + '","' + r.sourceUrl + '"\n';
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'viral_analytics_report.csv';
    a.click();
  }

  /* CHART.JS VISUALIZATIONS */
  function renderViralCharts(viralData) {
    if (typeof Chart === 'undefined' || !viralData) return;

    const elMain = document.getElementById('chart-main-metric');
    const elCadence = document.getElementById('chart-daily-cadence');
    const elER = document.getElementById('chart-er-trend');
    const elPie = document.getElementById('chart-view-share');
    const elShares = document.getElementById('chart-shares-momentum');

    if (!elMain || !elCadence || !elER || !elPie || !elShares) return;const a = document.createElement('a');
    a.href = url;
    a.download = 'viral_analytics_report.csv';
    a.click();
  }

  /* CHART.JS VISUALIZATIONS */
  function renderViralCharts(viralData) {
    if (typeof Chart === 'undefined') return;

    const rangeData = (viralData.timeSeriesRanges && viralData.timeSeriesRanges[selectedAnalyticsRange])
      ? viralData.timeSeriesRanges[selectedAnalyticsRange]
      : viralData.timeSeriesRanges['30d'];

    const labels = rangeData ? rangeData.labels : ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5'];
    const channelKeys = Object.keys(rangeData ? rangeData.series : {});
    const colors = ['#3fb950', '#f78166', '#d2a8ff', '#58a6ff'];

    // 1. MAIN METRIC AREA CHART
    const ctxMain = document.getElementById('chart-main-metric').getContext('2d');
    if (chartMainMetric) chartMainMetric.destroy();

    const mainDatasets = channelKeys.map((cKey, idx) => {
      const seriesData = rangeData.series[cKey][selectedAnalyticsMetric] || [];
      const col = colors[idx % colors.length];
      return {
        label: cKey.toUpperCase(),
        data: seriesData,
        borderColor: col,
        backgroundColor: col + '1a',
        borderWidth: 2,
        fill: true,
        tension: 0.35,
        pointRadius: labels.length > 20 ? 0 : 3
      };
    });

    chartMainMetric = new Chart(ctxMain, {
      type: 'line',
      data: { labels, datasets: mainDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#8b949e', font: { family: 'Inter', weight: '600' } } } },
        scales: {
          x: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
          y: { ticks: { color: '#8b949e', callback: v => fmtNum(v) }, grid: { color: '#21262d' } }
        }
      }
    });

    // 2. DAILY PUBLISHING CADENCE BAR CHART
    const ctxCadence = document.getElementById('chart-daily-cadence').getContext('2d');
    if (chartDailyCadence) chartDailyCadence.destroy();

    const cadenceDatasets = channelKeys.map((cKey, idx) => ({
      label: cKey.toUpperCase(),
      data: rangeData.series[cKey].reels,
      backgroundColor: colors[idx % colors.length],
      borderRadius: 4
    }));

    chartDailyCadence = new Chart(ctxCadence, {
      type: 'bar',
      data: { labels, datasets: cadenceDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#8b949e' } } },
        scales: {
          x: { ticks: { color: '#8b949e' }, grid: { display: false } },
          y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
        }
      }
    });

    // 3. ENGAGEMENT RATE TREND LINE CHART
    const ctxER = document.getElementById('chart-er-trend').getContext('2d');
    if (chartERTrend) chartERTrend.destroy();

    const erDatasets = channelKeys.map((cKey, idx) => ({
      label: cKey.toUpperCase() + ' ER',
      data: rangeData.series[cKey].er,
      borderColor: colors[idx % colors.length],
      borderWidth: 2,
      tension: 0.3,
      pointRadius: 0
    }));

    chartERTrend = new Chart(ctxER, {
      type: 'line',
      data: { labels, datasets: erDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#8b949e' } } },
        scales: {
          x: { ticks: { color: '#8b949e' }, grid: { display: false } },
          y: { ticks: { color: '#8b949e', callback: v => v + '%' }, grid: { color: '#21262d' }, min: 0, max: 12 }
        }
      }
    });

    // 4. VIEW SHARE DOUGHNUT CHART & LEGEND
    const ctxPie = document.getElementById('chart-view-share').getContext('2d');
    if (chartViewShare) chartViewShare.destroy();

    const pieValues = channelKeys.map(cKey => {
      const viewsArr = rangeData.series[cKey].views || [];
      return viewsArr.reduce((a, b) => a + b, 0);
    });
    const pieTotal = pieValues.reduce((a, b) => a + b, 1);
    const piePcts = pieValues.map(v => Math.round((v / pieTotal) * 100));

    chartViewShare = new Chart(ctxPie, {
      type: 'doughnut',
      data: {
        labels: channelKeys.map(k => k.toUpperCase()),
        datasets: [{
          data: piePcts,
          backgroundColor: colors.slice(0, channelKeys.length),
          borderWidth: 0,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        cutout: '65%'
      }
    });

    const legendContainer = document.getElementById('view-share-legend');
    legendContainer.innerHTML = '';
    channelKeys.forEach((cKey, i) => {
      const div = document.createElement('div');
      div.style.cssText = 'display: flex; alignItems: center; gap: 8px; font-size: 12px;';
      div.innerHTML = '<div style="width: 10px; height: 10px; border-radius: 2px; background: ' + colors[i % colors.length] + '"></div>' +
        '<div><div style="font-weight: 700; color: #fff;">' + piePcts[i] + '%</div><div style="color: var(--text-muted); font-size: 10px;">' + cKey.toUpperCase() + '</div></div>';
      legendContainer.appendChild(div);
    });

    // 5. SHARES MOMENTUM AREA CHART
    const ctxShares = document.getElementById('chart-shares-momentum').getContext('2d');
    if (chartSharesMomentum) chartSharesMomentum.destroy();

    const sharesDatasets = channelKeys.map((cKey, idx) => ({
      label: cKey.toUpperCase(),
      data: rangeData.series[cKey].shares,
      borderColor: colors[idx % colors.length],
      backgroundColor: colors[idx % colors.length] + '20',
      fill: true,
      tension: 0.35,
      pointRadius: 0
    }));

    chartSharesMomentum = new Chart(ctxShares, {
      type: 'line',
      data: { labels, datasets: sharesDatasets },
      options: {
        responsive: true,
        scales: {
          x: { ticks: { color: '#8b949e' }, grid: { display: false } },
          y: { ticks: { color: '#8b949e', callback: v => fmtNum(v) }, grid: { color: '#21262d' } }
        }
      }
    });
  }

  /* LOG CONSOLE FUNCTIONS */
  function toggleAutoScroll() {
    autoScroll = !autoScroll;
    document.getElementById('scrollToggleBtn').textContent = 'Auto-scroll: ' + (autoScroll ? 'ON' : 'OFF');
  }
  function clearLogConsole() {
    document.getElementById('log-container').innerHTML = '';
    logTotal = 0;
    document.getElementById('log-count').textContent = '0 entries';
  }
  function isLogMatchingFocusedChannel(text) {
    if (focusedChannel === 'all') return true;
    const key = (focusedChannel || '').toLowerCase();
    const cleanKey = key.replace(/_/g, '');
    const textLower = (text || '').toLowerCase();

    const allChannelKeys = ['codeorcap', 'storiyum', 'prompt_gag', 'promptgag'];
    const otherKeys = allChannelKeys.filter(k => k !== key && k !== cleanKey);
    const isOtherChannel = otherKeys.some(k => textLower.includes(k));

    if (isOtherChannel) return false;
    return true;
  }

  function applyLogFilter() {
    logFilterStr = document.getElementById('log-filter').value.toLowerCase();
    const container = document.getElementById('log-container');
    let visibleCount = 0;
    for (const el of container.children) {
      const text = el.dataset.text || '';
      const matchSearch = !logFilterStr || text.includes(logFilterStr);
      const matchChannel = isLogMatchingFocusedChannel(text);
      if (matchSearch && matchChannel) {
        el.style.display = '';
        visibleCount++;
      } else {
        el.style.display = 'none';
      }
    }
    document.getElementById('log-count').textContent = visibleCount + ' entries';
  }
  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function appendLogLine(raw) {
    let o; try { o = JSON.parse(raw); } catch { return; }
    const level = (o.level || 'info').toLowerCase();
    const ts = (o.timestamp || '').replace('T',' ').replace(/\.\d+Z$/, '');
    const label = o.label || '';
    const msg = o.message || '';
    const div = document.createElement('div');
    div.style.cssText = 'display: flex; gap: 10px; line-height: 1.8; color: ' + (level === 'error' ? '#f85149' : level === 'warn' ? '#d29922' : '#e6edf3');
    div.dataset.text = (ts + ' ' + level + ' ' + label + ' ' + msg).toLowerCase();
    div.innerHTML =
      '<span style="color: #484f58; flex-shrink: 0;">' + esc(ts) + '</span>' +
      '<span style="font-weight: 700; width: 44px; flex-shrink: 0; text-transform: uppercase; color: ' + (level === 'error' ? '#f85149' : level === 'warn' ? '#d29922' : '#3fb950') + ';">' + level.slice(0,4) + '</span>' +
      '<span style="color: #58a6ff; flex-shrink: 0; min-width: 110px;">[' + esc(label) + ']</span>' +
      '<span style="word-break: break-word; flex: 1;">' + esc(msg) + '</span>';
    
    const matchSearch = !logFilterStr || div.dataset.text.includes(logFilterStr);
    const matchChannel = isLogMatchingFocusedChannel(div.dataset.text);
    if (!matchSearch || !matchChannel) {
      div.style.display = 'none';
    }
    
    const container = document.getElementById('log-container');
    container.appendChild(div);
    logTotal++;
    document.getElementById('log-count').textContent = logTotal + ' entries';
    if (autoScroll && activeTab === 'logs') container.scrollTop = container.scrollHeight;
  }

  function connectSSE() {
    const es = new EventSource('/logs');
    es.onmessage = e => appendLogLine(e.data);
    es.onerror = () => { es.close(); setTimeout(connectSSE, 3000); };
  }

  renderHeaderAudienceCards(null);
  renderChannelsList(null);
  fetchDashboardData();
  connectSSE();
  setInterval(fetchDashboardData, 10000);
</script>
</body>
</html>`;

export function startLogServer(): void {
  const server = http.createServer(async (req, res) => {
    const url = req.url || "/";

    if (url === "/api/dashboard" || url.startsWith("/api/dashboard?")) {
      try {
        const data = await getDashboardData();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to generate dashboard data" }));
      }
      return;
    }

    if (req.method === "POST" && (url === "/api/inject-link" || url.startsWith("/api/inject-link?"))) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (body.profile || pUrl.searchParams.get("profile") || "codeorcap").toLowerCase();
        const reelUrl = body.url || pUrl.searchParams.get("url") || "";

        if (!reelUrl) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: false, message: "Missing URL parameter" }));
          return;
        }

        const shortcode = reelUrl.split("/reel/")[1]?.split("/")[0] || reelUrl.split("/p/")[1]?.split("/")[0] || `injected_${Date.now()}`;
        const newItem = {
          shortcode,
          url: reelUrl,
          channel: "manual_inject",
          pickedAt: new Date().toISOString()
        };

        const pool = await getPool();
        await pool.query(
          `UPDATE watch_state SET queue = queue || $1::jsonb WHERE profile_key = $2`,
          [JSON.stringify([newItem]), pKey]
        );

        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ success: true, message: `＋ Reel #${shortcode} injected into [${pKey.toUpperCase()}] queue!` }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Error injecting link into database queue" }));
      }
      return;
    }

    if (req.method === "POST" && (url === "/api/remove-queue" || url.startsWith("/api/remove-queue?"))) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (body.profile || pUrl.searchParams.get("profile") || "codeorcap").toLowerCase();
        const shortcode = body.shortcode || pUrl.searchParams.get("shortcode") || "";

        const pool = await getPool();
        const wRes = await pool.query(`SELECT queue FROM watch_state WHERE profile_key = $1`, [pKey]);
        if (wRes.rows.length > 0) {
          const currentQueue = wRes.rows[0].queue || [];
          const updatedQueue = currentQueue.filter((q: any) => {
            const sc = q.shortcode || q.url?.split("/reel/")[1]?.replace(/\//g, "") || "";
            if (sc === shortcode || sc.startsWith("failed-fetch-") || sc.startsWith("no-unseen-")) return false;
            return true;
          });
          await pool.query(`UPDATE watch_state SET queue = $1::jsonb WHERE profile_key = $2`, [JSON.stringify(updatedQueue), pKey]);
        }

        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ success: true, message: `🧹 Item #${shortcode} removed from queue.` }));
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Error removing item from queue" }));
      }
      return;
    }

    if (req.method === "POST" && (url === "/api/retry-failed" || url.startsWith("/api/retry-failed?"))) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (body.profile || pUrl.searchParams.get("profile") || "codeorcap").toLowerCase();
        const shortcode = body.shortcode || pUrl.searchParams.get("shortcode") || "";

        const pool = await getPool();
        await pool.query(`UPDATE reel_history SET failed = false, failed_reason = null WHERE shortcode = $1 AND profile_key = $2`, [shortcode, pKey]);

        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ success: true, message: `↺ Reel #${shortcode} reset for retry.` }));
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Error retrying failed reel" }));
      }
      return;
    }

    if (req.method === "POST" && (url === "/api/update-config" || url.startsWith("/api/update-config?"))) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (body.profile || pUrl.searchParams.get("profile") || "codeorcap").toLowerCase();
        const dailyLimit = parseInt(body.dailyLimit || pUrl.searchParams.get("dailyLimit") || "6", 10);

        const profile = config.profiles.find(p => (p.key || p.brandName).toLowerCase() === pKey);
        if (profile && profile.watch) {
          profile.watch.dailyCount = dailyLimit;
        }

        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ success: true, message: `⚙️ Config updated for profile [${pKey.toUpperCase()}]: ${dailyLimit} reels/day.` }));
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Error updating profile configuration" }));
      }
      return;
    }

    if (req.method === "POST" && (url === "/api/force-start" || url.startsWith("/api/force-start?"))) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (body.profile || pUrl.searchParams.get("profile") || "codeorcap").toLowerCase();

        pipelineLogger.info(
          `⚡ Real /runwatchnow channel automation pipeline force-started from Control Center UI for profile [${pKey.toUpperCase()}]`,
          "ControlCenter"
        );

        if (pKey === 'all') {
          for (const [k, watcher] of activeWatchers.entries()) {
            watcher.forceStart().catch((err) => {
              pipelineLogger.error(`[${k.toUpperCase()}] forceStart workflow failed`, err, "ChannelWatcher");
            });
          }
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: true, message: `⚡ Real /runwatch automation pipeline force-started for ALL profiles network!` }));
        } else {
          const watcher = activeWatchers.get(pKey);
          if (watcher) {
            watcher.forceStart().catch((err) => {
              pipelineLogger.error(`[${pKey.toUpperCase()}] forceStart workflow failed`, err, "ChannelWatcher");
            });
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ success: true, message: `⚡ Real /runwatch automation pipeline force-started for [${pKey.toUpperCase()}]!` }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ success: false, message: `No active watcher registered for profile [${pKey}].` }));
          }
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Error triggering force start" }));
      }
      return;
    }

    if (req.method === "POST" && (url === "/api/restart-queue" || url.startsWith("/api/restart-queue?"))) {
      try {
        const body = await parseJsonBody(req);
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (body.profile || pUrl.searchParams.get("profile") || "codeorcap").toLowerCase();

        pipelineLogger.info(
          `🔄 Ingestion queue reset & real /runwatch automation restarted from Control Center UI for profile [${pKey.toUpperCase()}]`,
          "ControlCenter"
        );

        const pool = await getPool();
        if (pKey === 'all') {
          await pool.query(`UPDATE reel_history SET failed = false, failed_reason = null`);
          await pool.query(`UPDATE watch_state SET current_slot = 0`);
          for (const [k, watcher] of activeWatchers.entries()) {
            watcher.forceStart().catch((err) => {
              pipelineLogger.error(`[${k.toUpperCase()}] restartQueue workflow failed`, err, "ChannelWatcher");
            });
          }
        } else {
          await pool.query(`UPDATE reel_history SET failed = false, failed_reason = null WHERE profile_key = $1 OR channel ILIKE $2`, [pKey, `%${pKey}%`]);
          await pool.query(`UPDATE watch_state SET current_slot = 0 WHERE profile_key = $1`, [pKey]);
          const watcher = activeWatchers.get(pKey);
          if (watcher) {
            watcher.forceStart().catch((err) => {
              pipelineLogger.error(`[${pKey.toUpperCase()}] restartQueue workflow failed`, err, "ChannelWatcher");
            });
          }
        }

        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ success: true, message: `🔄 Queue reset & real /runwatch automation restarted for [${pKey.toUpperCase()}]!` }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Error restarting queue" }));
      }
      return;
    }

    if (url === "/api/channel-detail" || url.startsWith("/api/channel-detail?")) {
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

    if (url === "/logs" || url.startsWith("/logs?") || url.startsWith("/logs/")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
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

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[LogServer] Production Control Center & Live Logs → http://127.0.0.1:${PORT}`);
  });
}
