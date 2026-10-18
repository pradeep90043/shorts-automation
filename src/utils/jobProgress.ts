import fs from "fs";
import path from "path";

/**
 * Where is a Short right now, how long has it taken, how long is left? The pipeline already logs every milestone; this watches those
 * lines (see logBroadcast.ts), follows each job through its stages with real timestamps, and learns how long each stage usually takes
 * from the jobs it has seen (median of the last few). The dashboard polls /api/pipeline/live instead of depending on a log stream, so it
 * works through any proxy or tunnel.
 */

export interface StageDef {
  id: string;
  label: string;
  /** what it is doing, in plain words (shown while the stage runs) */
  what: string;
  /** typical seconds when nothing has been learned yet (measured on the GitHub-hosted dev server) */
  typicalSec: number;
  /** a log line that means "this stage has begun" */
  start: RegExp;
}

export const STAGES: StageDef[] = [
  { id: "download", label: "Download the reel", what: "fetching the reel and its caption from Instagram", typicalSec: 45, start: /Interactive manual ingest triggered|Auto-publishing reel|Injected reel, downloading|Reel received, downloading/ },
  { id: "prepare", label: "Prepare the video", what: "trimming, transcribing the audio and reading the on-screen text", typicalSec: 100, start: /Instagram frame ready|Instagram frame extracted/ },
  { id: "vision", label: "AI: title, captions, branding", what: "the AI is reading the frames and writing the title and script", typicalSec: 60, start: /Running unified AI vision|Attempting metadata generation via/i },
  { id: "voice", label: "Voiceover (cloned voice)", what: "the cloned voice is being made on a GitHub runner (about 14 minutes)", typicalSec: 860, start: /Kicking off TTS generation/ },
  { id: "render", label: "Render the Short", what: "a GitHub runner is cropping, branding, captioning and mixing the audio", typicalSec: 150, start: /Dispatching short render|Cloud render was not completed|Executing FFmpeg video processing/ },
  { id: "v2", label: "V2 middle clip", what: "making the explainer clip that goes in the middle", typicalSec: 330, start: /Generating V2 transition clip/ },
  { id: "assemble", label: "Join the clips and finish", what: "joining the clips and the verdict, final checks", typicalSec: 90, start: /Transition clip generated successfully|Verdict sequence appended/ },
  { id: "review", label: "Ready for your review", what: "waiting for you to publish or discard it", typicalSec: 0, start: /Compilation complete|awaiting explicit user publish approval/ },
  { id: "publish", label: "Publish", what: "uploading to YouTube, Instagram and Facebook", typicalSec: 90, start: /Starting YouTube upload|Starting Instagram Reel upload|Review timeout .*auto-publishing|Automated headless pipeline .* auto-publishing/ },
];

export type StageState = "pending" | "running" | "done" | "skipped" | "failed";

export interface LiveStage {
  id: string;
  label: string;
  state: StageState;
  startedAt?: number;
  endedAt?: number;
  durSec?: number;
  typicalSec: number;
  overrunSec?: number;
}

export interface LiveJob {
  id: string;
  channel: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "review" | "done" | "failed";
  note?: string;
  elapsedSec: number;
  etaRemainingSec: number | null;
  etaTotalSec: number | null;
  current?: { id: string; label: string; what: string; sinceSec: number; typicalSec: number; detail: string; slow: boolean };
  stages: LiveStage[];
  lastError?: string;
}

interface JobRec {
  id: string;
  channel: string;
  startedAt: number;
  endedAt?: number;
  state: LiveJob["state"];
  note?: string;
  stages: Record<string, { startedAt?: number; endedAt?: number; skipped?: boolean; failed?: boolean; last?: string }>;
  manual: boolean; // injected from the dashboard: it is published by the owner, not by the pipeline
  currentIdx: number; // index into STAGES of the stage that began last, -1 before the first
  lastError?: string;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Typical stage durations learned from finished jobs, kept in a small JSON file so they survive restarts. */
export class StageStats {
  private data: Record<string, number[]> = {};
  constructor(private file?: string) {
    try {
      if (file && fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, "utf8")) || {};
    } catch {
      this.data = {};
    }
  }
  record(stageId: string, sec: number): void {
    if (!(sec > 0) || sec > 6 * 3600) return;
    const arr = (this.data[stageId] ||= []);
    arr.push(Math.round(sec));
    while (arr.length > 7) arr.shift();
    try {
      if (this.file) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data));
      }
    } catch {
      /* statistics are a nicety */
    }
  }
  typical(stageId: string, fallback: number): number {
    const arr = this.data[stageId];
    return arr && arr.length >= 2 ? Math.round(median(arr)) : fallback;
  }
}

