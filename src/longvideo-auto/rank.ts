import type { LongCandidate, RankedCandidate } from "./types";

export interface RankOptions {
  /** weights, summing to 1 */
  wViral: number;
  wSubstance: number;
  wPotential: number;
  /** candidates with fewer words than this cannot carry a 10-minute video (they are still ranked last, never picked) */
  minWords: number;
}

export const DEFAULT_RANK: RankOptions = { wViral: 0.6, wSubstance: 0.25, wPotential: 0.15, minWords: 12 };

export const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * 0-100: how much there is to expand. Words (up to 120), an explanatory line, and a real title.
 * Deterministic: the same candidate always gets the same number.
 */
export function substanceScore(c: Pick<LongCandidate, "title" | "text">): number {
  const words = wordCount(c.text);
  const wordPart = Math.min(1, words / 120);
  // an explanation/moral/opinion line is merged into text as "X: ..." by the recorder; a longer text is the proxy here
  const structured = /[.!?।]\s+\S/.test(c.text) ? 1 : 0;
  const titled = wordCount(c.title) >= 3 ? 1 : 0;
  return Math.round(100 * (0.6 * wordPart + 0.25 * structured + 0.15 * titled));
}

/**
 * Ranks one channel's candidates for the day, best first.
 * `potential` (0-100) is an optional LLM judgement by shortcode; missing = a neutral 50 so an LLM outage changes nothing.
 */
export function rankCandidates(
  candidates: LongCandidate[],
  potential: Record<string, number> = {},
  opts: RankOptions = DEFAULT_RANK,
): RankedCandidate[] {
  const maxViral = Math.max(1, ...candidates.map((c) => c.viralScore || 0));
  return candidates
    .filter((c) => !c.usedForLongAt)
    .map((c) => {
      const viral = Math.round(((c.viralScore || 0) / maxViral) * 100);
      const substance = substanceScore(c);
      const pot = Math.max(0, Math.min(100, potential[c.shortcode] ?? 50));
      const thin = wordCount(c.text) < opts.minWords;
      const score = thin ? 0 : Math.round((opts.wViral * viral + opts.wSubstance * substance + opts.wPotential * pot) * 10) / 10;
      return { ...c, score, parts: { viral, substance, potential: pot } };
    })
    .sort((a, b) => b.score - a.score || b.viralScore - a.viralScore || a.shortcode.localeCompare(b.shortcode));
}

/** The seed and its runner-up (both must clear `minWords`); null when nothing today can carry a long video. */
export function pickSeed(ranked: RankedCandidate[]): { seed: RankedCandidate; fallback?: RankedCandidate } | null {
  const ok = ranked.filter((r) => r.score > 0);
  if (!ok.length) return null;
  return { seed: ok[0], fallback: ok[1] };
}
