import http from "http";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { addLogClient, removeLogClient } from "./utils/logBroadcast";
import { config } from "./config";
import { getPool } from "./utils/pgClient";
import { getChannelCredentials, saveChannelCredentials } from "./utils/credentialStore";
import { activeWatchers } from "./instagram/channelWatcher";
import { ViralAnalyzer } from "./utils/viral-analyzer";
import { buildHashtagsForNiche } from "./instagram/nicheSearcher";
import { computeViralScore } from "./utils/viralScore";
import { pipelineLogger } from "./utils/logger";

const PORT = parseInt(process.env.LOG_SERVER_PORT || "3002", 10);
const COMBINED_LOG = path.join(config.paths.logDir, "combined.log");
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

  const channels = config.profiles.map((profile, idx) => {
    const pKey = (profile.key || profile.brandName).toLowerCase();
    const wState = watchStates.find((w) => w.profile_key === pKey);
    pipelineLogger.info(
      `[DashboardAPI] Profile [${pKey}] current memory watch config: ${JSON.stringify(profile.watch)}`,
      "ControlCenter",
    );

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
      igFollowers: (profile as any).igFollowers || null,
      ytSubscribers: (profile as any).ytSubscribers || null,
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
        searchMode: "hashtags",
        nicheHashtags: [],
        defaultHashtags: buildHashtagsForNiche({ niche: fb.niche } as any),
        watchedChannels: [],
        excludeChannels: [],
        outroVersion: "v1",
        scheduleTime: "09:00",
        gapHours: 3,
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

        // Sync with active watcher's in-memory store so it is not overwritten
        const watcher = activeWatchers.get(pKey);
        if (watcher) {
          await watcher.store.load();
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            success: true,
            message: `＋ Reel #${shortcode} injected into [${pKey.toUpperCase()}] queue!`,
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
        await saveChannelCredentials({
          profileKey: pKey,
          instagramSessionId: body.instagramSessionId || undefined,
          instagramUsername: body.instagramUsername || undefined,
          instagramPassword: body.instagramPassword || undefined,
          instagramEmail: body.instagramEmail || undefined,
        });
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
          ...(creds.instagramSessionId ? {} : {}),
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
          await saveChannelCredentials({ ...creds, instagramSessionId: sessionId });
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
    const acceptsText = req.headers["accept"] && req.headers["accept"].includes("text/plain");
    const wantsRaw = urlObj.searchParams.get("raw") === "true" ||
                     urlObj.searchParams.get("text") === "true" ||
                     urlObj.pathname === "/logs/raw" ||
                     urlObj.pathname === "/logs/text" ||
                     (urlObj.pathname === "/logs" && acceptsText && !urlObj.searchParams.get("stream"));

    if (wantsRaw) {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      });
      if (fs.existsSync(COMBINED_LOG)) {
        const lines = readLastLines(COMBINED_LOG, 2000);
        res.end(lines.join("\n"));
      } else {
        res.end("Log file not found on the server.");
      }
      return;
    }

    const isStream = urlObj.pathname === "/logs/stream" ||
                     urlObj.searchParams.get("stream") === "true" ||
                     (req.headers["accept"] && req.headers["accept"].includes("text/event-stream"));

    if (
      isStream &&
      (urlObj.pathname === "/logs" ||
       urlObj.pathname === "/logs/stream" ||
       urlObj.pathname.startsWith("/logs/"))
    ) {
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
