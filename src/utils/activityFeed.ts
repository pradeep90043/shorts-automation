import fs from "fs";
import path from "path";

/**
 * Dashboard "Recent Processing Activity" feed.
 *
 * reel_history alone can't tell the story: every reel of a daily batch is reserved at the same
 * instant (picked_at) and a row with no `failed` flag used to be labelled PUBLISHED even if it was
 * only queued. This joins reel_history + the watch queue + the job record (logs/jobs_db_*.json)
 * so each row carries its own timeline, real status, links and generated metadata.
 * Only whitelisted, display-safe fields are copied out of the (large) job context dump.
 */

export type ActivityStatus = "published" | "failed" | "in_review" | "in_progress" | "queued" | "picked";

export interface ActivityItem {
  shortcode: string;
  profileKey: string;
  channelKey: string; // config profile key (e.g. codeorcap) — what the dashboard channel filter uses
  brandName: string;
  sourceUrl: string;
  creator: string;
  status: ActivityStatus;
  statusLabel: string;
  step: string;
  jobId: string;
  pickedAt: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  publishedAt: string | null;
  durationSec: number | null;
  activityAt: string | null;
  youtubeUrl: string;
  instagramUrl: string;
  facebookUrl: string;
  title: string;
  description: string;
  hashtags: string[];
  mood: string;
  music: string;
  hasVoiceover: boolean | null;
  hasOriginalAudio: boolean | null;
  transcriptWords: number | null;
  audioCopyright: string;
  failedReason: string;
}

export interface JobSummary {
  id: string;
  status: string;
  currentStep: string;
  createdAt: string;
  updatedAt: string;
  error: string;
  youtubeUrl: string;
  instagramUrl: string;
  facebookUrl: string;
  title: string;
  description: string;
  hashtags: string[];
  mood: string;
  music: string;
  hasVoiceover: boolean | null;
  hasOriginalAudio: boolean | null;
  transcriptWords: number | null;
  audioCopyright: string;
  creator: string;
  shortcode: string;
}

const STATUS_LABEL: Record<ActivityStatus, string> = {
  published: "PUBLISHED",
  failed: "FAILED",
  in_review: "IN REVIEW",
  in_progress: "IN PROGRESS",
  queued: "QUEUED",
  picked: "PICKED",
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(v as any);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

export function summarizeJob(job: any): JobSummary {
  const ctx = job?.context || {};
  const meta = job?.metadata || ctx.metadata || {};
  const words = ctx.transcript && Array.isArray(ctx.transcript.words) ? ctx.transcript.words.length : null;
  const cr = ctx.originalAudioCopyright;
  const tags: string[] = Array.isArray(meta.hashtags) && meta.hashtags.length ? meta.hashtags : Array.isArray(meta.tags) ? meta.tags : [];
  return {
    id: str(job?.id),
    status: str(job?.status),
    currentStep: str(job?.currentStep),
    createdAt: str(job?.createdAt),
    updatedAt: str(job?.updatedAt),
    error: str(job?.error) || str(ctx.error),
    youtubeUrl: str(job?.youtubeUrl),
    instagramUrl: str(job?.instagramUrl),
    facebookUrl: str(job?.facebookUrl),
    title: str(meta.title),
    description: str(meta.description),
    hashtags: tags.filter((t) => typeof t === "string").slice(0, 30),
    mood: str(meta.mood),
    music: str(ctx.selectedMusicTrack),
    hasVoiceover: typeof ctx.useVoiceover === "boolean" ? ctx.useVoiceover : null,
    hasOriginalAudio: typeof ctx.hasOriginalAudio === "boolean" ? ctx.hasOriginalAudio : null,
    transcriptWords: words,
    audioCopyright: cr && cr.matched ? `${str(cr.title) || "copyrighted audio"}${cr.artist ? " — " + str(cr.artist) : ""}` : "",
    creator: str(ctx.sourceCreatorUsername) || str(ctx.channel),
    shortcode: str(ctx.shortcode),
  };
}

// jobs_db_*.json is ~10 MB; reparse only when the file actually changed.
const jobCache = new Map<string, { sig: string; byId: Map<string, JobSummary>; byShortcode: Map<string, JobSummary> }>();

export function loadJobSummaries(file: string) {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = jobCache.get(file);
  if (hit && hit.sig === sig) return hit;
  const byId = new Map<string, JobSummary>();
  const byShortcode = new Map<string, JobSummary>();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
    for (const job of Object.values(raw)) {
      const s = summarizeJob(job);
      if (!s.id) continue;
      byId.set(s.id, s);
      // newest job wins when a shortcode was processed more than once
      if (s.shortcode) {
        const prev = byShortcode.get(s.shortcode);
        if (!prev || prev.createdAt < s.createdAt) byShortcode.set(s.shortcode, s);
      }
    }
  } catch {
    return null;
  }
  const entry = { sig, byId, byShortcode };
  jobCache.set(file, entry);
  return entry;
}

