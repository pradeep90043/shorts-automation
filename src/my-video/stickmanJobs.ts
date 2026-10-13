import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { cancelCloudRun, renderStickmanVideo, resumeCloudRender, type CloudRunRef, type RenderProgress } from "./myVideoService";
import {
  estimateStickman, recordTimings, STAGE_LABELS, STAGE_ORDER,
  type StageKey, type StickmanEstimate,
} from "./stickmanEstimate";
import {
  assertImportablePlan, assertPlanOnly, cleanScript, fitScriptToDuration, importStickmanPlan, planFromPlanOnly, planStickmanVideo,
  sceneNotesForBeats, splitScriptIntoBeats,
} from "./stickmanPlanner";
import { lessonQualityReport, type QualityWarning } from "./lessonQuality";

export interface StickmanJobInput {
  /** narration; with `planOnly` it is derived from the plan's scenes and may be empty */
  script: string;
  /** `plan` is the whole video (each scene carries its own narration "text"): no script, no AI */
  planOnly?: boolean;
  /** a ready-made plan (JSON object or pasted text) from an external model: skips the AI planning */
  plan?: unknown;
  /** with `plan`: let the AI direct the beats the plan left out (otherwise they are rejected) */
  repairMissing?: boolean;
  title?: string;
  /** requested video length in seconds */
  targetSec?: number;
  orientation?: "horizontal" | "vertical";
  /** edge-tts voice for the narration, e.g. "en-IN-PrabhatNeural"; omit for my-video's default Hindi voice */
  voice?: string;
  resolution?: 720 | 1080;
  channelKey?: string;
}

type StageStatus = "pending" | "running" | "done" | "failed";

interface StageState {
  key: StageKey;
  label: string;
  status: StageStatus;
  fraction: number;
  detail?: string;
  estSec: number;
  startedAt?: number;
  actualSec?: number;
}

export interface StickmanJob {
  id: string;
  status: "running" | "done" | "failed" | "cancelled";
  createdAt: number;
  finishedAt?: number;
  input: StickmanJobInput;
  estimate: StickmanEstimate;
  stages: StageState[];
  title?: string;
  description?: string;
  tags?: string[];
  scenes?: number;
  aiVisuals?: boolean;
  /** lesson-quality findings for the planned video (code shown? quiz answers leaking? ...) */
  warnings?: QualityWarning[];
  /** the narration actually used (after cleanup and, if a target length was set, rewriting) */
  finalScript?: string;
  /** how the script was adjusted to the target length */
  adjustNote?: string;
  error?: string;
  videoPath?: string;
  /** GitHub run being watched; lets a restarted app re-attach instead of losing the render */
  cloudRun?: CloudRunRef;
  /** how many times this job was (re)started after an app restart */
  restarts?: number;
  publish?: PublishState;
}

export interface PublishState {
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  channelKey?: string;
  url?: string;
  urls?: { channelName: string; url: string }[];
  error?: string;
  /** 0..100 upload progress */
  pct?: number;
}

const jobs = new Map<string, StickmanJob>();
const jobsFile = () => path.join(config.paths.dataDir, "stickman-jobs.json");
const KEEP = 20;

function persist(): void {
  try {
    // running jobs are saved too, so a restart can resume them
    const all = [...jobs.values()].sort((x, y) => x.createdAt - y.createdAt).slice(-KEEP);
    const data = JSON.stringify(all);
    // async + serialized: never block the event loop on disk
    writeChain = writeChain.then(async () => {
      try {
        await fs.promises.mkdir(config.paths.dataDir, { recursive: true });
        const tmp = `${jobsFile()}.tmp`;
        await fs.promises.writeFile(tmp, data);
        await fs.promises.rename(tmp, jobsFile());
      } catch {
        /* history is best-effort */
      }
    });
  } catch {
    /* history is best-effort */
  }
}
let writeChain: Promise<void> = Promise.resolve();

let persistTimer: NodeJS.Timeout | null = null;
function persistSoon(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, 10000);
}

