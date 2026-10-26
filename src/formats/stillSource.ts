import { execFile } from "child_process";
import { config } from "../config";

/**
 * A source reel that is only a still picture (a salary table, a list card) carries nothing but its text. Showing its frames
 * adds someone else's design, and our captions end up over that text. Such a reel is rebuilt from its text with our own
 * list-card template instead (format image_music), so no source frame is used.
 */

/** Share (0-1) of the video during which the picture does not change, from ffmpeg's freezedetect. */
export function stillFraction(videoPath: string, ffmpeg = config.binaries.ffmpeg): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      ffmpeg,
      ["-hide_banner", "-i", videoPath, "-an", "-vf", "scale=270:-2,freezedetect=n=-45dB:d=0.5", "-f", "null", "-"],
      { timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
      (_err, _stdout, stderr) => resolve(frozenShare(String(stderr))),
    );
  });
}

/** Parses ffmpeg's log: frozen seconds over the total duration. A freeze still open at the end runs to the end. */
export function frozenShare(log: string): number {
  const dur = log.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const total = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  if (!total) return 0;
  const starts = [...log.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/freeze_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  let frozen = 0;
  starts.forEach((s, i) => { frozen += Math.max(0, (ends[i] ?? total) - s); });
  return Math.min(1, frozen / total);
}

const off = (v: string | undefined): boolean => /^(off|false|0|no)$/i.test((v ?? "").trim());

/** A still reel with enough on-screen text to rebuild: at least 70% frozen and some 40 characters of OCR text. */
export function isStillTextSource(frozen: number, ocrText: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (off(env.STILL_SOURCE_CARD)) return false;
  const minShare = Number(env.STILL_SOURCE_MIN_SHARE) || 0.7;
  return frozen >= minShare && (ocrText ?? "").replace(/\s+/g, " ").trim().length >= 40;
}
