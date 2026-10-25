/**
 * Results of the Short-format experiment: views per format for every channel in the test.
 *   npx ts-node scripts/format-report.ts [profileKey] [minAgeHours=48]
 * Reads reel_history (format + YouTube video id) and asks YouTube for the current views; Shorts younger than minAgeHours are left out
 * because their numbers are not final.
 */
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });
import { config } from "../src/config";
import { getPool } from "../src/utils/pgClient";
import { YouTubeService } from "../src/youtube";
import { formatReportTable, summarizeFormats, type FormatSample } from "../src/formats/formatReport";

(async () => {
  const only = (process.argv[2] || "").toLowerCase();
  const minAgeH = Number(process.argv[3] || 48);
  const pool = await getPool();
  for (const profile of config.profiles) {
    if (only && profile.key.toLowerCase() !== only) continue;
    const { rows } = await pool.query(
      `SELECT format, youtube_video_id, published_at FROM reel_history
       WHERE profile_key = $1 AND format IS NOT NULL AND youtube_video_id IS NOT NULL AND published_at IS NOT NULL`,
      [profile.key],
    );
    if (!rows.length) continue;
    const yt = new YouTubeService(profile.youtube);
    const channel = profile.youtube.channels[0]?.name;
    if (!channel) continue;
    const samples: FormatSample[] = [];
    for (const r of rows) {
      if (Date.now() - new Date(r.published_at).getTime() < minAgeH * 3600_000) continue;
      const m = await yt.getVideoMetrics(channel, r.youtube_video_id);
      if (m) samples.push({ format: r.format, views: m.views, likes: m.likes });
    }
    console.log(`\n${profile.key} (${samples.length} Shorts older than ${minAgeH} h)`);
    console.log(formatReportTable(summarizeFormats(samples)));
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