(function loadJobs() {
  try {
    for (const j of JSON.parse(fs.readFileSync(jobsFile(), "utf8")) as StickmanJob[]) jobs.set(j.id, j);
  } catch {
    /* none yet */
  }
})();

/** Function (not an inline compare) so TypeScript does not narrow away a cancel that happened during an await. */
const isCancelled = (job: StickmanJob): boolean => job.status === "cancelled";

export const isStickmanBusy = (): boolean => [...jobs.values()].some((j) => j.status === "running");

function setStage(job: StickmanJob, key: StageKey, patch: Partial<StageState>): void {
  const st = job.stages.find((s) => s.key === key)!;
  const now = Date.now();
  if (patch.status === "running" && !st.startedAt) st.startedAt = now;
  if (patch.status === "done" && st.startedAt && st.actualSec === undefined) st.actualSec = (now - st.startedAt) / 1000;
  Object.assign(st, patch);
}

function applyProgress(job: StickmanJob, p: RenderProgress): void {
  if (job.status === "cancelled") {
    // a run that was dispatched just before the cancel: stop it as soon as we learn its id
    if (p.cloudRun) void cancelCloudRun(p.cloudRun);
    return;
  }
  const idx = STAGE_ORDER.indexOf(p.stage);
  // entering a stage completes every earlier one
  for (const s of job.stages) {
    if (STAGE_ORDER.indexOf(s.key) < idx && s.status !== "done") setStage(job, s.key, { status: "done", fraction: 1 });
  }
  if (p.cloudRun) {
    job.cloudRun = p.cloudRun;
    persist();
  }
  const done = p.fraction >= 1;
  setStage(job, p.stage, { status: done ? "done" : "running", fraction: Math.min(1, p.fraction), detail: p.detail });
  persistSoon();
}

export function startStickmanJob(input: StickmanJobInput): StickmanJob {
  if (isStickmanBusy()) throw new Error("A video is already being created - wait for it to finish.");
  let script = (input.script ?? "").trim();
  if (input.planOnly) {
    // plan-only: the pasted JSON is the whole video, its scenes' text is the narration (no script, no AI)
    if (input.plan == null || input.plan === "") throw new Error("Paste the plan JSON first");
    script = assertPlanOnly(input.plan).script;
    input = { ...input, repairMissing: undefined };
  } else {
    if (!script) throw new Error("Script is empty");
    // an imported plan is checked against the script up front, so a mismatch is rejected before a job exists
    if (input.plan != null && input.plan !== "") assertImportablePlan(script, input.plan, !!input.repairMissing);
    else input = { ...input, plan: undefined, repairMissing: undefined };
  }

  const estimate = estimateStickman(script, input.targetSec, input.resolution ?? 720);
  const job: StickmanJob = {
    id: randomUUID().slice(0, 8),
    status: "running",
    createdAt: Date.now(),
    input: { ...input, script },
    estimate,
    stages: STAGE_ORDER.map((key) => ({
      key, label: STAGE_LABELS[key], status: "pending", fraction: 0, estSec: estimate.stageSec[key],
    })),
  };
  jobs.set(job.id, job);
  persist();
  void run(job);
  return job;
}