export function jobsFileFor(logDir: string, profile: { key: string; isDefault?: boolean }): string {
  return path.join(logDir, profile.isDefault ? "jobs_db.json" : `jobs_db_${profile.key}.json`);
}

export interface FeedInput {
  history: any[]; // reel_history rows
  queues: Record<string, any[]>; // reel_history/watch_state profile_key -> queue items
  profiles: Array<{ key: string; brandName: string; isDefault?: boolean }>;
  jobsFor: (profile: { key: string; isDefault?: boolean }) => { byId: Map<string, JobSummary>; byShortcode: Map<string, JobSummary> } | null;
  limit?: number;
}

export function buildActivityFeed(input: FeedInput): ActivityItem[] {
  const profileByDbKey = new Map<string, FeedInput["profiles"][number]>();
  for (const p of input.profiles) {
    profileByDbKey.set(p.isDefault ? "default" : p.key.toLowerCase(), p);
    profileByDbKey.set(p.key.toLowerCase(), p);
  }

  const items: ActivityItem[] = [];
  for (const h of input.history) {
    const shortcode = str(h.shortcode);
    if (!shortcode || shortcode.startsWith("failed-fetch-") || shortcode.startsWith("no-unseen-")) continue;

    const rowKey = str(h.profile_key).toLowerCase() || "default";
    const profile = profileByDbKey.get(rowKey);
    const brandName = profile?.brandName || rowKey;
    const queueItem = (input.queues[rowKey] || input.queues[profile?.key.toLowerCase() || ""] || []).find(
      (q) => q && q.shortcode === shortcode,
    );
    const jobs = profile ? input.jobsFor(profile) : null;
    const job = (queueItem?.jobId && jobs?.byId.get(queueItem.jobId)) || jobs?.byShortcode.get(shortcode) || null;

    const publishedAt = iso(h.published_at) || (queueItem?.published ? iso(queueItem?.publishedAt) : null);
    const failed = !!h.failed || !!queueItem?.failed || job?.status === "failed";
    let status: ActivityStatus;
    if (publishedAt || (queueItem?.published && !failed)) status = "published";
    else if (failed) status = "failed";
    else if (job && (job.status === "final_review" || job.status === "settings_review")) status = "in_review";
    else if (job && job.status !== "completed") status = "in_progress";
    else if (job && job.status === "completed") status = "in_review"; // rendered, awaiting upload
    else if (queueItem && !queueItem.fired) status = "queued";
    else if (queueItem?.fired) status = "in_progress";
    else status = "picked";

    const startedAt = iso(job?.createdAt);
    const updatedAt = iso(job?.updatedAt);
    const endMs = new Date((publishedAt || (status === "failed" || status === "in_review" ? updatedAt : null)) || 0).getTime();
    const durationSec =
      startedAt && endMs > 0 && endMs >= new Date(startedAt).getTime() ? Math.round((endMs - new Date(startedAt).getTime()) / 1000) : null;

    const pickedAt = iso(h.picked_at);
    const scheduledAt = iso(queueItem?.scheduledAt);
    items.push({
      shortcode,
      profileKey: rowKey,
      channelKey: profile ? profile.key.toLowerCase() : rowKey,
      brandName,
      sourceUrl: `https://www.instagram.com/reel/${shortcode}/`,
      creator: str(queueItem?.channel) !== "manual_inject" && str(queueItem?.channel) ? str(queueItem?.channel) : job?.creator || str(h.channel),
      status,
      statusLabel: STATUS_LABEL[status],
      step: status === "published" ? "Published" : job?.currentStep || (status === "queued" ? "Waiting for its slot" : ""),
      jobId: str(queueItem?.jobId) || job?.id || "",
      pickedAt,
      scheduledAt,
      startedAt,
      updatedAt,
      publishedAt,
      durationSec,
      activityAt: publishedAt || updatedAt || scheduledAt || pickedAt,
      youtubeUrl: str(h.youtube_url) || str(queueItem?.publishedYoutubeUrl) || job?.youtubeUrl || "",
      instagramUrl: str(h.instagram_url) || str(queueItem?.publishedInstagramUrl) || job?.instagramUrl || "",
      facebookUrl: str(h.facebook_url) || str(queueItem?.publishedFacebookUrl) || job?.facebookUrl || "",
      title: job?.title || "",
      description: job?.description || "",
      hashtags: job?.hashtags || [],
      mood: job?.mood || "",
      music: job?.music || "",
      hasVoiceover: job?.hasVoiceover ?? null,
      hasOriginalAudio: job?.hasOriginalAudio ?? null,
      transcriptWords: job?.transcriptWords ?? null,
      audioCopyright: job?.audioCopyright || "",
      failedReason: status === "failed" ? str(h.failed_reason) || str(queueItem?.failedReason) || job?.error || "No reason recorded" : "",
    });
  }

  items.sort((a, b) => new Date(b.activityAt || 0).getTime() - new Date(a.activityAt || 0).getTime());
  return items.slice(0, input.limit ?? 30);
}
