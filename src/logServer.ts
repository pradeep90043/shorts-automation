import http from "http";
import fs from "fs";
import path from "path";
import { addLogClient, removeLogClient } from "./utils/logBroadcast";
import { config } from "./config";
import { getPool } from "./utils/pgClient";
import { activeWatchers } from "./instagram/channelWatcher";

const PORT = parseInt(process.env.LOG_SERVER_PORT || "3002", 10);
const COMBINED_LOG = path.join(config.paths.logDir, "combined.log");
const TAIL_LINES = 300;

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

  const channels = config.profiles.map(profile => {
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

    return {
      key: pKey,
      name: profile.brandName,
      handle: profile.handle || `@${pKey}`,
      niche: profile.theme?.niche || "tech",
      status,
      isWatchOnly: profile.isWatchOnly,
      dailyTarget: profile.watch?.dailyCount || 6,
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

  return {
    systemHealth: {
      status: priorityFixes.length > 0 ? "warning" : "healthy",
      dbStatus,
      activeProfilesCount: config.profiles.length,
      priorityFixes
    },
    channels,
    recentHistory: reelHistory.slice(0, 15),
    topInsights: reelInsights.slice(0, 15)
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
  <title>Shorts Automation — Control Center & Analytics</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card: #111726;
      --card-border: #1e293b;
      --card-hover: #1e2638;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-bg: rgba(56, 189, 248, 0.12);
      --success: #34d399;
      --success-bg: rgba(52, 211, 153, 0.12);
      --warning: #fbbf24;
      --warning-bg: rgba(251, 191, 36, 0.12);
      --danger: #f43f5e;
      --danger-bg: rgba(244, 63, 94, 0.12);
      --purple: #c084fc;
      --font: 'Inter', sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; min-height: 100vh; line-height: 1.5; }
    
    #navbar { position: sticky; top: 0; background: rgba(17, 23, 38, 0.9); backdrop-filter: blur(14px); border-bottom: 1px solid var(--card-border); padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; z-index: 100; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-logo { width: 36px; height: 36px; background: linear-gradient(135deg, #38bdf8, #818cf8); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 18px; color: #fff; box-shadow: 0 0 20px rgba(56, 189, 248, 0.3); }
    .brand h1 { font-size: 16px; font-weight: 700; color: var(--text); }
    .brand-badge { background: rgba(56, 189, 248, 0.15); color: var(--primary); font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 20px; border: 1px solid rgba(56, 189, 248, 0.3); }
    
    .nav-tabs { display: flex; background: rgba(15, 23, 42, 0.6); padding: 4px; border-radius: 12px; border: 1px solid var(--card-border); gap: 4px; }
    .tab-btn { background: transparent; border: none; color: var(--text-muted); padding: 8px 18px; font-size: 13px; font-weight: 600; border-radius: 8px; cursor: pointer; transition: all 0.2s ease; display: flex; align-items: center; gap: 8px; }
    .tab-btn:hover { color: var(--text); }
    .tab-btn.active { background: var(--primary); color: #090d16; font-weight: 700; box-shadow: 0 4px 12px rgba(56, 189, 248, 0.25); }

    .nav-right { display: flex; align-items: center; gap: 14px; }
    .status-pill { display: flex; align-items: center; gap: 8px; background: rgba(52, 211, 153, 0.1); border: 1px solid rgba(52, 211, 153, 0.3); padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; color: var(--success); }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .btn-icon { background: var(--card); border: 1px solid var(--card-border); color: var(--text-muted); padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.2s; }
    .btn-icon:hover { border-color: var(--primary); color: var(--primary); }
    .btn-action-primary { background: linear-gradient(135deg, #38bdf8, #6366f1); border: none; color: #fff; padding: 10px 18px; border-radius: 10px; cursor: pointer; font-weight: 700; font-size: 13px; box-shadow: 0 4px 14px rgba(56, 189, 248, 0.3); transition: all 0.2s; }
    .btn-action-primary:hover { opacity: 0.9; transform: translateY(-1px); }

    .container { max-width: 1440px; margin: 0 auto; padding: 24px; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .alerts-section { margin-bottom: 24px; display: flex; flex-direction: column; gap: 12px; }
    .alert-card { background: linear-gradient(135deg, rgba(244, 63, 94, 0.12), rgba(30, 41, 59, 0.8)); border: 1px solid rgba(244, 63, 94, 0.3); border-radius: 16px; padding: 18px 24px; display: flex; align-items: flex-start; gap: 16px; box-shadow: 0 4px 20px rgba(244, 63, 94, 0.08); }
    .alert-card.warning { background: linear-gradient(135deg, rgba(251, 191, 36, 0.12), rgba(30, 41, 59, 0.8)); border-color: rgba(251, 191, 36, 0.3); }
    .alert-icon { font-size: 24px; flex-shrink: 0; margin-top: 2px; }
    .alert-body { flex: 1; }
    .alert-title { font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 4px; display: flex; align-items: center; gap: 10px; }
    .alert-badge { font-size: 10px; text-transform: uppercase; font-weight: 800; padding: 2px 6px; border-radius: 4px; background: var(--danger); color: #fff; }
    .alert-card.warning .alert-badge { background: var(--warning); color: #000; }
    .alert-desc { font-size: 13px; color: var(--text-muted); margin-bottom: 8px; }
    .alert-hint { font-size: 12px; font-weight: 600; color: var(--primary); background: rgba(56, 189, 248, 0.1); padding: 6px 12px; border-radius: 6px; display: inline-block; font-family: var(--font-mono); }

    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px; margin-bottom: 28px; }
    .kpi-card { background: var(--card); border: 1px solid var(--card-border); border-radius: 16px; padding: 20px; transition: transform 0.2s, border-color 0.2s; }
    .kpi-card:hover { transform: translateY(-2px); border-color: rgba(56, 189, 248, 0.4); }
    .kpi-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .kpi-label { font-size: 13px; font-weight: 600; color: var(--text-muted); }
    .kpi-icon { width: 32px; height: 32px; border-radius: 8px; background: var(--primary-bg); color: var(--primary); display: flex; align-items: center; justify-content: center; font-size: 16px; }
    .kpi-val { font-size: 28px; font-weight: 800; color: #fff; letter-spacing: -0.5px; }
    .kpi-sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

    .section-title { font-size: 18px; font-weight: 700; margin-bottom: 16px; color: #fff; display: flex; align-items: center; justify-content: space-between; }
    .section-title span { font-size: 12px; font-weight: 600; color: var(--text-muted); background: var(--card); padding: 4px 10px; border-radius: 12px; border: 1px solid var(--card-border); }

    .channels-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 22px; margin-bottom: 32px; }
    .channel-card { background: var(--card); border: 1px solid var(--card-border); border-radius: 20px; padding: 24px; display: flex; flex-direction: column; gap: 20px; cursor: pointer; transition: all 0.2s ease; position: relative; }
    .channel-card:hover { border-color: var(--primary); transform: translateY(-3px); box-shadow: 0 12px 30px rgba(56, 189, 248, 0.15); }
    .card-click-hint { position: absolute; top: 16px; right: 16px; font-size: 11px; font-weight: 700; color: var(--primary); background: var(--primary-bg); padding: 4px 10px; border-radius: 12px; opacity: 0.8; }

    .ch-header { display: flex; align-items: center; justify-content: space-between; padding-right: 80px; }
    .ch-info { display: flex; align-items: center; gap: 12px; }
    .ch-avatar { width: 44px; height: 44px; border-radius: 14px; background: linear-gradient(135deg, #6366f1, #a855f7); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 20px; color: #fff; }
    .ch-name { font-size: 17px; font-weight: 700; color: #fff; }
    .ch-niche { font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--primary); background: var(--primary-bg); padding: 2px 8px; border-radius: 6px; margin-left: 8px; }

    .progress-box { background: rgba(15, 23, 42, 0.6); border: 1px solid var(--card-border); border-radius: 14px; padding: 16px; }
    .progress-header { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 8px; }
    .progress-title { font-weight: 600; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
    .progress-pct { font-weight: 800; color: var(--primary); font-family: var(--font-mono); }
    .progress-bar-bg { width: 100%; height: 10px; background: rgba(30, 41, 59, 0.8); border-radius: 10px; overflow: hidden; }
    .progress-bar-fill { height: 100%; background: linear-gradient(90deg, var(--primary), var(--purple)); border-radius: 10px; transition: width 0.5s ease; }
    .progress-foot { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted); margin-top: 8px; }

    .last-pub-box { background: rgba(15, 23, 42, 0.6); border: 1px solid var(--card-border); border-radius: 14px; padding: 16px; }
    .last-pub-title { font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; display: flex; justify-content: space-between; }
    .last-pub-content { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .reel-code { font-family: var(--font-mono); font-weight: 700; font-size: 14px; color: var(--text); }
    .reel-links { display: flex; gap: 8px; flex-wrap: wrap; }
    .reel-link-btn { font-size: 12px; font-weight: 600; color: var(--primary); text-decoration: none; background: var(--primary-bg); padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(56, 189, 248, 0.2); }
    .reel-link-btn:hover { background: var(--primary); color: #000; }

    .modal-overlay { position: fixed; inset: 0; background: rgba(9, 13, 22, 0.85); backdrop-filter: blur(10px); display: none; justify-content: center; align-items: center; z-index: 1000; padding: 20px; }
    .modal-overlay.open { display: flex; }
    .modal-content { background: var(--card); border: 1px solid var(--card-border); border-radius: 24px; width: 100%; max-width: 950px; max-height: 90vh; overflow-y: auto; padding: 28px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); display: flex; flex-direction: column; gap: 24px; }
    
    .modal-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--card-border); padding-bottom: 20px; }
    .modal-close { background: rgba(255,255,255,0.05); border: 1px solid var(--card-border); color: var(--text-muted); font-size: 18px; width: 36px; height: 36px; border-radius: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .modal-close:hover { color: #fff; border-color: var(--primary); }

    .modal-actions { display: flex; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
    .btn-danger { background: var(--danger-bg); border: 1px solid rgba(244, 63, 94, 0.3); color: var(--danger); font-weight: 700; padding: 8px 16px; border-radius: 10px; cursor: pointer; }
    .btn-danger:hover { background: var(--danger); color: #fff; }

    .queue-list { display: flex; flex-direction: column; gap: 12px; }
    .queue-item { background: rgba(15, 23, 42, 0.6); border: 1px solid var(--card-border); border-radius: 14px; padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; }
    .queue-item:hover { border-color: var(--primary); }

    .table-card { background: var(--card); border: 1px solid var(--card-border); border-radius: 20px; padding: 24px; margin-bottom: 32px; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th { padding: 12px 16px; font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); border-bottom: 1px solid var(--card-border); }
    td { padding: 14px 16px; border-bottom: 1px solid rgba(30, 41, 59, 0.5); font-size: 13px; }
    .badge-success { background: var(--success-bg); color: var(--success); font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 6px; }
    .badge-failed { background: var(--danger-bg); color: var(--danger); font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 6px; }

    #log-console-wrap { background: #0c1017; border: 1px solid var(--card-border); border-radius: 16px; overflow: hidden; }
    #console-toolbar { background: var(--card); border-bottom: 1px solid var(--card-border); padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; }
    #log-filter { background: #090d16; border: 1px solid var(--card-border); color: #fff; padding: 6px 12px; border-radius: 8px; font-size: 13px; width: 240px; }
    #log-container { padding: 12px 0; font-family: var(--font-mono); font-size: 13px; max-height: 75vh; overflow-y: auto; }
    .log-line { padding: 4px 20px; display: flex; gap: 12px; line-height: 1.6; }
    .log-ts { color: var(--text-muted); flex-shrink: 0; }
    .log-lv { font-weight: 700; flex-shrink: 0; width: 44px; text-transform: uppercase; }
    .log-lb { color: var(--primary); flex-shrink: 0; min-width: 120px; }
    .log-msg { color: #e2e8f0; word-break: break-word; flex: 1; }
    .log-info .log-lv { color: var(--success); }
    .log-warn .log-lv { color: var(--warning); }
    .log-error .log-lv { color: var(--danger); }
  </style>
</head>
<body>

<div id="navbar">
  <div class="brand">
    <div class="brand-logo">⚡</div>
    <div>
      <h1>Shorts Automation</h1>
      <span class="brand-badge">Control Center v2.0</span>
    </div>
  </div>

  <div class="nav-tabs">
    <button class="tab-btn active" onclick="switchTab('analytics')">📊 Control & Analytics</button>
    <button class="tab-btn" onclick="switchTab('logs')">📜 Live Console Logs</button>
  </div>

  <div class="nav-right">
    <div class="status-pill">
      <div class="status-dot"></div>
      <span>System Active</span>
    </div>
    <button class="btn-icon" onclick="fetchDashboardData()">🔄 Refresh</button>
  </div>
</div>

<div class="container">
  
  <div id="tab-analytics" class="tab-content active">
    
    <div id="alerts-container" class="alerts-section"></div>

    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-header">
          <span class="kpi-label">Active Channel Bots</span>
          <div class="kpi-icon">🤖</div>
        </div>
        <div class="kpi-val" id="kpi-active-bots">3</div>
        <div class="kpi-sub">Active Polling Listeners</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-header">
          <span class="kpi-label">Total Processed Reels</span>
          <div class="kpi-icon">🎬</div>
        </div>
        <div class="kpi-val" id="kpi-total-reels">--</div>
        <div class="kpi-sub">Across all profiles</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-header">
          <span class="kpi-label">Database Status</span>
          <div class="kpi-icon">🗄️</div>
        </div>
        <div class="kpi-val" id="kpi-db-status" style="font-size: 20px; color: var(--success)">PostgreSQL Ready</div>
        <div class="kpi-sub">Supabase synchronized</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-header">
          <span class="kpi-label">System Health Level</span>
          <div class="kpi-icon">❤️</div>
        </div>
        <div class="kpi-val" id="kpi-health-score" style="color: var(--success)">100%</div>
        <div class="kpi-sub">All engines operational</div>
      </div>
    </div>

    <div class="section-title">
      Channel Automation Profiles (Click card for detailed queue & actions)
      <span id="channel-count-badge">3 Profiles Active</span>
    </div>
    <div class="channels-grid" id="channels-container"></div>

    <div class="table-card">
      <div class="section-title" style="margin-bottom: 20px;">
        Recent Processing & Multi-Platform Publishing Activity
        <span>Last 15 Activity Records</span>
      </div>
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
          <tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 30px;">Loading processing activity...</td></tr>
        </tbody>
      </table>
    </div>

  </div>

  <div id="tab-logs" class="tab-content">
    <div id="log-console-wrap">
      <div id="console-toolbar">
        <div style="display: flex; align-items: center; gap: 12px;">
          <input id="log-filter" placeholder="Filter logs (e.g. error, Pipeline)..." oninput="applyLogFilter()">
          <span id="log-count" style="color: var(--text-muted); font-size: 13px;">0 entries</span>
        </div>
        <div style="display: flex; gap: 10px;">
          <button class="btn-icon" onclick="clearLogConsole()">Clear Console</button>
          <button class="btn-icon" id="scrollToggleBtn" onclick="toggleAutoScroll()">Auto-scroll: ON</button>
        </div>
      </div>
      <div id="log-container"></div>
    </div>
  </div>

</div>

<!-- INTERACTIVE CHANNEL MODAL DRAWER -->
<div class="modal-overlay" id="channel-modal" onclick="closeModalOnOverlay(event)">
  <div class="modal-content">
    <div class="modal-header">
      <div style="display: flex; align-items: center; gap: 16px;">
        <div class="ch-avatar" id="modal-ch-avatar">CO</div>
        <div>
          <h2 id="modal-ch-name" style="font-size: 22px; font-weight: 800;">CodeOrCap</h2>
          <div style="display: flex; align-items: center; gap: 10px; margin-top: 4px;">
            <span id="modal-ch-handle" style="color: var(--primary); font-weight: 600;">@codeorcap</span>
            <span id="modal-ch-niche" class="ch-niche">TECH</span>
          </div>
        </div>
      </div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>

    <!-- Quick Actions Bar -->
    <div style="background: rgba(15, 23, 42, 0.6); padding: 16px; border-radius: 16px; border: 1px solid var(--card-border);">
      <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px;">Remote Control Actions</div>
      <div class="modal-actions">
        <button class="btn-action-primary" onclick="triggerForceStart()">⚡ Force-Start Watch Batch Now</button>
        <button class="btn-danger" onclick="triggerClearQueue()">🧹 Clear Channel Queue</button>
        <button class="btn-icon" onclick="openSelectedChannelModal()">🔄 Refresh Queue</button>
      </div>
    </div>

    <!-- Active Queue Section -->
    <div>
      <div class="section-title">
        Active Queued Reels (<span id="modal-queue-count">0</span> queued)
        <span id="modal-slot-info">Slot 0 / 6</span>
      </div>
      <div class="queue-list" id="modal-queue-list"></div>
    </div>

    <!-- Complete History Section -->
    <div>
      <div class="section-title">Published Reels & Original Links History</div>
      <table>
        <thead>
          <tr>
            <th>Reel Shortcode</th>
            <th>Source Channel</th>
            <th>Original Source</th>
            <th>Status</th>
            <th>Clickable Platform Links</th>
          </tr>
        </thead>
        <tbody id="modal-history-table"></tbody>
      </table>
    </div>

  </div>
</div>

<script>
  let activeTab = 'analytics';
  let autoScroll = true;
  let logTotal = 0;
  let logFilterStr = '';
  let selectedChannelKey = null;

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    if (tab === 'analytics') {
      document.querySelectorAll('.tab-btn')[0].classList.add('active');
      document.getElementById('tab-analytics').classList.add('active');
      fetchDashboardData();
    } else {
      document.querySelectorAll('.tab-btn')[1].classList.add('active');
      document.getElementById('tab-logs').classList.add('active');
    }
  }

  async function fetchDashboardData() {
    try {
      const res = await fetch('/api/dashboard');
      if (!res.ok) return;
      const data = await res.json();
      renderDashboard(data);
    } catch (e) {
      console.error('Failed to fetch dashboard data', e);
    }
  }

  function renderDashboard(data) {
    const alertsContainer = document.getElementById('alerts-container');
    alertsContainer.innerHTML = '';
    
    if (data.systemHealth && data.systemHealth.priorityFixes && data.systemHealth.priorityFixes.length > 0) {
      data.systemHealth.priorityFixes.forEach(fix => {
        const div = document.createElement('div');
        div.className = 'alert-card ' + (fix.severity === 'medium' ? 'warning' : '');
        div.innerHTML = '<div class="alert-icon">' + (fix.severity === 'high' ? '🚨' : '⚠️') + '</div>' +
          '<div class="alert-body">' +
            '<div class="alert-title">' + fix.title + '<span class="alert-badge">' + fix.severity + ' Priority</span></div>' +
            '<div class="alert-desc">' + fix.message + '</div>' +
            '<div class="alert-hint">Fix Hint: ' + fix.actionHint + '</div>' +
          '</div>';
        alertsContainer.appendChild(div);
      });
    }

    let totalPublished = 0;
    data.channels.forEach(c => { totalPublished += (c.stats ? c.stats.publishedCount : 0); });
    document.getElementById('kpi-total-reels').textContent = totalPublished + ' Reels';
    document.getElementById('kpi-active-bots').textContent = data.systemHealth.activeProfilesCount || 3;
    document.getElementById('kpi-db-status').textContent = data.systemHealth.dbStatus === 'connected' ? 'PostgreSQL Ready' : 'Database Offline';
    document.getElementById('kpi-db-status').style.color = data.systemHealth.dbStatus === 'connected' ? 'var(--success)' : 'var(--danger)';

    const channelsContainer = document.getElementById('channels-container');
    channelsContainer.innerHTML = '';

    data.channels.forEach(ch => {
      const card = document.createElement('div');
      card.className = 'channel-card';
      card.onclick = () => openChannelModal(ch.key);

      const lastPub = ch.lastPublished;
      let lastPubHtml = '';
      if (lastPub) {
        lastPubHtml = '<div class="last-pub-box">' +
          '<div class="last-pub-title">' +
            '<span>Last Published Reel of Today</span>' +
            '<span class="' + (lastPub.status === 'published' ? 'badge-success' : 'badge-failed') + '">' + lastPub.status + '</span>' +
          '</div>' +
          '<div class="last-pub-content">' +
            '<div>' +
              '<span class="reel-code">#' + lastPub.shortcode + '</span>' +
              '<div style="font-size: 11px; color: var(--text-muted);">From @' + (lastPub.channel || 'source') + '</div>' +
            '</div>' +
            '<div class="reel-links">' +
              '<a href="' + lastPub.originalUrl + '" target="_blank" class="reel-link-btn" onclick="event.stopPropagation()">📷 Original</a>' +
              (lastPub.youtubeUrl ? '<a href="' + lastPub.youtubeUrl + '" target="_blank" class="reel-link-btn" onclick="event.stopPropagation()">▶ YouTube</a>' : '') +
              (lastPub.instagramUrl ? '<a href="' + lastPub.instagramUrl + '" target="_blank" class="reel-link-btn" onclick="event.stopPropagation()">📸 Insta</a>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
      } else {
        lastPubHtml = '<div class="last-pub-box">' +
          '<div class="last-pub-title">Last Published Reel of Today</div>' +
          '<div style="font-size: 13px; color: var(--text-muted);">No reels published yet today. Queue active.</div>' +
        '</div>';
      }

      card.innerHTML = '<span class="card-click-hint">Inspect Queue & Actions ➔</span>' +
        '<div class="ch-header">' +
          '<div class="ch-info">' +
            '<div class="ch-avatar">' + ch.name.slice(0,2).toUpperCase() + '</div>' +
            '<div>' +
              '<div class="ch-name">' + ch.name + ' <span class="ch-niche">' + ch.niche + '</span></div>' +
              '<div style="font-size: 12px; color: var(--text-muted);">Schedule: ' + ch.scheduleTime + ' IST (' + ch.gapHours + 'h gap)</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="progress-box">' +
          '<div class="progress-header">' +
            '<span class="progress-title">⏱️ Ingestion & Batch Progress</span>' +
            '<span class="progress-pct">Slot ' + ch.currentSlot + ' / ' + ch.totalSlots + ' (' + ch.progressPct + '%)</span>' +
          '</div>' +
          '<div class="progress-bar-bg">' +
            '<div class="progress-bar-fill" style="width: ' + ch.progressPct + '%"></div>' +
          '</div>' +
          '<div class="progress-foot">' +
            '<span>Daily Target: ' + ch.dailyTarget + ' reels</span>' +
            '<span>Current Queue: <strong>' + ch.queueCount + ' queued</strong></span>' +
          '</div>' +
        '</div>' +

        lastPubHtml +

        '<div class="ch-metrics-row">' +
          '<div class="mini-metric">' +
            '<div class="mini-val">' + ch.stats.publishedCount + '</div>' +
            '<div class="mini-lbl">Published</div>' +
          '</div>' +
          '<div class="mini-metric">' +
            '<div class="mini-val">' + ch.stats.failedCount + '</div>' +
            '<div class="mini-lbl">Failed</div>' +
          '</div>' +
          '<div class="mini-metric">' +
            '<div class="mini-val" style="color: var(--purple)">' + ch.stats.viralCount + '</div>' +
            '<div class="mini-lbl">Viral Highs</div>' +
          '</div>' +
        '</div>';
      channelsContainer.appendChild(card);
    });

    const tableBody = document.getElementById('activity-table-body');
    tableBody.innerHTML = '';

    if (!data.recentHistory || data.recentHistory.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">No processed reels recorded in database history yet.</td></tr>';
    } else {
      data.recentHistory.forEach(item => {
        const tr = document.createElement('tr');
        const ts = (item.published_at || item.picked_at || '').replace('T', ' ').slice(0, 19);
        const origUrl = 'https://www.instagram.com/reel/' + item.shortcode + '/';
        tr.innerHTML = '<td style="font-family: var(--font-mono); font-weight: 700;">#' + item.shortcode + '</td>' +
          '<td>' + (item.profile_key || 'default') + '</td>' +
          '<td>@' + (item.channel || 'source') + '</td>' +
          '<td style="color: var(--text-muted)">' + ts + '</td>' +
          '<td><span class="' + (item.failed ? 'badge-failed' : 'badge-success') + '">' + (item.failed ? 'FAILED' : 'SUCCESS') + '</span></td>' +
          '<td>' +
            '<div style="display: flex; gap: 6px; flex-wrap: wrap;">' +
              '<a href="' + origUrl + '" target="_blank" class="reel-link-btn" style="padding: 2px 6px; font-size: 11px;">📷 Original</a>' +
              (item.youtube_url ? '<a href="' + item.youtube_url + '" target="_blank" class="reel-link-btn" style="padding: 2px 6px; font-size: 11px;">▶ YouTube</a>' : '') +
              (item.instagram_url ? '<a href="' + item.instagram_url + '" target="_blank" class="reel-link-btn" style="padding: 2px 6px; font-size: 11px;">📸 Insta</a>' : '') +
            '</div>' +
          '</td>';
        tableBody.appendChild(tr);
      });
    }
  }

  async function openChannelModal(key) {
    selectedChannelKey = key;
    document.getElementById('channel-modal').classList.add('open');
    openSelectedChannelModal();
  }

  async function openSelectedChannelModal() {
    if (!selectedChannelKey) return;
    try {
      const res = await fetch('/api/channel-detail?profile=' + selectedChannelKey);
      if (!res.ok) return;
      const data = await res.json();
      renderModal(data);
    } catch (e) {
      console.error('Failed to fetch channel details', e);
    }
  }

  function renderModal(data) {
    const p = data.profile;
    document.getElementById('modal-ch-avatar').textContent = p.name.slice(0, 2).toUpperCase();
    document.getElementById('modal-ch-name').textContent = p.name;
    document.getElementById('modal-ch-handle').textContent = p.handle;
    document.getElementById('modal-ch-niche').textContent = p.niche.toUpperCase();
    document.getElementById('modal-queue-count').textContent = data.queue.length;
    document.getElementById('modal-slot-info').textContent = 'Slot ' + p.currentSlot + ' / ' + p.totalSlots + ' (' + p.progressPct + '%)';

    const queueList = document.getElementById('modal-queue-list');
    queueList.innerHTML = '';
    if (data.queue.length === 0) {
      queueList.innerHTML = '<div style="color: var(--text-muted); padding: 20px; text-align: center; background: rgba(15, 23, 42, 0.4); border-radius: 12px;">Queue is currently empty. Click "Force-Start Watch Batch" above to ingest new reels.</div>';
    } else {
      data.queue.forEach((q, idx) => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        item.innerHTML = '<div>' +
            '<div style="display: flex; align-items: center; gap: 10px;">' +
              '<span style="font-weight: 800; color: var(--primary);">#' + (idx + 1) + '</span>' +
              '<span style="font-family: var(--font-mono); font-weight: 700;">#' + q.shortcode + '</span>' +
              '<span class="ch-niche">@' + q.sourceChannel + '</span>' +
            '</div>' +
            '<div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">' +
              'Plays: ' + (q.playCount || 0).toLocaleString() + ' • Likes: ' + (q.likeCount || 0).toLocaleString() + ' • Tag: #' + q.sourceHashtag +
            '</div>' +
          '</div>' +
          '<div>' +
            '<a href="' + q.originalUrl + '" target="_blank" class="reel-link-btn">📷 View Original Reel</a>' +
          '</div>';
        queueList.appendChild(item);
      });
    }

    const histTable = document.getElementById('modal-history-table');
    histTable.innerHTML = '';
    data.history.forEach(h => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td style="font-family: var(--font-mono); font-weight: 700;">#' + h.shortcode + '</td>' +
        '<td>@' + h.sourceChannel + '</td>' +
        '<td><a href="' + h.originalUrl + '" target="_blank" class="reel-link-btn" style="padding: 2px 6px; font-size: 11px;">📷 Original Source</a></td>' +
        '<td><span class="' + (h.status === 'published' ? 'badge-success' : 'badge-failed') + '">' + h.status + '</span></td>' +
        '<td>' +
          '<div style="display: flex; gap: 6px; flex-wrap: wrap;">' +
            (h.youtubeUrl ? '<a href="' + h.youtubeUrl + '" target="_blank" class="reel-link-btn" style="padding: 2px 6px; font-size: 11px;">▶ YouTube Shorts</a>' : '') +
            (h.instagramUrl ? '<a href="' + h.instagramUrl + '" target="_blank" class="reel-link-btn" style="padding: 2px 6px; font-size: 11px;">📸 Instagram Reel</a>' : '') +
            (h.facebookUrl ? '<a href="' + h.facebookUrl + '" target="_blank" class="reel-link-btn" style="padding: 2px 6px; font-size: 11px;">📘 Facebook Reel</a>' : '') +
          '</div>' +
        '</td>';
      histTable.appendChild(tr);
    });
  }

  async function triggerForceStart() {
    if (!selectedChannelKey) return;
    try {
      const res = await fetch('/api/force-start?profile=' + selectedChannelKey, { method: 'POST' });
      const resData = await res.json();
      alert(resData.message || 'Force start triggered!');
      openSelectedChannelModal();
      fetchDashboardData();
    } catch (e) {
      alert('Failed to trigger force start');
    }
  }

  async function triggerClearQueue() {
    if (!selectedChannelKey) return;
    if (!confirm('Are you sure you want to clear the queue for this channel?')) return;
    try {
      const res = await fetch('/api/clear-queue?profile=' + selectedChannelKey, { method: 'POST' });
      const resData = await res.json();
      alert(resData.message || 'Queue cleared!');
      openSelectedChannelModal();
      fetchDashboardData();
    } catch (e) {
      alert('Failed to clear queue');
    }
  }

  function closeModal() {
    document.getElementById('channel-modal').classList.remove('open');
  }

  function closeModalOnOverlay(e) {
    if (e.target.id === 'channel-modal') closeModal();
  }

  function toggleAutoScroll() {
    autoScroll = !autoScroll;
    document.getElementById('scrollToggleBtn').textContent = 'Auto-scroll: ' + (autoScroll ? 'ON' : 'OFF');
  }
  function clearLogConsole() {
    document.getElementById('log-container').innerHTML = '';
    logTotal = 0;
    updateLogCount();
  }
  function updateLogCount() {
    document.getElementById('log-count').textContent = logTotal + ' entries';
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
    div.className = 'log-line log-' + level;
    div.dataset.text = (ts + ' ' + level + ' ' + label + ' ' + msg).toLowerCase();
    div.innerHTML =
      '<span class="log-ts">' + esc(ts) + '</span>' +
      '<span class="log-lv">' + level.slice(0,4) + '</span>' +
      '<span class="log-lb">[' + esc(label) + ']</span>' +
      '<span class="log-msg">' + esc(msg) + '</span>';
    if (logFilterStr && !div.dataset.text.includes(logFilterStr)) div.style.display = 'none';
    
    const container = document.getElementById('log-container');
    container.appendChild(div);
    logTotal++;
    updateLogCount();
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

    if (req.method === "POST" && (url === "/api/force-start" || url.startsWith("/api/force-start?"))) {
      try {
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (pUrl.searchParams.get("profile") || "codeorcap").toLowerCase();
        const watcher = activeWatchers.get(pKey);
        if (watcher) {
          watcher.forceStart().catch(() => {});
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: true, message: `⚡ Force-start initiated for [${pKey.toUpperCase()}]! Batch ingestion triggered.` }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: false, message: `Watcher for [${pKey}] is not currently active.` }));
        }
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Error triggering force-start" }));
      }
      return;
    }

    if (req.method === "POST" && (url === "/api/clear-queue" || url.startsWith("/api/clear-queue?"))) {
      try {
        const pUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
        const pKey = (pUrl.searchParams.get("profile") || "codeorcap").toLowerCase();
        const pool = await getPool();
        await pool.query(`UPDATE watch_state SET queue = '[]'::jsonb WHERE profile_key = $1`, [pKey]);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ success: true, message: `🧹 Queue cleared for profile [${pKey.toUpperCase()}].` }));
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Error clearing queue" }));
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
