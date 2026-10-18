/**
 * All channels share the same free AI keys, and a free tier answers a burst with 429. FreeLLMAPI then benches every key and
 * the next calls fail with "no candidate model has a usable provider key" (503) although nothing is wrong with the keys.
 * So AI requests go through a gate: vision requests (several images each, the heaviest) run ONE at a time with a gap between
 * starts; text requests run at most a few at a time. After a rate-limit answer the gate backs off before the next start.
 * The gate is process-wide: every FreeLlmApiClient, whoever created it, shares it.
 */
export class Gate {
  private running = 0;
  private lastStart = 0;
  private notBefore = 0;
  private waiting: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly minGapMs: number,
    private readonly name = "ai",
    private readonly onWait?: (name: string, ahead: number, waitedMs: number) => void,
  ) {}

  /** No new request starts for `ms` (after a rate-limit answer). */
  backOff(ms: number): void {
    this.notBefore = Math.max(this.notBefore, Date.now() + ms);
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const queuedAt = Date.now();
    const ahead = this.waiting.length + this.running;
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      this.pump();
    });
    const waited = Date.now() - queuedAt;
    if (this.onWait && waited >= 2000) this.onWait(this.name, ahead, waited);
    try {
      return await fn();
    } finally {
      this.running--;
      this.pump();
    }
  }

  private pump(): void {
    if (!this.waiting.length || this.running >= this.maxConcurrent) return;
    const wait = Math.max(this.lastStart + this.minGapMs - Date.now(), this.notBefore - Date.now(), 0);
    if (wait > 0) {
      // try again when the gap or the back-off is over (only one timer needed: pump is idempotent)
      setTimeout(() => this.pump(), wait + 5); // not unref'd: a request waiting for its turn must keep the process alive
      return;
    }
    const next = this.waiting.shift()!;
    this.running++;
    this.lastStart = Date.now();
    next();
    this.pump(); // another may fit (maxConcurrent > 1) once its own gap is over
  }
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && v !== undefined && v !== "" ? n : d;
};

let logger: ((m: string) => void) | undefined;
/** Wired by the app (the logger is not imported here, so the gate stays testable on its own). */
export function setAiGateLogger(fn: (m: string) => void): void {
  logger = fn;
}
const say = (name: string, ahead: number, waitedMs: number) =>
  logger?.(`AI request waited ${Math.round(waitedMs / 1000)}s for its turn (${name}: ${ahead} ahead): requests are spaced so the free keys are not rate-limited`);

/** Vision: one at a time, 3 s between starts. */
export const visionGate = new Gate(Math.max(1, num(process.env.AI_VISION_CONCURRENCY, 1)), num(process.env.AI_VISION_GAP_MS, 3000), "vision", say);
/** Text: two at a time, 0.5 s between starts. */
export const textGate = new Gate(Math.max(1, num(process.env.AI_TEXT_CONCURRENCY, 2)), num(process.env.AI_TEXT_GAP_MS, 500), "text", say);

/** How long every AI request waits after a rate-limit answer (429 / "no usable provider key"). */
export const RATE_LIMIT_BACKOFF_MS = num(process.env.AI_RATE_LIMIT_BACKOFF_MS, 20000);

/** True for an error that means "the free tier said slow down". */
export function isRateLimitError(message: string): boolean {
  return /status 429|rate.?limit|status 503.*(no candidate|usable provider key)|No candidate model has a configured/i.test(message);
}
