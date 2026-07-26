export interface ReelEngagementData {
  playCount: number;
  likeCount: number;
  commentCount: number;
}

/**
 * Compute a 0–100 viral score for one reel relative to the batch maximums.
 * Weights: play_count 50%, like_count 30%, comment_count 20%.
 * Each metric is normalized [0, 1] against the batch max before weighting.
 */
export function computeViralScore(
  reel: ReelEngagementData,
  batchMax: ReelEngagementData,
): number {
  const norm = (val: number, max: number) => (max > 0 ? val / max : 0);
  const raw =
    norm(reel.playCount, batchMax.playCount) * 50 +
    norm(reel.likeCount, batchMax.likeCount) * 30 +
    norm(reel.commentCount, batchMax.commentCount) * 20;
  return Math.round(Math.min(100, raw));
}

/**
 * Score the entire batch relative to its own maximums, attach viralScore to
 * each item, and return them sorted descending by viralScore.
 */
export function scoreAndSort<T extends ReelEngagementData>(
  reels: T[],
): (T & { viralScore: number })[] {
  if (reels.length === 0) return [];

  const batchMax: ReelEngagementData = {
    playCount: Math.max(1, ...reels.map((r) => r.playCount)),
    likeCount: Math.max(1, ...reels.map((r) => r.likeCount)),
    commentCount: Math.max(1, ...reels.map((r) => r.commentCount)),
  };

  return reels
    .map((r) => ({ ...r, viralScore: computeViralScore(r, batchMax) }))
    .sort((a, b) => b.viralScore - a.viralScore);
}

/**
 * Keep only reels at or above the threshold.
 * Fail-open: if the result would be empty, returns the full sorted list so
 * the queue never starves due to an overly aggressive threshold.
 */
export function filterViral<T extends { viralScore: number }>(
  reels: T[],
  threshold: number,
): T[] {
  if (threshold <= 0) return reels;
  const filtered = reels.filter((r) => r.viralScore >= threshold);
  return filtered.length > 0 ? filtered : reels;
}
