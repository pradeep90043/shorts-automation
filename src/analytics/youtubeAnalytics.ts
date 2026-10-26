import { google, youtube_v3 } from "googleapis";
import { config, type ChannelProfile } from "../config";
import { getPool } from "../utils/pgClient";
import { pipelineLogger } from "../utils/logger";
import { getAllStoredChannelConfigs, type StoredChannelConfig } from "../utils/channelConfigStore";

/**
 * Real YouTube numbers for every channel, read with the channel's own OAuth token (the one it uploads with: its
 * `youtube` scope is enough for the YouTube Analytics API). Feeds the dashboard's Analytics tab and
 * GET /api/analytics/youtube. YouTube Analytics runs 2-3 days behind; `dataThrough` says up to which day.
 */

export interface Totals {
  views: number;
  watchHours: number;
  avgViewSec: number;
  avgViewPct: number;
  subsGained: number;
  subsLost: number;
  likes: number;
  comments: number;
  shares: number;
}

export interface DayPoint extends Totals { day: string }

export interface VideoRow {
  id: string;
  title: string;
  publishedAt?: string;
  lengthSec?: number;
  isShort?: boolean;
  views: number;
  avgViewSec: number;
  avgViewPct: number;
  likes: number;
  comments: number;
  shares: number;
  subsGained: number;
  /** from our own upload history: the Short format and the source reel it was made from */
  format?: string;
  source?: string;
}

export interface FormatRow { format: string; videos: number; medianViews: number; avgViews: number; avgViewPct: number }

export interface ChannelAnalytics {
  key: string;
  name: string;
  error?: string;
  subscribers?: number;
  lifetimeViews?: number;
  videoCount?: number;
  current?: Totals;
  previous?: Totals;
  daily?: DayPoint[];
  topVideos?: VideoRow[];
  uploads?: VideoRow[];
  traffic?: Array<{ source: string; views: number }>;
  contentTypes?: Array<{ type: string; views: number; avgViewSec: number }>;
  formats?: FormatRow[];
  insights?: string[];
}

export interface AnalyticsReport {
  generatedAt: string;
  rangeDays: number;
  startDate: string;
  endDate: string;
  /** the last day YouTube already has data for (it runs 2-3 days behind) */
  dataThrough?: string;
  channels: ChannelAnalytics[];
}

const METRICS = "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares";

const day = (offset: number, from = new Date()): string => new Date(from.getTime() - offset * 864e5).toISOString().slice(0, 10);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const round = (v: number, d = 1): number => Math.round(v * 10 ** d) / 10 ** d;

/** Sums daily rows into period totals: averages are weighted by views (as YouTube does). */
export function sumDays(rows: DayPoint[]): Totals {
  const views = rows.reduce((s, r) => s + r.views, 0);
  const w = (k: "avgViewSec" | "avgViewPct") => (views ? rows.reduce((s, r) => s + r[k] * r.views, 0) / views : 0);
  const sum = (k: keyof Totals) => rows.reduce((s, r) => s + (r[k] as number), 0);
  return {
    views,
    watchHours: round(sum("watchHours")),
    avgViewSec: round(w("avgViewSec")),
    avgViewPct: round(w("avgViewPct")),
    subsGained: sum("subsGained"),
    subsLost: sum("subsLost"),
    likes: sum("likes"),
    comments: sum("comments"),
    shares: sum("shares"),
  };
}