async function run(job: StickmanJob, resume = false): Promise<void> {
  const { script, title, orientation, resolution } = job.input;
  const log = (msg: string) => pipelineLogger.info(`[${job.id}] ${msg}`, "StickmanJob");
  try {
    if (resume && job.cloudRun) {
      log(`Resuming GitHub run #${job.cloudRun.runId} after restart`);
      const result = await resumeCloudRender(`lv-${job.id}`, job.cloudRun, (p) => applyProgress(job, p));
      finishJob(job, result.videoPath, log);
      return;
    }
    const planOnly = !!job.input.planOnly;
    const imported = job.input.plan != null;
    setStage(job, "plan", { status: "running", fraction: 0.1, detail: imported ? "Checking imported plan" : "Fitting script to length" });
    // an imported plan lines up with the script's own beats, so the script is never rewritten to fit a length
    const fit = planOnly
      ? { script, note: "Plan-only import: narration taken from the pasted plan, no AI used" }
      : imported
        ? { script: cleanScript(script), note: "Imported plan: script kept exactly as written (no length rewrite)" }
        : await fitScriptToDuration(cleanScript(script), job.input.targetSec);
    if (isCancelled(job)) return;
    job.finalScript = fit.script;
    job.adjustNote = fit.note;
    log(fit.note);
    // re-estimate for the final script: voice rate and stage times follow its real length
    const fitted = estimateStickman(fit.script, job.input.targetSec, job.input.resolution ?? 720, true);
    job.estimate = fitted;
    for (const s of job.stages) s.estSec = fitted.stageSec[s.key];
    setStage(job, "plan", { fraction: 0.5, detail: imported ? "Applying imported visuals" : "Choosing visuals" });
    // the author's Stickman/Remotion-visual sections steer the director, but only while the narration is still their script
    const notes = !planOnly && fit.script === cleanScript(script) ? sceneNotesForBeats(script, splitScriptIntoBeats(fit.script)) : null;
    if (notes) log(`Structured script: narrating only the Voiceover sections; ${notes.notes.filter(Boolean).length} section(s) of visual directions passed to the director`);
    const plan = planOnly
      ? planFromPlanOnly(job.input.plan, title)
      : imported
        ? await importStickmanPlan(fit.script, job.input.plan, { repair: job.input.repairMissing, titleHint: title, notes })
        : await planStickmanVideo(fit.script, title, notes);
    if (isCancelled(job)) return;
    Object.assign(job, { title: plan.title, description: plan.description, tags: plan.tags, scenes: plan.scenes.length, aiVisuals: plan.aiVisuals });
    setStage(job, "plan", { status: "done", fraction: 1 });
    log(`Planned ${plan.scenes.length} scenes (${planOnly ? "imported plan, no AI" : plan.aiVisuals ? "AI" : "rule-based"} visuals)`);
    // lesson-quality gate: warnings only, shown in the dashboard and kept on the job
    const warnings = lessonQualityReport(plan.scenes.map((s) => ({ text: s.text, visual: s.visual }))).slice(0, 15);
    job.warnings = warnings;
    for (const w of warnings.filter((x) => x.level === "warn")) log(`quality: ${w.scene ? `scene ${w.scene}: ` : ""}${w.message}`);

    const result = await renderStickmanVideo(
      {
        slug: `lv-${job.id}`,
        title: plan.title,
        description: plan.description,
        tags: plan.tags,
        scenes: plan.scenes,
        orientation: orientation ?? "horizontal",
        resolution: resolution ?? (orientation === "vertical" ? 1080 : 720),
        rate: job.estimate.rate,
        ...(job.input.voice ? { voice: job.input.voice, language: job.input.voice.slice(0, 2) } : {}),
      },
      (p) => applyProgress(job, p),
    );

    finishJob(job, result.videoPath, log);
  } catch (err: any) {
    if (isCancelled(job)) return; // the render was stopped on purpose; keep the cancelled state
    const running = job.stages.find((s) => s.status === "running");
    if (running) running.status = "failed";
    job.status = "failed";
    job.error = err?.message || String(err);
    job.finishedAt = Date.now();
    pipelineLogger.error(`[${job.id}] Stickman video failed`, err, "StickmanJob");
  } finally {
    persist();
  }
}

function finishJob(job: StickmanJob, videoPath: string, log: (m: string) => void): void {
  if (isCancelled(job)) return;
  for (const s of job.stages) if (s.status !== "done") setStage(job, s.key, { status: "done", fraction: 1 });
  job.videoPath = videoPath;
  job.status = "done";
  job.finishedAt = Date.now();
  job.cloudRun = undefined;
  if (job.input.plan != null) job.input.plan = "imported"; // keep the marker, free the data
  learn(job);
  log(`Done in ${Math.round((job.finishedAt - job.createdAt) / 1000)}s -> ${videoPath}`);
}

