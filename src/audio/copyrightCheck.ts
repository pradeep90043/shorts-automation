import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";

/**
 * Copyright risk estimation for background music tracks.
 *
 * Fingerprints the track with Chromaprint (fpcalc) and looks it up on
 * AcoustID (https://acoustid.org). A strong match to a known MusicBrainz
 * recording means the track is a published/commercial recording — those are
 * the ones YouTube Content ID typically claims.
 *
 * Limitation: AcoustID only knows MusicBrainz-registered recordings, while
 * Content ID's private catalog is much larger. A low score reduces risk but
 * does not guarantee a claim-free upload; conversely, royalty-free tracks are
 * occasionally registered in Content ID by third parties, which AcoustID
 * cannot see.
 */

export interface CopyrightRisk {
  /** 0–10 risk that the track is a copyrighted recording; null = could not verify */
  score: number | null;
  /** "Artist – Title" of the best AcoustID match, when one exists */
  match?: string;
  reason: string;
  checkedAt?: string;
}

type VerdictCache = Record<string, CopyrightRisk & { file: string }>;

const ACOUSTID_LOOKUP_URL = "https://api.acoustid.org/v2/lookup";
const MIN_TRACK_DURATION_SECONDS = 10;

function cacheFilePath(): string {
  return path.join(config.paths.musicDir, ".copyright-cache.json");
}

function loadCache(): VerdictCache {
  try {
    return JSON.parse(fs.readFileSync(cacheFilePath(), "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache: VerdictCache): void {
  try {
    fs.writeFileSync(cacheFilePath(), JSON.stringify(cache, null, 2));
  } catch (err) {
    pipelineLogger.warn(
      `Could not persist copyright cache: ${err instanceof Error ? err.message : err}`,
      "CopyrightCheck",
    );
  }
}

function hashFile(filePath: string): string {
  return crypto.createHash("sha1").update(fs.readFileSync(filePath)).digest("hex");
}

interface FpcalcResult {
  duration: number;
  fingerprint: string;
}

function runFpcalc(trackPath: string): Promise<FpcalcResult> {
  return new Promise((resolve, reject) => {
    execFile(
      config.binaries.fpcalc,
      ["-json", trackPath],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve({ duration: parsed.duration, fingerprint: parsed.fingerprint });
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

interface AcoustidRecording {
  title?: string;
  artists?: Array<{ name?: string }>;
}

interface AcoustidResult {
  score?: number;
  recordings?: AcoustidRecording[];
}

function scoreFromResults(results: AcoustidResult[]): CopyrightRisk {
  let best: AcoustidResult | null = null;
  for (const result of results) {
    if (!result.recordings?.length) continue;
    if (!best || (result.score ?? 0) > (best.score ?? 0)) best = result;
  }

  if (best) {
    const recording = best.recordings![0];
    const artist = recording.artists?.[0]?.name;
    const match = [artist, recording.title].filter(Boolean).join(" – ") || undefined;
    return {
      score: Math.round((best.score ?? 0) * 10),
      match,
      reason: match
        ? `Matched known recording: ${match}`
        : "Matched a known recording",
    };
  }

  if (results.length > 0) {
    // Fingerprint recognized but no recording metadata — weak signal
    const topScore = Math.max(...results.map((r) => r.score ?? 0));
    return {
      score: Math.min(4, Math.round(topScore * 10)),
      reason: "Fingerprint partially recognized, no recording metadata",
    };
  }

  return { score: 0, reason: "No match in AcoustID database" };
}

/**
 * Estimate copyright risk for an audio file. Results are cached by content
 * hash next to the music library, so each track is only looked up once.
 * Never throws — degrades to { score: null } on any environment/network issue.
 */
export async function getCopyrightRisk(trackPath: string): Promise<CopyrightRisk> {
  if (!config.copyright.enabled) {
    return { score: null, reason: "Copyright check disabled" };
  }

  let hash: string;
  try {
    hash = hashFile(trackPath);
  } catch (err) {
    return {
      score: null,
      reason: `Could not read track: ${err instanceof Error ? err.message : err}`,
    };
  }

  const cache = loadCache();
  if (cache[hash]) {
    return cache[hash];
  }

  let fp: FpcalcResult;
  try {
    fp = await runFpcalc(trackPath);
  } catch (err) {
    const isMissing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    const reason = isMissing
      ? "fpcalc not installed (brew install chromaprint)"
      : `fpcalc failed: ${err instanceof Error ? err.message : err}`;
    pipelineLogger.warn(reason, "CopyrightCheck");
    return { score: null, reason };
  }

  if (!fp.fingerprint || fp.duration < MIN_TRACK_DURATION_SECONDS) {
    const result: CopyrightRisk = {
      score: null,
      reason: "Track too short to fingerprint reliably",
      checkedAt: new Date().toISOString(),
    };
    cache[hash] = { ...result, file: path.basename(trackPath) };
    saveCache(cache);
    return result;
  }

  if (!config.copyright.acoustidApiKey) {
    return { score: null, reason: "ACOUSTID_API_KEY not set" };
  }

  try {
    const body = new URLSearchParams({
      client: config.copyright.acoustidApiKey,
      duration: String(Math.round(fp.duration)),
      fingerprint: fp.fingerprint,
      meta: "recordings releasegroups",
    });
    const res = await fetch(ACOUSTID_LOOKUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    // AcoustID returns errors as JSON with a 4xx status, so parse the body
    // before deciding — "invalid API key" etc. should reach the user.
    const json = (await res.json().catch(() => null)) as {
      status?: string;
      results?: AcoustidResult[];
      error?: { message?: string };
    } | null;
    if (!json || json.status !== "ok") {
      return {
        score: null,
        reason: `AcoustID error: ${json?.error?.message || `HTTP ${res.status}`}`,
      };
    }

    const result: CopyrightRisk = {
      ...scoreFromResults(json.results || []),
      checkedAt: new Date().toISOString(),
    };
    cache[hash] = { ...result, file: path.basename(trackPath) };
    saveCache(cache);
    pipelineLogger.info(
      `Copyright risk for ${path.basename(trackPath)}: ${result.score}/10 (${result.reason})`,
      "CopyrightCheck",
    );
    return result;
  } catch (err) {
    const reason = `AcoustID lookup failed: ${err instanceof Error ? err.message : err}`;
    pipelineLogger.warn(reason, "CopyrightCheck");
    return { score: null, reason };
  }
}

/** Human-readable caption fragment, e.g. "©️ risk 9/10 ⚠️ (Kevin MacLeod – Sneaky Snitch)" */
export function formatRisk(risk: CopyrightRisk): string {
  if (risk.score === null) {
    return `©️ risk: unverified (${risk.reason})`;
  }
  const warning = risk.score >= 7 ? " ⚠️" : "";
  const match = risk.match ? ` (${risk.match})` : "";
  return `©️ risk ${risk.score}/10${warning}${match}`;
}