const ID_RE = /\b(gen-\d+-\d+)\b/;
const START_RE = /Interactive manual ingest triggered .*?jobId: (gen-[\w-]+)|Auto-publishing reel .*?jobId: (gen-[\w-]+)|Injected reel, downloading\.\.\. \((gen-[\w-]+)\)/;
const CHANNEL_RE = /\[(PromptGag|CodeOrCap|Storiyum|InfoOnSpot)\]/i;
const DONE_RE = /Job (gen-[\w-]+) completed successfully|All uploads complete/;
const FAIL_RE = /DirectUploader failed for (gen-[\w-]+)|Cancelled old job (gen-[\w-]+) on startup|Job (gen-[\w-]+) failed|Pipeline failed for/;

const clip = (s: string, n = 140): string => s.replace(/\s+/g, " ").trim().slice(0, n);

export class ProgressTracker {
  private jobs = new Map<string, JobRec>();
  private order: string[] = [];
  private lastActive?: string;

  constructor(private stats: StageStats = new StageStats()) {}

  private begin(id: string, channel: string, now: number): JobRec {
    let r = this.jobs.get(id);
    if (!r) {
      r = { id, channel, startedAt: now, state: "running", stages: {}, manual: false, currentIdx: -1 };
      this.jobs.set(id, r);
      this.order.push(id);
      while (this.order.length > 12) this.jobs.delete(this.order.shift()!);
    }
    this.lastActive = id;
    return r;
  }

  private advance(r: JobRec, idx: number, now: number): void {
    // everything before the new stage is over: finished if it began, skipped if it never did
    for (let i = 0; i < idx; i++) {
      const st = (r.stages[STAGES[i].id] ||= {});
      if (st.startedAt && !st.endedAt) {
        st.endedAt = now;
        this.stats.record(STAGES[i].id, (now - st.startedAt) / 1000);
      } else if (!st.startedAt && !st.endedAt) {
        st.skipped = true;
      }
    }
    const cur = (r.stages[STAGES[idx].id] ||= {});
    if (!cur.startedAt) cur.startedAt = now;
    if (idx > r.currentIdx) r.currentIdx = idx;
  }

