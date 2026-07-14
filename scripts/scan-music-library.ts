/**
 * One-shot copyright-risk scan of the local music library.
 *
 * Usage: npm run scan:music
 *
 * Requires: fpcalc (brew install chromaprint) and ACOUSTID_API_KEY in .env
 * (free key: https://acoustid.org/new-application). Verdicts are cached in
 * <musicDir>/.copyright-cache.json, so runtime lookups during video
 * generation are instant afterwards.
 */
import fs from "fs";
import path from "path";
import { config } from "../src/config";
import { getCopyrightRisk } from "../src/audio/copyrightCheck";

const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".ogg"];
// AcoustID free tier allows 3 requests/second
const DELAY_BETWEEN_LOOKUPS_MS = 400;

function collectAudioFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectAudioFiles(full));
    } else if (AUDIO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const musicDir = config.paths.musicDir;
  if (!fs.existsSync(musicDir)) {
    console.error(`Music directory not found: ${musicDir}`);
    process.exit(1);
  }

  const files = collectAudioFiles(musicDir);
  console.log(`Scanning ${files.length} tracks in ${musicDir}\n`);

  let risky = 0;
  let unverified = 0;

  for (const file of files) {
    const risk = await getCopyrightRisk(file);
    const rel = path.relative(musicDir, file);
    const scoreLabel =
      risk.score === null ? "  ?/10" : `${String(risk.score).padStart(3)}/10`;
    const flag = risk.score !== null && risk.score >= 7 ? "⚠️ " : "   ";
    console.log(`${flag}${scoreLabel}  ${rel.padEnd(60)} ${risk.match || risk.reason}`);

    if (risk.score === null) unverified++;
    else if (risk.score >= 7) risky++;

    await sleep(DELAY_BETWEEN_LOOKUPS_MS);
  }

  const safe = files.length - risky - unverified;
  console.log(
    `\nSummary: ${safe} low-risk / ${risky} high-risk (>=7) / ${unverified} unverified`,
  );
  if (unverified > 0) {
    console.log(
      "Unverified tracks: check fpcalc installation (brew install chromaprint) and ACOUSTID_API_KEY.",
    );
  }
  process.exit(risky > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
