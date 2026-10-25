/** One published Short of the format experiment: its format and its views so far. */
export interface FormatSample { format: string; views: number; likes?: number }

export interface FormatSummary { format: string; n: number; mean: number; median: number; likesPerView: number; vsBaseline: number }

const median = (a: number[]): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Per-format results. `vsBaseline` = the format's median views divided by the median of the channel's other recent Shorts
 * (`baseline` views), so a format is judged against what the channel does anyway, not in absolute numbers.
 */
export function summarizeFormats(samples: FormatSample[], baseline: number[] = []): FormatSummary[] {
  const base = median(baseline);
  const by = new Map<string, FormatSample[]>();
  for (const s of samples) by.set(s.format, [...(by.get(s.format) ?? []), s]);
  return [...by.entries()]
    .map(([format, rows]) => {
      const views = rows.map((r) => r.views);
      const total = views.reduce((a, b) => a + b, 0);
      const likes = rows.reduce((a, r) => a + (r.likes ?? 0), 0);
      return {
        format,
        n: rows.length,
        mean: total / rows.length,
        median: median(views),
        likesPerView: total ? likes / total : 0,
        vsBaseline: base > 0 ? median(views) / base : 0,
      };
    })
    .sort((a, b) => b.median - a.median || b.mean - a.mean);
}

/** A plain-text table for the console / a message. */
export function formatReportTable(rows: FormatSummary[]): string {
  const head = "format         n   median   mean   likes/view   x baseline";
  const line = (r: FormatSummary) =>
    `${r.format.padEnd(13)} ${String(r.n).padStart(3)}  ${r.median.toFixed(1).padStart(7)} ${r.mean.toFixed(1).padStart(6)}   ${(r.likesPerView * 100).toFixed(1).padStart(8)}%   ${r.vsBaseline ? r.vsBaseline.toFixed(2) + "x" : "-"}`;
  return [head, ...rows.map(line)].join("\n");
}