  /** Feed one log line. `now` is injectable for tests. */
  observe(message: string, label: string, level: string, now = Date.now()): void {
    const text = message || "";

    // a job begins
    const sm = START_RE.exec(text);
    if (sm) {
      const id = sm[1] || sm[2] || sm[3];
      const channel = (CHANNEL_RE.exec(text)?.[1] ?? "").replace(/^./, (c) => c.toUpperCase());
      const r = this.begin(id, channel, now);
      if (!r.channel && channel) r.channel = channel;
      if (/Interactive manual ingest|Injected reel/.test(text)) r.manual = true;
      this.advance(r, 0, now);
      r.stages.download.last = clip(text);
      return;
    }

    // which job does this line belong to: the one it names, else the one that started last and is still running
    const named = ID_RE.exec(text)?.[1];
    const target = (named && this.jobs.get(named)) || (this.lastActive ? this.jobs.get(this.lastActive) : undefined);
    if (!target || target.state === "done" || target.state === "failed") return;
    const r = target;

    // the end of a job
    const fm = FAIL_RE.exec(text);
    if (fm) {
      const id = fm[1] || fm[2] || fm[3];
      const failed = (id && this.jobs.get(id)) || r;
      if (failed.state === "running" || failed.state === "review") {
        failed.state = "failed";
        failed.endedAt = now;
        failed.note = /Cancelled old job/.test(text) ? "the app restarted while this was running" : clip(text);
        const cur = STAGES[Math.max(0, failed.currentIdx)];
        (failed.stages[cur.id] ||= {}).failed = true;
      }
      return;
    }

    if (level === "error" && r.state === "running") r.lastError = clip(text, 200);

    // stage transitions
    for (let i = STAGES.length - 1; i >= 0; i--) {
      if (STAGES[i].start.test(text)) {
        if (i >= r.currentIdx) this.advance(r, i, now);
        else if (STAGES[i].id === "voice" || STAGES[i].id === "render") (r.stages[STAGES[i].id] ||= {}).last = clip(text);
        break;
      }
    }

    // the stage that is running remembers the latest thing said about it
    if (r.currentIdx >= 0 && !/^(Host|Timing|JobDatabase|IGMedia|AutoLong|Supabase|DmKnowledgeBase|YouTubeService)$/.test(label || "") && !/\[AutoLong\]/.test(text)) {
      (r.stages[STAGES[r.currentIdx].id] ||= {}).last = clip(text);
    }

    // parallel work that ends a stage earlier than the next begins
    if (/Cloned voice ready|Cloned voice unavailable|Cloned-voice voiceover \(|All TTS providers failed/.test(text)) {
      const v = (r.stages.voice ||= {});
      if (v.startedAt && !v.endedAt) {
        v.endedAt = now;
        this.stats.record("voice", (now - v.startedAt) / 1000);
      }
    }

    // review / done
    if (/Compilation complete|awaiting explicit user publish approval/.test(text)) {
      this.finishWork(r, now);
      if (/awaiting explicit/.test(text)) r.state = "review";
    }
    if (DONE_RE.test(text)) {
      this.finishWork(r, now);
      r.state = r.state === "review" ? "review" : "done";
      r.endedAt = r.endedAt ?? now;
    }
  }

  private finishWork(r: JobRec, now: number): void {
    const reviewIdx = STAGES.findIndex((s) => s.id === "review");
    this.advance(r, reviewIdx, now);
    const rv = r.stages.review;
    if (rv && !rv.endedAt) rv.endedAt = rv.startedAt; // waiting for the owner is not work time
  }

  snapshot(now = Date.now()): LiveJob[] {
    const out: LiveJob[] = [];
    for (const id of [...this.order].reverse()) {
      const r = this.jobs.get(id)!;
      const typical = (sid: string, fb: number) => this.stats.typical(sid, fb);
      const stages: LiveStage[] = STAGES.map((def, i) => {
        const st = r.stages[def.id] || {};
        const ownerPublishes = def.id === "publish" && r.manual;
        const typ = ownerPublishes ? 0 : typical(def.id, def.typicalSec);
        let state: StageState = "pending";
        if (st.failed) state = "failed";
        else if (st.skipped) state = "skipped";
        else if (st.endedAt) state = "done";
        else if (st.startedAt) state = r.state === "failed" ? "failed" : "running";
        else if (i < r.currentIdx) state = "skipped";
        const live: LiveStage = { id: def.id, label: ownerPublishes ? "Publish (when you approve it)" : def.label, state, typicalSec: typ };
        if (st.startedAt) live.startedAt = st.startedAt;
        if (st.endedAt) live.endedAt = st.endedAt;
        if (st.startedAt && st.endedAt) live.durSec = Math.max(0, Math.round((st.endedAt - st.startedAt) / 1000));
        if (state === "running" && st.startedAt) {
          const since = (now - st.startedAt) / 1000;
          if (since > typ) live.overrunSec = Math.round(since - typ);
        }
        return live;
      });

      const elapsedSec = Math.round(((r.endedAt ?? now) - r.startedAt) / 1000);
      let etaRemainingSec: number | null = null;
      let current: LiveJob["current"];
      if (r.state === "running") {
        let remain = 0;
        for (const s of stages) {
          if (s.id === "review") continue;
          if (s.id === "publish") continue; // a manual inject is not published by the pipeline
          if (s.state === "pending") remain += s.typicalSec;
          if (s.state === "running" && s.startedAt) remain += Math.max(0, s.typicalSec - (now - s.startedAt) / 1000);
        }
        etaRemainingSec = Math.round(remain);
        const run = stages.find((s) => s.state === "running");
        if (run && run.startedAt) {
          const def = STAGES.find((d) => d.id === run.id)!;
          const sinceSec = Math.round((now - run.startedAt) / 1000);
          current = { id: run.id, label: run.label, what: def.what, sinceSec, typicalSec: run.typicalSec, detail: r.stages[run.id]?.last ?? "", slow: sinceSec > run.typicalSec * 1.5 };
        }
      } else if (r.state === "review") {
        etaRemainingSec = 0;
      }
      out.push({
        id: r.id,
        channel: r.channel,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        state: r.state,
        note: r.note,
        elapsedSec,
        etaRemainingSec,
        etaTotalSec: etaRemainingSec === null ? null : elapsedSec + etaRemainingSec,
        current,
        stages,
        lastError: r.lastError,
      });
    }
    return out;
  }
}

let singleton: ProgressTracker | undefined;
/** The app-wide tracker. Statistics live next to the logs. */
export function jobProgress(): ProgressTracker {
  if (!singleton) {
    let file: string | undefined;
    try {
      file = path.join(process.env.LOG_DIR || path.resolve(process.cwd(), "logs"), "stage_stats.json");
    } catch {
      file = undefined;
    }
    singleton = new ProgressTracker(new StageStats(file));
  }
  return singleton;
}
