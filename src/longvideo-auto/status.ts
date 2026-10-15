import { pipelineLogger } from "../utils/logger";

export type Level = "info" | "warn" | "error";

export interface AutoLongEvent {
  at: string;
  level: Level;
  stage: string;
  message: string;
  requestId?: string;
}

/**
 * Everything the nightly system does, in one place: each event goes to the normal log (tag "AutoLong", one greppable
 * prefix `[AutoLong][stage][request]`) and to a small in-memory ring so the dashboard can show the last events and the
 * last failure without reading log files. Logging never throws.
 */
class AutoLongStatus {
  private ring: AutoLongEvent[] = [];
  private readonly max = 200;
  readonly startedAt = new Date().toISOString();
  lastTickAt?: string;
  lastPlanAt?: string;
  lastFailure?: AutoLongEvent;
  runningRequest?: string;
  readonly counters = { planned: 0, skipped: 0, started: 0, done: 0, retried: 0, failed: 0, blocked: 0, tickErrors: 0 };

  log(level: Level, stage: string, message: string, requestId?: string): void {
    const ev: AutoLongEvent = { at: new Date().toISOString(), level, stage, message, requestId };
    this.ring.push(ev);
    if (this.ring.length > this.max) this.ring.shift();
    if (level === "error") this.lastFailure = ev;
    try {
      const line = `[AutoLong][${stage}]${requestId ? `[${requestId}]` : ""} ${message}`;
      if (level === "error") pipelineLogger.error(line, undefined, "AutoLong");
      else if (level === "warn") pipelineLogger.warn(line, "AutoLong");
      else pipelineLogger.info(line, "AutoLong");
    } catch {
      /* a broken logger must never break the pipeline */
    }
  }

  /**
   * An error with its stack in the log. `message` says what failed WITHOUT the error text: the logger appends the error's
   * message itself, and the ring (for the dashboard) gets "message: error text" once.
   */
  error(stage: string, message: string, err?: unknown, requestId?: string): void {
    const detail = err instanceof Error ? err.message : err !== undefined ? String(err) : "";
    const ev: AutoLongEvent = { at: new Date().toISOString(), level: "error", stage, message: detail ? `${message}: ${detail}` : message, requestId };
    this.ring.push(ev);
    if (this.ring.length > this.max) this.ring.shift();
    this.lastFailure = ev;
    try {
      pipelineLogger.error(`[AutoLong][${stage}]${requestId ? `[${requestId}]` : ""} ${message}`, err, "AutoLong");
    } catch {
      /* ignore */
    }
  }

  events(limit = 50): AutoLongEvent[] {
    return this.ring.slice(-limit);
  }
}

export const autoLongStatus = new AutoLongStatus();

/** An error that remembers which stage failed, so the queue row says "[script] ..." and not just "timeout". */
export class StageError extends Error {
  constructor(public readonly stage: string, cause: unknown) {
    super(`[${stage}] ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StageError";
  }
}

/** Runs one stage with start/ok/failed logs and timing; a failure becomes a StageError (and is logged with its stack). */
export async function runStage<T>(requestId: string, stage: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  autoLongStatus.log("info", stage, "start", requestId);
  try {
    const out = await fn();
    autoLongStatus.log("info", stage, `ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`, requestId);
    return out;
  } catch (err) {
    autoLongStatus.error(stage, `FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s`, err, requestId);
    throw err instanceof StageError ? err : new StageError(stage, err);
  }
}
