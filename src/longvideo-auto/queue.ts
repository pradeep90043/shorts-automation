import fs from "fs";
import path from "path";
import { config } from "../config";
import { AUTO_LONG_DEFAULT_CHANNELS } from "./config";
import { CandidateStore } from "./candidateStore";
import { pickSeed, rankCandidates } from "./rank";
import { autoLongStatus } from "./status";
import type { LongRequest } from "./types";

/**
 * The overnight queue of 10-minute videos: persisted, one per channel per IST day (the id is the dedupe key), processed
 * strictly one at a time and only while no Short is being processed on the box.
 */
export class LongQueue {
  private file: string;
  private rows: LongRequest[] = [];

  constructor(file?: string, private keepDays = 14) {
    const dir = config.paths.logDir || path.resolve(__dirname, "../../logs");
    this.file = file ?? path.join(dir, "autolong_requests.json");
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      try {
        const j = JSON.parse(raw);
        this.rows = Array.isArray(j) ? j : [];
      } catch (err) {
        const bad = `${this.file}.corrupt-${Date.now()}`;
        try { fs.renameSync(this.file, bad); } catch { /* best effort */ }
        autoLongStatus.error("store", `request queue file was not valid JSON; moved to ${bad} and started empty`, err);
        this.rows = [];
      }
    } catch {
      this.rows = []; // first run
    }
    // a restart while a request was "running" means the work was lost: put it back (counts as an attempt)
    for (const r of this.rows) {
      if (r.status === "running") {
        r.status = "queued";
        autoLongStatus.log("warn", "queue", `request was running when the app stopped; queued again`, r.id);
      }
    }
  }

  private save(): void {
    try {
      const cutoff = new Date(Date.now() - this.keepDays * 86400e3).toISOString().slice(0, 10);
      this.rows = this.rows.filter((r) => r.istDate >= cutoff);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.rows, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      autoLongStatus.error("store", `could not write ${this.file}`, err);
    }
  }

  public all(): LongRequest[] { return this.rows.map((r) => ({ ...r })); }
  public get(id: string): LongRequest | undefined { const r = this.rows.find((x) => x.id === id); return r ? { ...r } : undefined; }

  /** Adds a request unless that channel already has one for the day. Returns false for a duplicate. */
  public enqueue(r: Omit<LongRequest, "status" | "attempts" | "createdAt"> & Partial<Pick<LongRequest, "status">>): boolean {
    if (this.rows.some((x) => x.id === r.id)) return false;
    this.rows.push({ status: "queued", ...r, attempts: 0, createdAt: new Date().toISOString() });
    this.save();
    return true;
  }

  public update(id: string, patch: Partial<LongRequest>): void {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, patch);
    this.save();
  }

  /** Oldest day first, then the channel order, among requests that are queued and not waiting out a backoff. */
  public next(nowMs: number, channelOrder: string[] = AUTO_LONG_DEFAULT_CHANNELS): LongRequest | undefined {
    const rank = (k: string) => { const i = channelOrder.indexOf(k); return i < 0 ? 99 : i; };
    return this.rows
      .filter((r) => r.status === "queued" && (r.notBeforeMs ?? 0) <= nowMs)
      .sort((a, b) => a.istDate.localeCompare(b.istDate) || rank(a.channelKey) - rank(b.channelKey))
      .map((r) => ({ ...r }))[0];
  }
}

export interface PlanDeps {
  store: CandidateStore;
  channels: string[];
  /** optional 0-100 "can this carry 10 minutes" judgement by shortcode; failures must be swallowed by the caller */
  potential?: (channelKey: string, candidates: { shortcode: string; title: string; text: string }[]) => Promise<Record<string, number>>;
}

/**
 * At midnight IST: one request per channel for the day that just ended. Idempotent (a second call adds nothing).
 * A channel that published nothing falls back to its latest unused candidate of the last 3 days, else the day is skipped.
 */
