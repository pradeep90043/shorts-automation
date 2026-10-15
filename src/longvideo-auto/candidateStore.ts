import fs from "fs";
import path from "path";
import { config } from "../config";
import { autoLongStatus } from "./status";
import type { LongCandidate } from "./types";

/** IST calendar date (YYYY-MM-DD) of an instant: the day a Short counts for, midnight to midnight India time. */
export function istDateOf(ms: number = Date.now()): string {
  return new Date(ms + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The day's published Shorts, kept in one JSON file (small: 20 rows a day) so the midnight ranking does not depend on
 * the database being reachable. Writes are atomic (temp file + rename) and rows older than `keepDays` are dropped.
 */
export class CandidateStore {
  private file: string;
  private rows: LongCandidate[] = [];

  constructor(file?: string, private keepDays = 14) {
    const dir = config.paths.logDir || path.resolve(__dirname, "../../logs");
    this.file = file ?? path.join(dir, "autolong_candidates.json");
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      this.rows = []; // first run: no file yet
      return;
    }
    try {
      const j = JSON.parse(raw);
      this.rows = Array.isArray(j) ? j : [];
    } catch (err) {
      // never overwrite what we cannot read: keep it for inspection and start empty
      const bad = `${this.file}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.file, bad); } catch { /* best effort */ }
      autoLongStatus.error("store", `candidate file was not valid JSON; moved to ${bad} and started empty`, err);
      this.rows = [];
    }
  }

  private save(): void {
    try {
      const cutoff = istDateOf(Date.now() - this.keepDays * 24 * 60 * 60 * 1000);
      this.rows = this.rows.filter((r) => r.istDate >= cutoff);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.rows, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // memory stays correct for this run; the failure is loud in the log
      autoLongStatus.error("store", `could not write ${this.file}`, err);
    }
  }

  /** Idempotent: the same channel+shortcode is recorded once (a re-poll of a finished job must not duplicate it). */
  public record(c: LongCandidate): boolean {
    if (this.rows.some((r) => r.channelKey === c.channelKey && r.shortcode === c.shortcode)) return false;
    this.rows.push(c);
    this.save();
    return true;
  }

  public forDay(channelKey: string, istDate: string): LongCandidate[] {
    return this.rows.filter((r) => r.channelKey === channelKey && r.istDate === istDate).map((r) => ({ ...r }));
  }

  /** Most recent unused candidates before `istDate`, for a day on which the channel published nothing. */
  public latestUnused(channelKey: string, beforeIstDate: string, days = 3): LongCandidate[] {
    const from = istDateOf(Date.parse(beforeIstDate + "T00:00:00Z") - days * 24 * 60 * 60 * 1000 + 5.5 * 60 * 60 * 1000);
    return this.rows
      .filter((r) => r.channelKey === channelKey && r.istDate < beforeIstDate && r.istDate >= from && !r.usedForLongAt)
      .map((r) => ({ ...r }));
  }

  public markUsed(channelKey: string, shortcode: string, atIso = new Date().toISOString()): void {
    const r = this.rows.find((x) => x.channelKey === channelKey && x.shortcode === shortcode);
    if (r) {
      r.usedForLongAt = atIso;
      this.save();
    }
  }
}
