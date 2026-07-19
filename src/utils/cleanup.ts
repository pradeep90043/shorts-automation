import fs from "fs";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "./logger";

// Both temp/gen-<id>/ working directories and the local output/*.mp4 copies
// are only needed while a job is in flight — the video itself lives on
// YouTube/Instagram once published. Anything older than this has either
// long since finished (uploaded or failed) or is abandoned; nothing in this
// pipeline holds a temp/output file open across a multi-day gap.
const RETENTION_MS = 24 * 60 * 60 * 1000;

function isOlderThanRetention(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > RETENTION_MS;
}

/**
 * Deletes stale per-job temp directories and rendered output files so disk
 * usage doesn't grow unbounded across every run the pipeline has ever done.
 */
export function cleanupOldMedia(): void {
  const now = Date.now();
  let freedBytes = 0;
  let removedDirs = 0;
  let removedFiles = 0;

  const tempDir = config.paths.tempDir;
  if (fs.existsSync(tempDir)) {
    for (const entry of fs.readdirSync(tempDir)) {
      const entryPath = path.join(tempDir, entry);
      try {
        const stat = fs.statSync(entryPath);
        if (!stat.isDirectory() || !isOlderThanRetention(stat.mtimeMs, now)) {
          continue;
        }
        freedBytes += dirSize(entryPath);
        fs.rmSync(entryPath, { recursive: true, force: true });
        removedDirs++;
      } catch (err) {
        pipelineLogger.warn(
          `Failed to clean up temp entry ${entryPath}: ${err instanceof Error ? err.message : err}`,
          "Cleanup",
        );
      }
    }
  }

  const outputDir = config.paths.outputDir;
  if (fs.existsSync(outputDir)) {
    for (const entry of fs.readdirSync(outputDir)) {
      const entryPath = path.join(outputDir, entry);
      try {
        const stat = fs.statSync(entryPath);
        if (!stat.isFile() || !isOlderThanRetention(stat.mtimeMs, now)) {
          continue;
        }
        freedBytes += stat.size;
        fs.rmSync(entryPath, { force: true });
        removedFiles++;
      } catch (err) {
        pipelineLogger.warn(
          `Failed to clean up output file ${entryPath}: ${err instanceof Error ? err.message : err}`,
          "Cleanup",
        );
      }
    }
  }

  if (removedDirs > 0 || removedFiles > 0) {
    pipelineLogger.info(
      `Cleanup: removed ${removedDirs} stale temp dir(s) and ${removedFiles} old output file(s), freeing ${(freedBytes / (1024 * 1024)).toFixed(1)} MB`,
      "Cleanup",
    );
  }
}

function dirSize(dirPath: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    total += entry.isDirectory()
      ? dirSize(entryPath)
      : fs.statSync(entryPath).size;
  }
  return total;
}