export async function planDay(queue: LongQueue, istDate: string, deps: PlanDeps): Promise<{ queued: string[]; skipped: string[] }> {
  const queued: string[] = [];
  const skipped: string[] = [];
  for (const channelKey of deps.channels) {
    const id = `${istDate}:${channelKey}`;
    if (queue.get(id)) continue;
    let pool = deps.store.forDay(channelKey, istDate);
    let usedHistory = false;
    if (!pool.length) {
      pool = deps.store.latestUnused(channelKey, istDate, 3);
      usedHistory = pool.length > 0;
    }
    let potential: Record<string, number> = {};
    if (deps.potential && pool.length > 1) {
      try { potential = await deps.potential(channelKey, pool); } catch { potential = {}; }
    }
    const picked = pickSeed(rankCandidates(pool, potential));
    if (!picked) {
      const why = pool.length
        ? `${pool.length} candidate(s) but none with enough text to carry 10 minutes`
        : "no Short was published today and there is no unused candidate from the last 3 days";
      queue.enqueue({ id, channelKey, istDate, seed: undefined as any, status: "skipped", error: why });
      autoLongStatus.counters.skipped++;
      autoLongStatus.log("warn", "plan", `${channelKey}: SKIPPED for ${istDate}: ${why}`, id);
      skipped.push(channelKey);
      continue;
    }
    queue.enqueue({ id, channelKey, istDate, seed: picked.seed, fallback: picked.fallback });
    autoLongStatus.counters.planned++;
    autoLongStatus.log(
      "info", "plan",
      `${channelKey}: seed ${picked.seed.shortcode} "${picked.seed.title.slice(0, 60)}" score ${picked.seed.score} ` +
        `(viral ${picked.seed.parts.viral}, substance ${picked.seed.parts.substance}) of ${pool.length} candidate(s)` +
        `${usedHistory ? " [from earlier days: nothing published today]" : ""}` +
        `${picked.fallback ? `; fallback ${picked.fallback.shortcode}` : "; no fallback"}`,
      id,
    );
    queued.push(channelKey);
  }
  autoLongStatus.lastPlanAt = new Date().toISOString();
  if (queued.length || skipped.length) {
    autoLongStatus.log("info", "plan", `day ${istDate}: queued [${queued.join(", ") || "-"}] skipped [${skipped.join(", ") || "-"}]`);
  }
  return { queued, skipped };
}

export interface WorkerDeps {
  now(): number;
  /** a Short is being processed on the box (JobQueue.isIdle() is false) */
  isShortActive(): boolean;
  /** the stickman engine is already making a video (isStickmanBusy()) */
  isLongBusy(): boolean;
  /** research -> script -> render -> private upload with a release time. Throws on failure. */
  produce(req: LongRequest, useFallbackSeed: boolean): Promise<{ videoUrl?: string; jobId?: string; releaseAt?: string }>;
  maxAttempts?: number;
  backoffMs?: number;
  /** told about every result that is not "idle"/"blocked", with the request and the error when there is one (alerts hook here) */
  onResult?: (result: RunResult, req: LongRequest, error?: string) => void | Promise<void>;
}

export type RunResult = "idle" | "blocked" | "done" | "retry" | "failed";

/** Runs at most one request. Shorts always win: with a Short active (or a video already rendering) nothing starts. */
export async function runNext(queue: LongQueue, deps: WorkerDeps, channelOrder?: string[]): Promise<RunResult> {
  if (deps.isShortActive() || deps.isLongBusy()) {
    autoLongStatus.counters.blocked++;
    return "blocked";
  }
  const req = queue.next(deps.now(), channelOrder);
  if (!req) return "idle";
  const maxAttempts = deps.maxAttempts ?? 2;
  const attempt = req.attempts + 1;
  queue.update(req.id, { status: "running", attempts: attempt, startedAt: new Date(deps.now()).toISOString() });
  autoLongStatus.runningRequest = req.id;
  autoLongStatus.counters.started++;
  const useFallback = attempt > 1 && !!req.fallback;
  autoLongStatus.log("info", "run", `attempt ${attempt}/${maxAttempts}${useFallback ? " with the runner-up reel" : ""}`, req.id);
  const emit = async (r: RunResult, error?: string) => {
    try { await deps.onResult?.(r, req, error); } catch (e) {
      autoLongStatus.log("warn", "alert", `result hook failed: ${e instanceof Error ? e.message : e}`, req.id);
    }
  };
  try {
    // the second attempt uses the runner-up reel when there is one: a seed that cannot be scripted will not work twice
    const out = await deps.produce(req, useFallback);
    queue.update(req.id, { status: "done", finishedAt: new Date(deps.now()).toISOString(), error: undefined, ...out });
    autoLongStatus.counters.done++;
    autoLongStatus.log("info", "run", `DONE ${out.videoUrl ?? ""}${out.releaseAt ? ` public at ${out.releaseAt}` : ""}`, req.id);
    await emit("done");
    return "done";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (attempt >= maxAttempts) {
      queue.update(req.id, { status: "failed", finishedAt: new Date(deps.now()).toISOString(), error: msg });
      autoLongStatus.counters.failed++;
      autoLongStatus.error("run", `GAVE UP after ${attempt} attempt(s)`, err, req.id);
      await emit("failed", msg);
      return "failed";
    }
    const retryAt = deps.now() + (deps.backoffMs ?? 10 * 60 * 1000);
    queue.update(req.id, { status: "queued", error: msg, notBeforeMs: retryAt });
    autoLongStatus.counters.retried++;
    autoLongStatus.log("warn", "run", `attempt ${attempt} failed (${msg}); retry after ${new Date(retryAt).toISOString()}`, req.id);
    await emit("retry", msg);
    return "retry";
  } finally {
    autoLongStatus.runningRequest = undefined;
  }
}
