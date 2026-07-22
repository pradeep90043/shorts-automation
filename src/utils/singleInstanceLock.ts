import fs from "fs";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "./logger";

const LOCK_PATH = path.join(config.paths.logDir, "bot.pid");

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 does not kill the process — it only checks that it exists
    // and that we have permission to signal it.
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM"; // exists but owned by another user — treat as alive
  }
}

function releaseLock(): void {
  try {
    const raw = fs.readFileSync(LOCK_PATH, "utf8").trim();
    if (raw === String(process.pid)) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch (_) {
    // Lock already gone — nothing to do
  }
}

/**
 * Ensure only one bot process runs at a time. Multiple instances polling the
 * same Telegram bot token cause duplicate reel handling (the same message
 * gets processed by whichever instance's long-poll wins the race). Call this
 * once, at the very start of bootstrap, before any Telegram/YouTube clients
 * are constructed.
 *
 * If a live instance is already running, this logs its PID and exits rather
 * than silently starting a second poller.
 */
export function acquireSingleInstanceLock(): void {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });

  if (fs.existsSync(LOCK_PATH)) {
    const raw = fs.readFileSync(LOCK_PATH, "utf8").trim();
    const existingPid = parseInt(raw, 10);
    if (!isNaN(existingPid) && existingPid !== process.pid && isProcessAlive(existingPid)) {
      pipelineLogger.error(
        `Another bot instance is already running (PID ${existingPid}). Refusing to start a second poller — ` +
          `this would cause duplicate Telegram message handling. Stop it first with: kill ${existingPid}`,
        undefined,
        "Bootstrap",
      );
      process.exit(1);
    }
    // Stale lock (process no longer alive) — safe to take over.
  }

  fs.writeFileSync(LOCK_PATH, String(process.pid));

  // Best-effort cleanup on every exit path so a clean shutdown never leaves
  // a stale lock behind.
  process.on("exit", releaseLock);
}