/** Forcefully stops a running job: marks it cancelled and cancels its GitHub run so no more minutes are spent. */
export async function cancelStickmanJob(id: string): Promise<StickmanJob | undefined> {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.status !== "running") return job;
  job.status = "cancelled";
  job.error = "Cancelled by you";
  job.finishedAt = Date.now();
  for (const s of job.stages) if (s.status === "running") s.status = "failed";
  const ref = job.cloudRun;
  job.cloudRun = undefined;
  persist();
  pipelineLogger.info(`[${job.id}] Cancelled by user${ref ? ` (stopping GitHub run #${ref.runId})` : ""}`, "StickmanJob");
  if (ref) await cancelCloudRun(ref);
  return job;
}

/** Restarts a cancelled (or failed) job from scratch with its original inputs. */
export function restartStickmanJob(id: string): StickmanJob {
  const job = jobs.get(id);
  if (!job) throw new Error("Job not found");
  if (isStickmanBusy()) throw new Error("A video is already being created - wait for it to finish.");
  if (job.status !== "cancelled" && job.status !== "failed") {
    throw new Error(`Cannot restart job in '${job.status}' state`);
  }
  job.createdAt = Date.now();
  job.finishedAt = undefined;
  job.error = undefined;
  job.videoPath = undefined;
  job.publish = undefined;
  job.warnings = undefined;
  job.restarts = 0;
  restartFromScratch(job);
  pipelineLogger.info(`[${job.id}] Restarted by user from scratch`, "StickmanJob");
  return job;
}

/** Feed measured stage timings back so the next estimate is closer. */
function learn(job: StickmanJob): void {
  const sec = (k: StageKey) => job.stages.find((s) => s.key === k)?.actualSec;
  const frames = Math.round(job.estimate.videoSec * 30);
  const render = sec("render");
  const audio = sec("audio");
  const bundle = sec("bundle");
  if (!render || !audio || !bundle || !job.scenes || frames < 30) return;
  const resFactor = (job.input.resolution ?? 720) === 1080 ? 2.2 : 1;
  recordTimings({ secPerFrame: render / frames / resFactor, secPerScene: audio / job.scenes, bundleSec: bundle });
}

export interface JobSnapshot extends StickmanJob {
  progress: number;
  elapsedSec: number;
  etaSec: number | null;
}

export function snapshot(job: StickmanJob): JobSnapshot {
  const now = job.finishedAt ?? Date.now();
  const elapsedSec = (now - job.createdAt) / 1000;
  const totalEst = job.stages.reduce((a, s) => a + s.estSec, 0) || 1;
  const doneEst = job.stages.reduce((a, s) => a + s.estSec * (s.status === "done" ? 1 : s.fraction), 0);
  const progress = job.status === "done" ? 1 : Math.min(0.99, doneEst / totalEst);

  let etaSec: number | null = null;
  if (job.status === "running") {
    // how much slower/faster than estimated this job is running so far
    const est = job.stages.filter((s) => s.status === "done" || s.status === "running")
      .reduce((a, s) => a + s.estSec * (s.status === "done" ? 1 : s.fraction), 0);
    const ratio = est > 5 ? Math.min(4, Math.max(0.4, elapsedSec / est)) : 1;
    etaSec = Math.max(1, (totalEst - doneEst) * ratio);
  } else if (job.status === "done") {
    etaSec = 0;
  }
  // the imported plan can be hundreds of KB: the dashboard only needs to know there was one
  const input = job.input.plan != null ? { ...job.input, plan: "imported" } : job.input;
  return { ...job, input, progress, elapsedSec, etaSec };
}

export const getStickmanJob = (id: string): JobSnapshot | undefined => {
  const j = jobs.get(id);
  return j ? snapshot(j) : undefined;
};

/** Poll payload: the narration is only shown once finished, so skip it while running. */
export const getStickmanJobForPoll = (id: string): JobSnapshot | undefined => {
  const s = getStickmanJob(id);
  return s && s.status === "running" ? { ...s, finalScript: undefined } : s;
};

/** History rows: drop the big text fields (script, final narration); the full job is fetched on open. */
export const listStickmanJobs = (): JobSnapshot[] =>
  [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, KEEP).map((j) => {
    const s = snapshot(j);
    return { ...s, finalScript: undefined, input: { ...s.input, script: s.input.script.slice(0, 120) } };
  });

// ── Durable publishing ──────────────────────────────────────────────────────
// Upload runs in the background and its state lives on the job, so closing the
// tab, a proxy timeout or a refresh can never leave the UI stuck on "Publishing…".

const PUBLISH_MAX_MS = 90 * 60 * 1000;

export type UploadFn = (
  job: StickmanJob,
  onProgress: (pct: number) => void,
) => Promise<{ channelName: string; url: string }[]>;

export function startPublish(jobId: string, channelKey: string, upload: UploadFn): PublishState {
  const job = jobs.get(jobId);
  if (!job) throw new Error("Job not found");
  if (job.status !== "done" || !job.videoPath || !fs.existsSync(job.videoPath)) {
    throw new Error("The video file is no longer on the server (files are cleaned after 24h) - create it again.");
  }
  // idempotent: never upload the same video twice by accident
  if (job.publish && (job.publish.status === "running" || job.publish.status === "done")) return job.publish;

  const state: PublishState = { status: "running", startedAt: Date.now(), channelKey, pct: 0 };
  job.publish = state;
  persist();

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Upload took longer than 90 minutes and was stopped")), PUBLISH_MAX_MS).unref(),
  );
  void Promise.race([upload(job, (pct) => { state.pct = pct; }), timeout])
    .then((results) => {
      if (!results.length) throw new Error("YouTube upload failed on every channel");
      state.status = "done";
      state.pct = 100;
      state.urls = results;
      state.url = results[0].url;
    })
    .catch((err: any) => {
      state.status = "failed";
      state.error = err?.message || String(err);
      pipelineLogger.error(`[${job.id}] Publish failed`, err, "StickmanJob");
    })
    .finally(() => {
      state.finishedAt = Date.now();
      persist();
    });
  return state;
}

