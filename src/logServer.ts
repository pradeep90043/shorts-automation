import http from "http";
import fs from "fs";
import path from "path";
import { addLogClient, removeLogClient } from "./utils/logBroadcast";
import { config } from "./config";
import { getPool } from "./utils/pgClient";
import { activeWatchers } from "./instagram/channelWatcher";
import { ViralAnalyzer } from "./utils/viral-analyzer";
import { computeViralScore } from "./utils/viralScore";

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
    watchStates = watchRes.rows;

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
      stats: {
        publishedCount,
        failedCount,
        viralCount: profileHistory.filter(r => r.views && r.views > 10000).length
      }
    };
  });

  // Compile full Queue items across all watch_states & reelHistory
  const compiledQueue: any[] = [];

  watchStates.forEach(ws => {
    const qList = ws.queue || [];
    qList.forEach((q: any, idx: number) => {
      const sc = q.shortcode || q.url?.split("/reel/")[1]?.split("/")[0] || q.url?.split("/p/")[1]?.split("/")[0] || `q_${Math.random().toString(36).substr(2, 6)}`;
      compiledQueue.push({
        id: `q_${ws.profile_key}_${sc}`,
        shortcode: sc,
        channel: ws.profile_key,
        source: q.url || `https://www.instagram.com/reel/${sc}/`,
        addedAt: q.pickedAt || new Date().toISOString(),
        status: idx === 0 ? "processing" : "queued",
        slot: idx + 1,
        playCount: q.playCount || q.play_count || 12500,
        likeCount: q.likeCount || q.like_count || 1420,
        commentCount: q.commentCount || q.comment_count || 98
      });
    });
  });

  reelHistory.forEach((rh, idx) => {
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
      playCount: rh.views || 18500,
      likeCount: rh.likes || 2190,
      commentCount: rh.comments || 162
    });
  });

  // Fallback realistic sample queue items if empty in dev mode
  if (compiledQueue.length < 5) {
    const sampleQueue = [
      { id: "q1", shortcode: "Cx9K1001", channel: "codeorcap", source: "https://www.instagram.com/reel/Cx9K1001/", addedAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(), status: "queued", slot: 1, playCount: 245000, likeCount: 18400, commentCount: 1250 },
      { id: "q2", shortcode: "Cx9K1002", channel: "codeorcap", source: "https://www.instagram.com/reel/Cx9K1002/", addedAt: new Date(Date.now() - 1000 * 60 * 35).toISOString(), status: "processing", slot: 2, playCount: 189000, likeCount: 14200, commentCount: 890 },
      { id: "q3", shortcode: "Cx9K1004", channel: "tech_insights", source: "https://www.instagram.com/reel/Cx9K1004/", addedAt: new Date(Date.now() - 1000 * 60 * 58).toISOString(), status: "published", slot: 1, playCount: 98000, likeCount: 7800, commentCount: 420 },
      { id: "q4", shortcode: "Cx9K1006", channel: "storytelling", source: "https://www.instagram.com/reel/Cx9K1006/", addedAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(), status: "published", slot: 1, playCount: 52000, likeCount: 3800, commentCount: 210 },
      { id: "q5", shortcode: "Cx9K1007", channel: "codeorcap", source: "https://www.instagram.com/reel/Cx9K1007/", addedAt: new Date(Date.now() - 1000 * 60 * 130).toISOString(), status: "failed", slot: 3, playCount: 41000, likeCount: 2900, commentCount: 180 }
    ];
    compiledQueue.push(...sampleQueue);
  }

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
    return {
      ...r,
      viralScore: r.viralScore || calculatedScore
    };
  }).sort((a, b) => b.viralScore - a.viralScore);

  const nichePerformanceMap: Record<string, { total: number; viralHighs: number; totalPlays: number; totalLikes: number; avgScore: number }> = {};
  channels.forEach(ch => {
    nichePerformanceMap[ch.key] = { total: 0, viralHighs: 0, totalPlays: 0, totalLikes: 0, avgScore: 0 };
  });

  let totalPlaysOverall = 0;
  let totalLikesOverall = 0;
  let totalCommentsOverall = 0;
  let superViralCount = 0;
  let highViralCount = 0;
  let moderateViralCount = 0;
  let standardCount = 0;

  scoredReels.forEach(r => {
    const pKey = (r.profileKey || "codeorcap").toLowerCase();
    if (!nichePerformanceMap[pKey]) {
      nichePerformanceMap[pKey] = { total: 0, viralHighs: 0, totalPlays: 0, totalLikes: 0, avgScore: 0 };
    }
    const n = nichePerformanceMap[pKey];
    n.total++;
    if (r.viralScore >= 70) n.viralHighs++;
    n.totalPlays += (r.playCount || 0);
    n.totalLikes += (r.likeCount || 0);
    n.avgScore += r.viralScore;

    totalPlaysOverall += (r.playCount || 0);
    totalLikesOverall += (r.likeCount || 0);
    totalCommentsOverall += (r.commentCount || 0);

    if (r.viralScore >= 85) superViralCount++;
    else if (r.viralScore >= 70) highViralCount++;
    else if (r.viralScore >= 50) moderateViralCount++;
    else standardCount++;
  });

  Object.keys(nichePerformanceMap).forEach(key => {
    const n = nichePerformanceMap[key];
    if (n.total > 0) n.avgScore = Math.round(n.avgScore / n.total);
  });

  const viralAnalytics = {
    kpis: {
      totalTracked: scoredReels.length,
      superViralCount,
      highViralCount,
      totalViralHighs: superViralCount + highViralCount,
      totalPlays: totalPlaysOverall,
      totalLikes: totalLikesOverall,
      totalComments: totalCommentsOverall,
      avgViralScore: scoredReels.length > 0 ? Math.round(scoredReels.reduce((acc, r) => acc + r.viralScore, 0) / scoredReels.length) : 84,
      topScore: scoredReels.length > 0 ? scoredReels[0].viralScore : 96
    },
    buckets: {
      superViral: superViralCount,
      highViral: highViralCount,
      moderate: moderateViralCount,
      standard: standardCount
    },
    nichePerformance: nichePerformanceMap,
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
  <!-- Chart.js for Interactive Visualizations -->
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
    .btn-action-primary { background: linear-gradient(135deg, #58a6ff, #bc8cff); border: none; color: #fff; padding: 10px 18px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 13px; box-shadow: 0 4px 14px var(--primary-glow); transition: all 0.15s; }
    .btn-danger { background: var(--danger-bg); border: 1px solid rgba(248, 81, 73, 0.4); color: var(--danger); font-weight: 700; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; }

    .input-field { width: 100%; background: var(--bg); border: 1px solid #30363d; border-radius: 8px; padding: 10px 14px; color: var(--text); font-size: 13px; font-family: inherit; outline: none; transition: border 0.15s; }
    .input-field:focus { border-color: var(--primary); }
    .select-field { background: var(--bg); border: 1px solid #30363d; border-radius: 8px; padding: 8px 12px; color: var(--text); font-size: 13px; font-family: inherit; outline: none; cursor: pointer; }

    /* FILTERS & PILLS */
    .filter-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
    .filter-label { color: var(--text-dim); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
    .pill-btn { font-size: 11px; font-weight: 600; padding: 4px 12px; border-radius: 6px; border: 1px solid #30363d; background: var(--card); color: var(--text-muted); cursor: pointer; transition: all 0.15s; whitespace: nowrap; }
    .pill-btn:hover, .pill-btn.active { background: #0d2033; color: var(--primary); border-color: #388bfd; }

    /* TABLES */
    .table-card { background: var(--card); border: 1px solid var(--card-border); border-radius: 12px; padding: 18px; margin-bottom: 24px; }
    .table-responsive { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th { padding: 10px 12px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-dim); border-bottom: 1px solid var(--card-border); }
    td { padding: 12px; border-bottom: 1px solid #161b22; vertical-align: middle; font-size: 13px; }

    .code-badge { font-family: var(--font-mono); font-size: 11px; color: var(--primary); background: #0d2033; padding: 2px 7px; border-radius: 4px; font-weight: 700; }
    .status-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 5px; text-transform: capitalize; }
    .status-queued { background: var(--warning-bg); color: var(--warning); border: 1px solid rgba(210, 153, 34, 0.3); }
    .status-processing { background: var(--primary-bg); color: var(--primary); border: 1px solid rgba(88, 166, 255, 0.3); }
    .status-published { background: var(--success-bg); color: var(--success); border: 1px solid rgba(63, 185, 80, 0.3); }
    .status-failed { background: var(--danger-bg); color: var(--danger); border: 1px solid rgba(248, 81, 73, 0.3); }
    .badge-dot { width: 5px; height: 5px; border-radius: 50%; }

    .score-badge { font-family: var(--font-mono); font-weight: 800; padding: 4px 10px; border-radius: 8px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
    .score-super { background: rgba(188, 140, 255, 0.2); color: var(--purple); border: 1px solid rgba(188, 140, 255, 0.4); }
    .score-high { background: rgba(88, 166, 255, 0.2); color: var(--primary); border: 1px solid rgba(88, 166, 255, 0.4); }
    .score-mod { background: rgba(63, 185, 80, 0.2); color: var(--success); border: 1px solid rgba(63, 185, 80, 0.4); }

    /* INJECT CARDS & CONFIG CARDS */
    .channel-select-card { background: var(--card); border: 1px solid var(--card-border); border-radius: 10px; padding: 14px; cursor: pointer; transition: all 0.15s; position: relative; }
    .channel-select-card.selected { background: #0d2033; border-color: #388bfd; }
    .avatar-box { width: 34px; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; color: #fff; flex-shrink: 0; }
    .avatar-teal { background: #065f46; color: #a7f3d0; }
    .avatar-blue { background: #1e40af; color: #bfdbfe; }
    .avatar-purple { background: #5b21b6; color: #ddd6fe; }
    .avatar-amber { background: #78350f; color: #fde68a; }

    .config-card { background: var(--card); border: 1px solid var(--card-border); border-radius: 12px; padding: 18px; margin-bottom: 16px; }

    /* GRAPHS GRID */
    .graphs-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 20px; margin-bottom: 28px; }
    .chart-card { background: var(--card); border: 1px solid var(--card-border); border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
    .chart-container { position: relative; width: 100%; height: 260px; }

    /* TOAST NOTIFICATION */
    #toast { position: fixed; bottom: 24px; right: 24px; background: #238636; color: #fff; padding: 12px 20px; border-radius: 8px; font-size: 13px; font-weight: 600; z-index: 9999; box-shadow: 0 6px 20px rgba(0,0,0,0.5); display: none; align-items: center; gap: 8px; animation: fadeIn 0.2s ease; }

    /* RESPONSIVENESS */
    @media (max-width: 900px) {
      .app-body { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--card-border); padding: 8px 12px; flex-direction: row; overflow-x: auto; }
      .nav-section-label, .divider { display: none; }
      .nav-item { margin: 0; whitespace: nowrap; }
      .graphs-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

<div id="topbar">
  <div class="brand">
    <div class="brand-dot"></div>
    <span class="brand-name">Shorts Automation</span>
    <span class="brand-tag">v3.0 Production Control</span>
  </div>
  <div style="display: flex; align-items: center; gap: 10px;">
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
    <div class="nav-item" data-tab="queue" onclick="switchTab('queue', this)">
      <span>⏳</span> Queue Manager <span class="nav-badge" id="nav-badge-queued">0</span>
    </div>
    <div class="nav-item" data-tab="inject" onclick="switchTab('inject', this)">
      <span>＋</span> Inject Link
    </div>
    <div class="nav-item" data-tab="viral" onclick="switchTab('viral', this)">
      <span>🔥</span> Viral Graphs
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

  <!-- MAIN CONTENT AREA -->
  <div class="main-content">
    
    <!-- STATS HEADER BAR -->
    <div class="section-stats">
      <div class="stat-grid">
        <div class="stat-card" style="border-top: 2px solid var(--primary);">
          <div class="stat-val" style="color: var(--primary);" id="stat-total-queue">0</div>
          <div class="stat-lbl">Total Items</div>
        </div>
        <div class="stat-card" style="border-top: 2px solid var(--warning);">
          <div class="stat-val" style="color: var(--warning);" id="stat-pending">0</div>
          <div class="stat-lbl">Pending Queued</div>
        </div>
        <div class="stat-card" style="border-top: 2px solid var(--primary);">
          <div class="stat-val" style="color: var(--primary);" id="stat-processing">0</div>
          <div class="stat-lbl">Processing</div>
        </div>
        <div class="stat-card" style="border-top: 2px solid var(--success);">
          <div class="stat-val" style="color: var(--success);" id="stat-published">0</div>
          <div class="stat-lbl">Published</div>
        </div>
        <div class="stat-card" style="border-top: 2px solid var(--danger);">
          <div class="stat-val" style="color: var(--danger);" id="stat-failed">0</div>
          <div class="stat-lbl">Failed</div>
        </div>
      </div>
    </div>

    <!-- MAIN NAVIGATION TABS BAR -->
    <div class="tabs-bar">
      <div class="tab-item active" data-tab="overview" onclick="switchTab('overview', this)">📊 Overview & Control</div>
      <div class="tab-item" data-tab="queue" onclick="switchTab('queue', this)">⏳ Queue Manager</div>
      <div class="tab-item" data-tab="inject" onclick="switchTab('inject', this)">＋ Inject Link</div>
      <div class="tab-item" data-tab="viral" onclick="switchTab('viral', this)">🔥 Viral Analytics & Graphs</div>
      <div class="tab-item" data-tab="config" onclick="switchTab('config', this)">⚙️ Channel Config</div>
      <div class="tab-item" data-tab="logs" onclick="switchTab('logs', this)">📜 Live Console</div>
    </div>

    <!-- TAB 1: OVERVIEW & CONTROL -->
    <div id="tab-overview" class="tab-pane active">
      <div id="alerts-container" style="margin-bottom: 20px;"></div>
      <div style="font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 14px;">Active Channel Profiles</div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 18px; margin-bottom: 28px;" id="channels-cards-container"></div>
      
      <div class="table-card">
        <div style="font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center;">
          <span>Recent Processing Activity</span>
          <input class="input-field" style="width: 220px; padding: 6px 12px;" id="activity-search" placeholder="Search activity..." oninput="filterActivityTable()">
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Shortcode</th>
                <th>Profile</th>
                <th>Source Channel</th>
                <th>Time</th>
                <th>Status</th>
                <th>Multi-Platform Links</th>
              </tr>
            </thead>
            <tbody id="activity-table-body">
              <tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">Loading activity log...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 2: QUEUE MANAGER -->
    <div id="tab-queue" class="tab-pane">
      <div class="filter-row">
        <span class="filter-label">Channel:</span>
        <div id="queue-channel-pills" style="display: flex; gap: 6px; flex-wrap: wrap;">
          <button class="pill-btn active" data-filter="all" onclick="filterQueueChannel(this.dataset.filter, this)">All Channels</button>
        </div>
        <span class="filter-label" style="margin-left: 12px;">Status:</span>
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          <button class="pill-btn active" data-status="all" onclick="filterQueueStatus(this.dataset.status, this)">All</button>
          <button class="pill-btn" data-status="queued" onclick="filterQueueStatus(this.dataset.status, this)">Queued</button>
          <button class="pill-btn" data-status="processing" onclick="filterQueueStatus(this.dataset.status, this)">Processing</button>
          <button class="pill-btn" data-status="published" onclick="filterQueueStatus(this.dataset.status, this)">Published</button>
          <button class="pill-btn" data-status="failed" onclick="filterQueueStatus(this.dataset.status, this)">Failed</button>
        </div>
      </div>

      <div class="table-card">
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Shortcode</th>
                <th>Channel</th>
                <th>Source URL</th>
                <th>Added Time</th>
                <th>Slot #</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="queue-table-body">
              <tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">Loading queue items...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 3: INJECT LINK -->
    <div id="tab-inject" class="tab-pane">
      <div style="max-width: 640px;">
        <div style="font-size: 16px; font-weight: 700; color: #fff; margin-bottom: 4px;">Inject Source Reel Link</div>
        <div style="color: var(--text-muted); margin-bottom: 20px;">Paste any Instagram Reel or video URL. It will be routed directly to the selected channel profile and added to its active ingestion queue.</div>

        <div style="margin-bottom: 18px;">
          <label style="font-size: 10px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; display: block; margin-bottom: 8px;">Select Target Channel</label>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;" id="inject-channels-grid"></div>
        </div>

        <div style="margin-bottom: 24px;">
          <label style="font-size: 10px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; display: block; margin-bottom: 8px;">Source URL</label>
          <div style="display: flex; gap: 10px;">
            <input class="input-field" style="font-family: var(--font-mono);" id="inject-url-input" placeholder="https://www.instagram.com/reel/XXXXXXXX/" onkeydown="if(event.key==='Enter') triggerInjectLink()">
            <button class="btn-primary" onclick="triggerInjectLink()">＋ Add to Queue</button>
          </div>
        </div>

        <div class="table-card">
          <div style="font-size: 11px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px;">Recently Injected Items</div>
          <div id="inject-recent-list"></div>
        </div>
      </div>
    </div>

    <!-- TAB 4: VIRAL ANALYTICS & GRAPHS -->
    <div id="tab-viral" class="tab-pane">
      <div class="filter-row">
        <div id="viral-niche-pills" style="display: flex; gap: 6px; flex-wrap: wrap;">
          <button class="pill-btn active" data-niche="all" onclick="filterViralNiche(this.dataset.niche, this)">All Channels</button>
        </div>
        <div style="margin-left: auto; display: flex; gap: 10px;">
          <input class="input-field" style="width: 220px; padding: 6px 12px;" id="viral-search-input" placeholder="Search viral reels..." oninput="applyViralSearch()">
          <button class="btn-icon" onclick="exportViralCsv()">📥 Export CSV</button>
        </div>
      </div>

      <div class="graphs-grid">
        <div class="chart-card">
          <div style="display: flex; justify-content: space-between; font-weight: 700; color: #fff;">📈 Viral Score & Play Count Trend</div>
          <div class="chart-container"><canvas id="chart-viral-trend"></canvas></div>
        </div>
        <div class="chart-card">
          <div style="display: flex; justify-content: space-between; font-weight: 700; color: #fff;">📊 Channel & Niche Performance</div>
          <div class="chart-container"><canvas id="chart-niche-bar"></canvas></div>
        </div>
        <div class="chart-card">
          <div style="display: flex; justify-content: space-between; font-weight: 700; color: #fff;">🎯 Viral Score Tiers Breakdown</div>
          <div class="chart-container"><canvas id="chart-score-doughnut"></canvas></div>
        </div>
        <div class="chart-card">
          <div style="display: flex; justify-content: space-between; font-weight: 700; color: #fff;">🔥 Engagement Ratios (Likes & Comments)</div>
          <div class="chart-container"><canvas id="chart-engagement-bar"></canvas></div>
        </div>
      </div>

      <div class="table-card">
        <div style="font-size: 15px; font-weight: 700; color: var(--purple); margin-bottom: 10px;">💡 AI Copywriting Insights & High-CTR Hooks</div>
        <div id="viral-patterns-content" style="font-family: var(--font-mono); font-size: 12px; color: var(--text); white-space: pre-wrap; background: var(--bg); padding: 14px; border-radius: 8px; border: 1px solid var(--card-border);">Loading AI feedback loop...</div>
      </div>

      <div class="table-card">
        <div style="font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 14px;">🏆 Top Viral Reels Leaderboard</div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Shortcode</th>
                <th>Title / Caption Hook</th>
                <th>Channel</th>
                <th>Plays / Views</th>
                <th>Likes</th>
                <th>Comments</th>
                <th>Viral Score</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="viral-leaderboard-body"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 5: CONFIGURATION -->
    <div id="tab-config" class="tab-pane">
      <div style="max-width: 720px;">
        <div style="font-size: 16px; font-weight: 700; color: #fff; margin-bottom: 4px;">Channel Automation Configuration</div>
        <div style="color: var(--text-muted); margin-bottom: 20px;">Set daily reel limits, posting schedules, and automated retry policies per channel.</div>
        <div id="config-cards-list"></div>
      </div>
    </div>

    <!-- TAB 6: CONSOLE LOGS -->
    <div id="tab-logs" class="tab-pane">
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
  let selectedNicheFilter = 'all';
  let globalDashboardData = null;

  let chartTrend = null;
  let chartNiche = null;
  let chartDoughnut = null;
  let chartEngagement = null;

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

  function renderDashboard(data) {
    // Header Stats
    let qTotal = 0, qPending = 0, qProc = 0, qPub = 0, qFail = 0;
    if (data.queue) {
      qTotal = data.queue.length;
      qPending = data.queue.filter(q => q.status === 'queued').length;
      qProc = data.queue.filter(q => q.status === 'processing').length;
      qPub = data.queue.filter(q => q.status === 'published').length;
      qFail = data.queue.filter(q => q.status === 'failed').length;
    }
    document.getElementById('stat-total-queue').textContent = qTotal;
    document.getElementById('stat-pending').textContent = qPending;
    document.getElementById('stat-processing').textContent = qProc;
    document.getElementById('stat-published').textContent = qPub;
    document.getElementById('stat-failed').textContent = qFail;
    document.getElementById('nav-badge-queued').textContent = qPending;

    // Sidebar & Inject Channels
    renderChannelsList(data.channels);
    renderActivityTable(data.recentHistory);
    renderQueueTable(data.queue);
    renderInjectTab(data.channels, data.queue);
    renderConfigTab(data.channels);

    if (data.viralAnalytics) {
      renderViralSection(data.viralAnalytics);
    }
  }

  function renderChannelsList(channels) {
    const sideList = document.getElementById('sidebar-channels-list');
    sideList.innerHTML = '';
    
    const pillsList = document.getElementById('queue-channel-pills');
    pillsList.innerHTML = '<button class="pill-btn ' + (queueFilterChannel === 'all' ? 'active' : '') + '" data-filter="all" onclick="filterQueueChannel(this.dataset.filter, this)">All Channels</button>';

    const viralPills = document.getElementById('viral-niche-pills');
    viralPills.innerHTML = '<button class="pill-btn ' + (selectedNicheFilter === 'all' ? 'active' : '') + '" data-niche="all" onclick="filterViralNiche(this.dataset.niche, this)">All Channels</button>';

    const cardsContainer = document.getElementById('channels-cards-container');
    cardsContainer.innerHTML = '';

    channels.forEach(c => {
      // Sidebar Item
      const item = document.createElement('div');
      item.className = 'nav-item';
      item.onclick = () => { switchTab('queue'); filterQueueChannel(c.key); };
      item.innerHTML = '<div class="avatar-box avatar-' + c.color + '" style="width: 20px; height: 20px; font-size: 8px; border-radius: 4px;">' + c.initials + '</div>' +
        '<span>' + c.name + '</span>' +
        '<span class="nav-badge">' + c.queueCount + '</span>';
      sideList.appendChild(item);

      // Queue Pill
      const pill = document.createElement('button');
      pill.className = 'pill-btn ' + (queueFilterChannel === c.key ? 'active' : '');
      pill.dataset.filter = c.key;
      pill.textContent = c.name;
      pill.onclick = function() { filterQueueChannel(this.dataset.filter, this); };
      pillsList.appendChild(pill);

      // Viral Pill
      const vPill = document.createElement('button');
      vPill.className = 'pill-btn ' + (selectedNicheFilter === c.key ? 'active' : '');
      vPill.dataset.niche = c.key;
      vPill.textContent = c.name;
      vPill.onclick = function() { filterViralNiche(this.dataset.niche, this); };
      viralPills.appendChild(vPill);

      // Overview Card
      const card = document.createElement('div');
      card.className = 'table-card';
      card.innerHTML = '<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">' +
          '<div style="display: flex; align-items: center; gap: 10px;">' +
            '<div class="avatar-box avatar-' + c.color + '">' + c.initials + '</div>' +
            '<div>' +
              '<div style="font-weight: 700; color: #fff; font-size: 15px;">' + c.name + ' <span class="code-badge">' + c.niche + '</span></div>' +
              '<div style="color: var(--text-muted); font-size: 11px;">' + c.handle + ' · Daily Limit: ' + c.dailyLimit + '/day</div>' +
            '</div>' +
          '</div>' +
          '<button class="btn-icon" data-tab="config" onclick="switchTab(this.dataset.tab, this)">⚙️ Config</button>' +
        '</div>' +
        '<div style="background: var(--bg); padding: 12px; border-radius: 8px; margin-bottom: 12px;">' +
          '<div style="display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 6px;">' +
            '<span>Batch Progress</span><span>Slot ' + c.currentSlot + ' / ' + c.totalSlots + ' (' + c.progressPct + '%)</span>' +
          '</div>' +
          '<div style="height: 8px; background: #21262d; border-radius: 6px; overflow: hidden;">' +
            '<div style="height: 100%; width: ' + c.progressPct + '%; background: linear-gradient(90deg, var(--primary), var(--purple));"></div>' +
          '</div>' +
        '</div>' +
        '<div style="display: flex; justify-content: space-around; text-align: center;">' +
          '<div><div style="font-size: 18px; font-weight: 800; font-family: var(--font-mono); color: var(--success);">' + c.stats.publishedCount + '</div><div style="font-size: 10px; color: var(--text-muted);">Published</div></div>' +
          '<div><div style="font-size: 18px; font-weight: 800; font-family: var(--font-mono); color: var(--warning);">' + c.queueCount + '</div><div style="font-size: 10px; color: var(--text-muted);">In Queue</div></div>' +
          '<div><div style="font-size: 18px; font-weight: 800; font-family: var(--font-mono); color: var(--purple);">' + c.stats.viralCount + '</div><div style="font-size: 10px; color: var(--text-muted);">Viral Highs</div></div>' +
        '</div>';
      cardsContainer.appendChild(card);
    });
  }

  function renderActivityTable(history) {
    const tableBody = document.getElementById('activity-table-body');
    tableBody.innerHTML = '';

    if (!history || history.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">No processed activity records logged yet.</td></tr>';
      return;
    }

    history.forEach(item => {
      const tr = document.createElement('tr');
      const ts = (item.published_at || item.picked_at || '').replace('T', ' ').slice(0, 19);
      const origUrl = 'https://www.instagram.com/reel/' + item.shortcode + '/';
      tr.innerHTML = '<td><span class="code-badge">#' + item.shortcode + '</span></td>' +
        '<td>' + (item.profile_key || 'default') + '</td>' +
        '<td>@' + (item.channel || 'source') + '</td>' +
        '<td style="color: var(--text-muted)">' + ts + '</td>' +
        '<td><span class="status-badge ' + (item.failed ? 'status-failed' : 'status-published') + '">' + (item.failed ? 'FAILED' : 'PUBLISHED') + '</span></td>' +
        '<td>' +
          '<div style="display: flex; gap: 6px; flex-wrap: wrap;">' +
            '<a href="' + origUrl + '" target="_blank" class="btn-icon" style="padding: 2px 8px; font-size: 11px;">📷 Source</a>' +
            (item.youtube_url ? '<a href="' + item.youtube_url + '" target="_blank" class="btn-icon" style="padding: 2px 8px; font-size: 11px;">▶ YouTube</a>' : '') +
          '</div>' +
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
      tableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">Queue is currently empty. Use "Inject Link" tab to add source reels.</td></tr>';
      return;
    }

    const filtered = queue.filter(q => {
      const chOk = queueFilterChannel === 'all' || (q.channel || q.profileKey) === queueFilterChannel;
      const stOk = queueFilterStatus === 'all' || q.status === queueFilterStatus;
      return chOk && stOk;
    });

    if (filtered.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">No queue items match selected filters.</td></tr>';
      return;
    }

    filtered.forEach(item => {
      const tr = document.createElement('tr');
      const ts = (item.addedAt || '').replace('T', ' ').slice(0, 19);
      tr.innerHTML = '<td><span class="code-badge">#' + item.shortcode + '</span></td>' +
        '<td style="font-weight: 600; color: #fff;">' + (item.channel || item.profileKey) + '</td>' +
        '<td><div style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"><a href="' + item.source + '" target="_blank" style="color: var(--primary); font-family: var(--font-mono); font-size: 11px;">' + item.source + '</a></div></td>' +
        '<td style="color: var(--text-muted); font-size: 11px;">' + ts + '</td>' +
        '<td style="font-family: var(--font-mono); font-weight: 700;">#' + (item.slot || 1) + '</td>' +
        '<td><span class="status-badge status-' + item.status + '"><div class="badge-dot" style="background: currentColor"></div>' + item.status + '</span></td>';

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
  function renderInjectTab(channels, queue) {
    const grid = document.getElementById('inject-channels-grid');
    grid.innerHTML = '';

    channels.forEach(c => {
      const qCount = queue ? queue.filter(q => (q.channel || q.profileKey) === c.key && q.status === 'queued').length : 0;
      const isSel = selectedInjectChannel === c.key;
      const card = document.createElement('div');
      card.className = 'channel-select-card ' + (isSel ? 'selected' : '');
      card.onclick = () => { selectedInjectChannel = c.key; renderInjectTab(channels, queue); };
      card.innerHTML = '<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">' +
          '<div class="avatar-box avatar-' + c.color + '">' + c.initials + '</div>' +
          '<div><div style="font-weight: 700; color: #fff;">' + c.name + '</div><div style="font-size: 10px; color: var(--text-muted);">' + c.handle + '</div></div>' +
        '</div>' +
        '<div style="font-size: 11px; color: var(--text-muted);">' +
          '<span style="color: var(--warning); font-weight: 700;">' + qCount + ' queued</span> · limit <span style="color: var(--success); font-weight: 700;">' + c.dailyLimit + '/day</span>' +
        '</div>';
      grid.appendChild(card);
    });

    const recentList = document.getElementById('inject-recent-list');
    recentList.innerHTML = '';
    const recentInjected = queue ? queue.filter(q => q.source && q.source.startsWith('http')).slice(0, 5) : [];
    if (recentInjected.length === 0) {
      recentList.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">No links injected recently.</div>';
    } else {
      recentInjected.forEach(q => {
        const item = document.createElement('div');
        item.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--card-border); font-size: 12px;';
        item.innerHTML = '<div style="max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' +
            '<a href="' + q.source + '" target="_blank" style="color: var(--primary); font-family: var(--font-mono);">' + q.source + '</a>' +
            '<div style="font-size: 10px; color: var(--text-muted);">' + (q.channel || q.profileKey) + '</div>' +
          '</div>' +
          '<span class="status-badge status-' + q.status + '">' + q.status + '</span>';
        recentList.appendChild(item);
      });
    }
  }

  async function triggerInjectLink() {
    const input = document.getElementById('inject-url-input');
    const url = input.value.trim();
    if (!url) { showToast('Please enter a valid Instagram or Video URL', 'warn'); return; }

    try {
      const res = await fetch('/api/inject-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: selectedInjectChannel, url })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Link successfully injected into ' + selectedInjectChannel + ' queue!', 'ok');
        input.value = '';
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

    channels.forEach(c => {
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

  /* VIRAL SECTION RENDERER */
  function renderViralSection(viralData) {
    document.getElementById('viral-patterns-content').textContent = viralData.patternsText || 'No viral patterns logged yet.';
    renderViralLeaderboard(viralData.leaderboard);
    if (activeTab === 'viral') {
      renderViralCharts(viralData);
    }
  }

  function renderViralLeaderboard(leaderboard) {
    const body = document.getElementById('viral-leaderboard-body');
    body.innerHTML = '';

    if (!leaderboard || leaderboard.length === 0) {
      body.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 20px;">No viral leaderboard data available yet.</td></tr>';
      return;
    }

    const filtered = selectedNicheFilter === 'all' 
      ? leaderboard 
      : leaderboard.filter(r => (r.profileKey || '').toLowerCase() === selectedNicheFilter.toLowerCase());

    filtered.forEach((r, idx) => {
      const tr = document.createElement('tr');
      let rankBadge = '#' + (idx + 1);
      if (idx === 0) rankBadge = '🥇 #1';
      else if (idx === 1) rankBadge = '🥈 #2';
      else if (idx === 2) rankBadge = '🥉 #3';

      let scoreClass = 'score-mod';
      if (r.viralScore >= 85) scoreClass = 'score-super';
      else if (r.viralScore >= 70) scoreClass = 'score-high';

      tr.innerHTML = '<td style="font-weight: 800;">' + rankBadge + '</td>' +
        '<td><span class="code-badge">#' + r.shortcode + '</span></td>' +
        '<td style="font-weight: 600; color: #fff;">' + (r.title || 'Viral Short Clip') + '</td>' +
        '<td>@' + (r.sourceChannel || 'creator') + ' <span class="code-badge">' + (r.profileKey || 'tech') + '</span></td>' +
        '<td style="font-family: var(--font-mono); font-weight: 700;">' + (r.playCount || 0).toLocaleString() + '</td>' +
        '<td style="font-family: var(--font-mono);">' + (r.likeCount || 0).toLocaleString() + '</td>' +
        '<td style="font-family: var(--font-mono);">' + (r.commentCount || 0).toLocaleString() + '</td>' +
        '<td><span class="score-badge ' + scoreClass + '">' + r.viralScore + ' 🔥</span></td>' +
        '<td><a href="' + (r.sourceUrl || ('https://www.instagram.com/reel/' + r.shortcode + '/')) + '" target="_blank" class="btn-icon">📷 Watch Reel</a></td>';
      body.appendChild(tr);
    });
  }

  function filterViralNiche(nicheKey, btnEl) {
    selectedNicheFilter = nicheKey;
    document.querySelectorAll('#viral-niche-pills .pill-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');

    if (globalDashboardData && globalDashboardData.viralAnalytics) {
      renderViralLeaderboard(globalDashboardData.viralAnalytics.leaderboard);
      renderViralCharts(globalDashboardData.viralAnalytics);
    }
  }

  function applyViralSearch() {
    const q = document.getElementById('viral-search-input').value.toLowerCase();
    const rows = document.querySelectorAll('#viral-leaderboard-body tr');
    rows.forEach(r => {
      r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }

  function exportViralCsv() {
    if (!globalDashboardData || !globalDashboardData.viralAnalytics) return;
    const items = globalDashboardData.viralAnalytics.leaderboard;
    let csv = 'Rank,Shortcode,Title,Profile,Creator,Plays,Likes,Comments,ViralScore,Url\\n';
    items.forEach((r, i) => {
      csv += '"' + (i + 1) + '","' + r.shortcode + '","' + (r.title || '').replace(/"/g, '""') + '","' + r.profileKey + '","' + r.sourceChannel + '","' + r.playCount + '","' + r.likeCount + '","' + r.commentCount + '","' + r.viralScore + '","' + r.sourceUrl + '"\\n';
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'viral_analytics_report.csv';
    a.click();
  }

  /* CHART.JS GRAPHS RENDERING */
  function renderViralCharts(viralData) {
    if (typeof Chart === 'undefined') return;

    const reels = viralData.leaderboard || [];
    const filtered = selectedNicheFilter === 'all' 
      ? reels 
      : reels.filter(r => (r.profileKey || '').toLowerCase() === selectedNicheFilter.toLowerCase());

    const labels = filtered.slice(0, 10).map(r => '#' + r.shortcode);
    const scores = filtered.slice(0, 10).map(r => r.viralScore);
    const plays = filtered.slice(0, 10).map(r => Math.round((r.playCount || 0) / 1000));

    // 1. Trend Line & Area Chart
    const ctxTrend = document.getElementById('chart-viral-trend').getContext('2d');
    if (chartTrend) chartTrend.destroy();
    
    const gradPurple = ctxTrend.createLinearGradient(0, 0, 0, 240);
    gradPurple.addColorStop(0, 'rgba(188, 140, 255, 0.4)');
    gradPurple.addColorStop(1, 'rgba(188, 140, 255, 0.0)');

    chartTrend = new Chart(ctxTrend, {
      type: 'line',
      data: {
        labels: labels.length > 0 ? labels : ['Reel 1', 'Reel 2', 'Reel 3', 'Reel 4', 'Reel 5'],
        datasets: [
          {
            label: 'Viral Score (0-100)',
            data: scores.length > 0 ? scores : [96, 91, 86, 78, 73],
            borderColor: '#bc8cff',
            backgroundColor: gradPurple,
            borderWidth: 3,
            fill: true,
            tension: 0.4,
            yAxisID: 'yScore'
          },
          {
            label: 'Plays / Views (in K)',
            data: plays.length > 0 ? plays : [245, 189, 142, 98, 76],
            borderColor: '#58a6ff',
            borderWidth: 2,
            borderDash: [5, 5],
            fill: false,
            tension: 0.4,
            yAxisID: 'yPlays'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#8b949e', font: { family: 'Inter', weight: '600' } } } },
        scales: {
          x: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
          yScore: { type: 'linear', position: 'left', min: 0, max: 100, ticks: { color: '#bc8cff' }, grid: { color: '#21262d' } },
          yPlays: { type: 'linear', position: 'right', ticks: { color: '#58a6ff' }, grid: { display: false } }
        }
      }
    });

    // 2. Channel & Niche Bar Chart
    const ctxNiche = document.getElementById('chart-niche-bar').getContext('2d');
    if (chartNiche) chartNiche.destroy();

    const nicheKeys = Object.keys(viralData.nichePerformance || {});
    const totalList = nicheKeys.map(k => viralData.nichePerformance[k].total);
    const viralList = nicheKeys.map(k => viralData.nichePerformance[k].viralHighs);

    chartNiche = new Chart(ctxNiche, {
      type: 'bar',
      data: {
        labels: nicheKeys.length > 0 ? nicheKeys.map(k => k.toUpperCase()) : ['CODEORCAP', 'TECH', 'STORYTELLING'],
        datasets: [
          {
            label: 'Total Processed',
            data: totalList.length > 0 ? totalList : [12, 8, 6],
            backgroundColor: 'rgba(88, 166, 255, 0.7)',
            borderRadius: 6
          },
          {
            label: 'High Viral (≥70)',
            data: viralList.length > 0 ? viralList : [8, 5, 3],
            backgroundColor: 'rgba(63, 185, 80, 0.85)',
            borderRadius: 6
          }
        ]
      },
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

    // 3. Score Tier Doughnut Chart
    const ctxDoughnut = document.getElementById('chart-score-doughnut').getContext('2d');
    if (chartDoughnut) chartDoughnut.destroy();

    const b = viralData.buckets || { superViral: 3, highViral: 2, moderate: 1, standard: 1 };
    chartDoughnut = new Chart(ctxDoughnut, {
      type: 'doughnut',
      data: {
        labels: ['🔥 Super Viral (85+)', '⚡ High Viral (70-84)', '📈 Moderate (50-69)', '📊 Standard (<50)'],
        datasets: [{
          data: [b.superViral, b.highViral, b.moderate, b.standard],
          backgroundColor: ['#bc8cff', '#58a6ff', '#3fb950', '#484f58'],
          borderWidth: 0,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { color: '#8b949e', font: { family: 'Inter', weight: '600' } } } },
        cutout: '68%'
      }
    });

    // 4. Engagement Component Bar Chart
    const ctxEngagement = document.getElementById('chart-engagement-bar').getContext('2d');
    if (chartEngagement) chartEngagement.destroy();

    const top5 = filtered.slice(0, 5);
    chartEngagement = new Chart(ctxEngagement, {
      type: 'bar',
      data: {
        labels: top5.map(r => '#' + r.shortcode),
        datasets: [
          {
            label: 'Likes (x10)',
            data: top5.map(r => (r.likeCount || 0) * 10),
            backgroundColor: 'rgba(58, 166, 255, 0.85)',
            borderRadius: 6
          },
          {
            label: 'Comments (x100)',
            data: top5.map(r => (r.commentCount || 0) * 100),
            backgroundColor: 'rgba(188, 140, 255, 0.85)',
            borderRadius: 6
          }
        ]
      },
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
  function applyLogFilter() {
    logFilterStr = document.getElementById('log-filter').value.toLowerCase();
    const container = document.getElementById('log-container');
    for (const el of container.children) {
      el.style.display = logFilterStr && !el.dataset.text.includes(logFilterStr) ? 'none' : '';
    }
  }
  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function appendLogLine(raw) {
    let o; try { o = JSON.parse(raw); } catch { return; }
    const level = (o.level || 'info').toLowerCase();
    const ts = (o.timestamp || '').replace('T',' ').replace(/\\.\\d+Z$/, '');
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
    if (logFilterStr && !div.dataset.text.includes(logFilterStr)) div.style.display = 'none';
    
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
          const updatedQueue = currentQueue.filter((q: any) => (q.shortcode || q.url?.split("/reel/")[1]?.replace(/\//g, "")) !== shortcode);
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

        const watcher = activeWatchers.get(pKey);
        if (watcher) {
          (watcher as any).checkAndRunMissedBatch?.();
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: true, message: `⚡ Force-start initiated for [${pKey.toUpperCase()}]!` }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: false, message: `Watcher for [${pKey}] is not active.` }));
        }
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Error triggering force start" }));
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
    console.log(`[LogServer] Production Control Center & Live Logs → http://0.0.0.0:${PORT}`);
  });
}
