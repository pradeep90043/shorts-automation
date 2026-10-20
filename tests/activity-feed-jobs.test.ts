import assert from "assert";
import { buildActivityFeed, type JobSummary } from "../src/utils/activityFeed";

const job = (id: string, shortcode: string, status: string, at: string, extra: Partial<JobSummary> = {}): JobSummary => ({
  id, status, currentStep: "Voiceover", createdAt: at, updatedAt: at, error: "", youtubeUrl: "", instagramUrl: "", facebookUrl: "", title: `T ${id}`,
  description: "", hashtags: [], mood: "", music: "", hasVoiceover: null, hasOriginalAudio: null, transcriptWords: null, audioCopyright: "", creator: "", shortcode, ...extra,
});
const jobs = [job("j1", "AAA", "final_review", "2026-10-20T04:00:00Z"), job("j2", "BBB", "processing", "2026-10-20T04:30:00Z"), job("j3", "CCC", "failed", "2026-10-20T04:10:00Z", { error: "boom" })];
const byId = new Map(jobs.map((j) => [j.id, j]));
const byShortcode = new Map(jobs.map((j) => [j.shortcode, j]));

// no reel_history row at all (dashboard-injected reels in a dev session): every job still shows
const feed = buildActivityFeed({
  history: [], queues: {}, profiles: [{ key: "storiyum", brandName: "Storiyum" }],
  jobsFor: () => ({ byId, byShortcode }) as any,
});
assert.deepStrictEqual(feed.map((f) => [f.shortcode, f.status]), [["BBB", "in_progress"], ["CCC", "failed"], ["AAA", "in_review"]]);
assert.strictEqual(feed[1].failedReason, "boom");
assert.strictEqual(feed[0].brandName, "Storiyum");

// a job already shown through its reel_history row is not listed twice
const feed2 = buildActivityFeed({
  history: [{ shortcode: "AAA", profile_key: "storiyum", picked_at: "2026-10-20T03:00:00Z" }], queues: {}, profiles: [{ key: "storiyum", brandName: "Storiyum" }],
  jobsFor: () => ({ byId, byShortcode }) as any,
});
assert.strictEqual(feed2.filter((f) => f.shortcode === "AAA").length, 1);
assert.strictEqual(feed2.length, 3);
console.log("✓ activity feed lists every job, once");