/** Let the user retry after a failed publish. */
export function resetPublish(jobId: string): void {
  const job = jobs.get(jobId);
  if (job?.publish?.status === "failed") {
    job.publish = undefined;
    persist();
  }
}

// ── Restart recovery ────────────────────────────────────────────────────────
// A deploy or crash must not lose a video being created.

const MAX_RESTARTS = 2;

function restartFromScratch(job: StickmanJob): void {
  const estimate = job.estimate;
  job.status = "running";
  job.error = undefined;
  job.finishedAt = undefined;
  job.cloudRun = undefined;
  job.stages = STAGE_ORDER.map((key) => ({
    key, label: STAGE_LABELS[key], status: "pending", fraction: 0, estSec: estimate.stageSec[key],
  }));
  persist();
  void run(job);
}

export function recoverInterruptedJobs(): void {
  for (const job of jobs.values()) {
    if (job.publish?.status === "running") {
      job.publish = { ...job.publish, status: "failed", finishedAt: Date.now(), error: "Interrupted by an app restart - click Publish again" };
    }
    if (job.status !== "running") continue;

    job.restarts = (job.restarts ?? 0) + 1;
    if (job.restarts > MAX_RESTARTS) {
      job.status = "failed";
      job.error = "Interrupted by repeated app restarts";
      job.finishedAt = Date.now();
      continue;
    }
    if (job.cloudRun) {
      pipelineLogger.info(`[${job.id}] Re-attaching to GitHub run #${job.cloudRun.runId}`, "StickmanJob");
      void run(job, true).then(() => {
        // the run was cancelled/lost: start the whole job again once rather than leave it failed
        if (job.status === "failed" && job.restarts! <= MAX_RESTARTS) restartFromScratch(job);
      });
    } else {
      pipelineLogger.info(`[${job.id}] Restarting interrupted job from scratch`, "StickmanJob");
      restartFromScratch(job);
    }
  }
  persist();
}

setTimeout(recoverInterruptedJobs, 5000).unref();