/** Parses an Analytics API answer (columnHeaders + rows) into objects keyed by column name. */
export function rowsOf(data: { columnHeaders?: Array<{ name?: string | null }> | null; rows?: unknown[][] | null }): Record<string, unknown>[] {
  const cols = (data.columnHeaders ?? []).map((c) => c.name ?? "");
  return (data.rows ?? []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

const toDay = (r: Record<string, unknown>): DayPoint => ({
  day: String(r.day),
  views: num(r.views),
  watchHours: round(num(r.estimatedMinutesWatched) / 60, 2),
  avgViewSec: num(r.averageViewDuration),
  avgViewPct: num(r.averageViewPercentage),
  subsGained: num(r.subscribersGained),
  subsLost: num(r.subscribersLost),
  likes: num(r.likes),
  comments: num(r.comments),
  shares: num(r.shares),
});

/** ISO 8601 duration ("PT1M3S") in seconds. */
export function isoSeconds(d: string | null | undefined): number | undefined {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d ?? "");
  return m ? num(m[1]) * 3600 + num(m[2]) * 60 + num(m[3]) : undefined;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Views per Short format among the uploads of the period (only uploads we know the format of). */
export function formatTable(uploads: VideoRow[]): FormatRow[] {
  const by = new Map<string, VideoRow[]>();
  for (const v of uploads) {
    const f = v.format || (v.isShort === false ? "long video" : "");
    if (!f) continue;
    by.set(f, [...(by.get(f) ?? []), v]);
  }
  return [...by.entries()]
    .map(([format, vs]) => ({
      format,
      videos: vs.length,
      medianViews: median(vs.map((v) => v.views)),
      avgViews: round(vs.reduce((s, v) => s + v.views, 0) / vs.length),
      avgViewPct: round(vs.reduce((s, v) => s + v.avgViewPct, 0) / vs.length),
    }))
    .sort((a, b) => b.medianViews - a.medianViews);
}

const pct = (a: number, b: number): number | undefined => (b > 0 ? Math.round(((a - b) / b) * 100) : undefined);

/** Plain-language findings: what is working, what is not, what to try. Rule-based, from the numbers only. */
export function insightsFor(c: ChannelAnalytics): string[] {
  const out: string[] = [];
  const cur = c.current, prev = c.previous;
  if (!cur) return out;
  const d = pct(cur.views, prev?.views ?? 0);
  if (d !== undefined) out.push(`Views ${d >= 0 ? "up" : "down"} ${Math.abs(d)}% on the previous period (${cur.views.toLocaleString("en-IN")} vs ${(prev?.views ?? 0).toLocaleString("en-IN")}).`);
  const top = c.topVideos?.[0];
  if (top && cur.views > 0) {
    const share = Math.round((top.views / cur.views) * 100);
    if (share >= 40) out.push(`${share}% of the period's views come from one video ("${top.title.slice(0, 60)}"): make more like it (same topic and format).`);
  }
  const net = cur.subsGained - cur.subsLost;
  if (cur.views >= 500) out.push(`${round((net / cur.views) * 1000, 2)} net subscribers per 1,000 views (${net >= 0 ? "+" : ""}${net} in the period).`);
  const shorts = c.contentTypes?.find((t) => /short/i.test(t.type));
  const longs = c.contentTypes?.find((t) => /video_on_demand|vod/i.test(t.type));
  if (shorts && longs && cur.views > 0) {
    out.push(`Shorts bring ${Math.round((shorts.views / cur.views) * 100)}% of views; long videos ${Math.round((longs.views / cur.views) * 100)}%.`);
  }
  const fmts = (c.formats ?? []).filter((f) => f.videos >= 3);
  if (fmts.length >= 2) {
    const [best, worst] = [fmts[0], fmts[fmts.length - 1]];
    out.push(`Best format so far: ${best.format} (median ${best.medianViews} views over ${best.videos} uploads); weakest: ${worst.format} (median ${worst.medianViews}).`);
  }
  const ups = c.uploads ?? [];
  if (ups.length >= 3) {
    const zero = ups.filter((v) => v.views < 10).length;
    if (zero / ups.length >= 0.5) out.push(`${zero} of ${ups.length} uploads in the period have under 10 views: the feed is not testing them; fewer, stronger uploads may do better.`);
    const lowRet = ups.filter((v) => v.isShort && v.views >= 20 && v.avgViewPct < 50);
    if (lowRet.length) out.push(`${lowRet.length} Short(s) are watched less than halfway on average: tighten the first 2 seconds or shorten them.`);
  }
  const search = c.traffic?.find((t) => /yt_search/i.test(t.source));
  if (search && cur.views > 0 && search.views / cur.views >= 0.15) out.push(`${Math.round((search.views / cur.views) * 100)}% of views come from YouTube search: titles with clear keywords are paying off.`);
  return out;
}

/** Our upload history: video id -> format / source reel, from reel_history. */
async function uploadFacts(profileKey: string): Promise<Map<string, { format?: string; source?: string }>> {
  const map = new Map<string, { format?: string; source?: string }>();
  try {
    const pool = await getPool();
    const r = await pool.query(
      `SELECT youtube_video_id, format, shortcode FROM reel_history WHERE LOWER(profile_key) = LOWER($1) AND youtube_video_id IS NOT NULL`,
      [profileKey],
    );
    for (const row of r.rows) map.set(row.youtube_video_id, { format: row.format ?? undefined, source: row.shortcode });
  } catch (e) {
    pipelineLogger.warn(`[YTAnalytics] reel_history unavailable for ${profileKey}: ${(e as Error).message}`, "Analytics");
  }
  return map;
}

function authFor(p: ChannelProfile, storedConfig?: StoredChannelConfig) {
  const token =
    p.youtube?.channels?.find((c) => c.refreshToken)?.refreshToken ||
    storedConfig?.youtubeChannels?.find((c) => c.refreshToken)?.refreshToken ||
    storedConfig?.youtubeRefreshToken ||
    (p.isDefault ? process.env.YOUTUBE_REFRESH_TOKEN : undefined);
  const clientId =
    storedConfig?.youtubeClientId || p.youtube?.clientId || process.env.YOUTUBE_CLIENT_ID;
  const clientSecret =
    storedConfig?.youtubeClientSecret || p.youtube?.clientSecret || process.env.YOUTUBE_CLIENT_SECRET;
  if (!token || !clientId || !clientSecret) return null;
  const o = new google.auth.OAuth2(clientId, clientSecret);
  o.setCredentials({ refresh_token: token });
  return o;
}

async function videoDetails(yt: youtube_v3.Youtube, ids: string[]): Promise<Map<string, youtube_v3.Schema$Video>> {
  const out = new Map<string, youtube_v3.Schema$Video>();
  for (let i = 0; i < ids.length; i += 50) {
    const r = await yt.videos.list({ part: ["snippet", "contentDetails", "statistics"], id: ids.slice(i, i + 50), maxResults: 50 });
    for (const v of r.data.items ?? []) if (v.id) out.set(v.id, v);
  }
  return out;
}

/** Everything the dashboard shows for one channel. Never throws: a problem becomes `error`. */
export async function channelAnalytics(p: ChannelProfile, rangeDays: number, storedConfig?: StoredChannelConfig): Promise<ChannelAnalytics> {
  const base: ChannelAnalytics = { key: p.key, name: p.brandName };
  const auth = authFor(p, storedConfig);
  if (!auth) return { ...base, error: "No YouTube login stored for this channel" };
  const yta = google.youtubeAnalytics({ version: "v2", auth });
  const yt = google.youtube({ version: "v3", auth });
  const endDate = day(0);
  const startDate = day(rangeDays - 1);
  const prevStart = day(2 * rangeDays - 1);
  const ids = "channel==MINE";
  try {
    const [ch, daysRes, vidsRes] = await Promise.all([
      yt.channels.list({ part: ["statistics", "contentDetails"], mine: true }),
      yta.reports.query({ ids, startDate: prevStart, endDate, metrics: METRICS, dimensions: "day", sort: "day" }),
      yta.reports.query({ ids, startDate, endDate, metrics: METRICS.replace("estimatedMinutesWatched,", "").replace("subscribersLost,", ""), dimensions: "video", sort: "-views", maxResults: 25 }),
    ]);
    const stats = ch.data.items?.[0]?.statistics;
    const uploadsPlaylist = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

    const allDays = rowsOf(daysRes.data).map(toDay);
    const daily = allDays.filter((d) => d.day >= startDate);
    const previous = allDays.filter((d) => d.day < startDate);

    // optional breakdowns: an older API project may not offer every dimension, so each one fails on its own
    const [traffic, contentTypes] = await Promise.all([
      yta.reports.query({ ids, startDate, endDate, metrics: "views", dimensions: "insightTrafficSourceType", sort: "-views" })
        .then((r) => rowsOf(r.data).map((x) => ({ source: String(x.insightTrafficSourceType), views: num(x.views) })))
        .catch(() => undefined),
      yta.reports.query({ ids, startDate, endDate, metrics: "views,averageViewDuration", dimensions: "creatorContentType", sort: "-views" })
        .then((r) => rowsOf(r.data).map((x) => ({ type: String(x.creatorContentType), views: num(x.views), avgViewSec: num(x.averageViewDuration) })))
        .catch(() => undefined),
    ]);

    // uploads of the period (newest first), so a video with no views still shows up
    const uploadIds: string[] = [];
    if (uploadsPlaylist) {
      let pageToken: string | undefined;
      for (let page = 0; page < 4; page++) {
        const r = await yt.playlistItems.list({ part: ["contentDetails"], playlistId: uploadsPlaylist, maxResults: 50, pageToken });
        const items = r.data.items ?? [];
        for (const it of items) {
          const at = it.contentDetails?.videoPublishedAt ?? "";
          if (at && at.slice(0, 10) >= startDate && it.contentDetails?.videoId) uploadIds.push(it.contentDetails.videoId);
        }
        const oldest = items[items.length - 1]?.contentDetails?.videoPublishedAt ?? "";
        pageToken = r.data.nextPageToken ?? undefined;
        if (!pageToken || (oldest && oldest.slice(0, 10) < startDate)) break;
      }
    }

    const facts = await uploadFacts(p.key);
    const topRows = rowsOf(vidsRes.data);
    const details = await videoDetails(yt, [...new Set([...topRows.map((r) => String(r.video)), ...uploadIds])]);

    // per-video analytics for uploads outside the top list (one query, filtered by id)
    const perVideo = new Map(topRows.map((r) => [String(r.video), r]));
    const missing = uploadIds.filter((id) => !perVideo.has(id));
    for (let i = 0; i < missing.length; i += 200) {
      const r = await yta.reports.query({
        ids, startDate, endDate, dimensions: "video", filters: `video==${missing.slice(i, i + 200).join(",")}`,
        metrics: "views,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained",
      }).catch(() => undefined);
      for (const row of r ? rowsOf(r.data) : []) perVideo.set(String(row.video), row);
    }

    const toVideo = (id: string): VideoRow => {
      const a = perVideo.get(id) ?? {};
      const v = details.get(id);
      const lengthSec = isoSeconds(v?.contentDetails?.duration);
      const f = facts.get(id);
      return {
        id,
        title: v?.snippet?.title ?? id,
        publishedAt: v?.snippet?.publishedAt ?? undefined,
        lengthSec,
        isShort: lengthSec !== undefined ? lengthSec <= 180 : undefined,
        views: num(a.views),
        avgViewSec: num(a.averageViewDuration),
        avgViewPct: round(num(a.averageViewPercentage)),
        likes: num(a.likes),
        comments: num(a.comments),
        shares: num(a.shares),
        subsGained: num(a.subscribersGained),
        format: f?.format,
        source: f?.source,
      };
    };

    const report: ChannelAnalytics = {
      ...base,
      subscribers: num(stats?.subscriberCount),
      lifetimeViews: num(stats?.viewCount),
      videoCount: num(stats?.videoCount),
      current: sumDays(daily),
      previous: sumDays(previous),
      daily,
      topVideos: topRows.map((r) => toVideo(String(r.video))),
      uploads: uploadIds.map(toVideo),
      traffic,
      contentTypes,
    };
    report.formats = formatTable(report.uploads ?? []);
    report.insights = insightsFor(report);
    return report;
  } catch (e) {
    const msg = (e as { errors?: Array<{ message?: string }>; message?: string }).errors?.[0]?.message ?? (e as Error).message;
    pipelineLogger.warn(`[YTAnalytics] ${p.brandName}: ${msg}`, "Analytics");
    return { ...base, error: msg.slice(0, 300) };
  }
}

const cache = new Map<number, { at: number; report: AnalyticsReport }>();
const CACHE_MS = 30 * 60_000;

/** All channels for the last `rangeDays` days; cached for 30 minutes (refresh=true skips the cache). */
export async function youtubeAnalyticsReport(rangeDays = 28, refresh = false): Promise<AnalyticsReport> {
  const days = Math.min(365, Math.max(7, Math.round(rangeDays) || 28));
  const hit = cache.get(days);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.report;

  let storedConfigs: StoredChannelConfig[] = [];
  try {
    storedConfigs = await getAllStoredChannelConfigs();
  } catch {}

  const profiles = config.profiles.filter((p) => {
    const sc = storedConfigs.find((s) => (s.key || "").toLowerCase() === (p.key || "").toLowerCase());
    const hasToken =
      p.youtube?.channels?.some((c) => c.refreshToken) ||
      sc?.youtubeChannels?.some((c) => c.refreshToken) ||
      sc?.youtubeRefreshToken ||
      (p.isDefault && process.env.YOUTUBE_REFRESH_TOKEN);
    return !p.isWatchOnly || hasToken;
  });

  const channels = await Promise.all(
    profiles.map((p) => {
      const sc = storedConfigs.find((s) => (s.key || "").toLowerCase() === (p.key || "").toLowerCase());
      return channelAnalytics(p, days, sc);
    }),
  );
  const lastDays = channels.flatMap((c) => (c.daily ?? []).filter((d) => d.views > 0 || d.watchHours > 0).map((d) => d.day)).sort();
  const report: AnalyticsReport = {
    generatedAt: new Date().toISOString(),
    rangeDays: days,
    startDate: day(days - 1),
    endDate: day(0),
    dataThrough: lastDays[lastDays.length - 1],
    channels,
  };
  cache.set(days, { at: Date.now(), report });
  return report;
}
