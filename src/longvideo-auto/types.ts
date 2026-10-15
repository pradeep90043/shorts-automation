/** A Short that was published today and could become the seed of the channel's 10-minute video. */
export interface LongCandidate {
  channelKey: string;
  shortcode: string;
  /** IST calendar date (YYYY-MM-DD) the Short was published on */
  istDate: string;
  publishedAt: string;
  title: string;
  /** what the reel says: speech transcript, caption and the "how it works" / moral / opinion line, merged */
  text: string;
  sourceUrl?: string;
  youtubeUrl?: string;
  playCount: number;
  likeCount: number;
  commentCount: number;
  /** 0-100 viral score at pick time (src/utils/viralScore.ts), 0 when unknown */
  viralScore: number;
  /** set once this candidate was chosen, so it is never used twice */
  usedForLongAt?: string;
}

export interface RankedCandidate extends LongCandidate {
  score: number;
  parts: { viral: number; substance: number; potential: number };
}

/** One 10-minute video to make: the seed plus the day it was ranked for. */
export interface LongRequest {
  id: string; // `${istDate}:${channelKey}`: one per channel per day, also the dedupe key
  channelKey: string;
  istDate: string;
  seed: LongCandidate;
  /** the runner-up, used when the first seed cannot be turned into a script */
  fallback?: LongCandidate;
  status: "queued" | "running" | "done" | "failed" | "skipped";
  /** made on demand from the dashboard: go public right after upload instead of waiting for the evening slot */
  publishNow?: boolean;
  attempts: number;
  /** a failed attempt is retried no earlier than this (epoch ms) */
  notBeforeMs?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** when the finished video goes public (ISO), assigned from the release slots */
  releaseAt?: string;
  videoUrl?: string;
  jobId?: string;
}
