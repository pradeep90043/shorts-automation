import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { renderStickmanVideo, type RenderProgress } from "./myVideoService";
import {
  estimateStickman, recordTimings, STAGE_LABELS, STAGE_ORDER,
  type StageKey, type StickmanEstimate,
} from "./stickmanEstimate";
import { cleanScript, fitScriptToDuration, planStickmanVideo } from "./stickmanPlanner";

export interface StickmanJobInput {
  script: string;
  title?: string;
  /** requested video length in seconds */
  targetSec?: number;
  orientation?: "horizontal" | "vertical";
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
  status: "running" | "done" | "failed";
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
  /** the narration actually used (after cleanup and, if a target length was set, rewriting) */
  finalScript?: string;
  /** how the script was adjusted to the target length */
  adjustNote?: string;
  error?: string;
  videoPath?: string;
}

const jobs = new Map<string, StickmanJob>();
const jobsFile = () => path.join(config.paths.dataDir, "stickman-jobs.json");
const KEEP = 20;

function persist(): void {
  try {
    fs.mkdirSync(config.paths.dataDir, { recursive: true });
    const finished = [...jobs.values()].filter((j) => j.status !== "running").slice(-KEEP);
    fs.writeFileSync(jobsFile(), JSON.stringify(finished));
  } catch {
    /* history is best-effort */
  }
}

(function loadFinishedJobs() {
  try {
    for (const j of JSON.parse(fs.readFileSync(jobsFile(), "utf8")) as StickmanJob[]) jobs.set(j.id, j);
  } catch {
    /* none yet */
  }
})();

export const isStickmanBusy = (): boolean => [...jobs.values()].some((j) => j.status === "running");

function setStage(job: StickmanJob, key: StageKey, patch: Partial<StageState>): void {
  const st = job.stages.find((s) => s.key === key)!;
  const now = Date.now();
  if (patch.status === "running" && !st.startedAt) st.startedAt = now;
  if (patch.status === "done" && st.startedAt && st.actualSec === undefined) st.actualSec = (now - st.startedAt) / 1000;
  Object.assign(st, patch);
}

function applyProgress(job: StickmanJob, p: RenderProgress): void {
  const idx = STAGE_ORDER.indexOf(p.stage);
  // entering a stage completes every earlier one
  for (const s of job.stages) {
    if (STAGE_ORDER.indexOf(s.key) < idx && s.status !== "done") setStage(job, s.key, { status: "done", fraction: 1 });
  }
  const done = p.fraction >= 1;
  setStage(job, p.stage, { status: done ? "done" : "running", fraction: Math.min(1, p.fraction), detail: p.detail });
}

export function startStickmanJob(input: StickmanJobInput): StickmanJob {
  if (isStickmanBusy()) throw new Error("A video is already being created - wait for it to finish.");
  const script = input.script.trim();
  if (!script) throw new Error("Script is empty");

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
  void run(job);
  return job;
}

async function run(job: StickmanJob): Promise<void> {
  const { script, title, orientation, resolution } = job.input;
  const log = (msg: string) => pipelineLogger.info(`[${job.id}] ${msg}`, "StickmanJob");
  try {
    setStage(job, "plan", { status: "running", fraction: 0.1, detail: "Fitting script to length" });
    const fit = await fitScriptToDuration(cleanScript(script), job.input.targetSec);
    job.finalScript = fit.script;
    job.adjustNote = fit.note;
    log(fit.note);
    // re-estimate for the final script: voice rate and stage times follow its real length
    const fitted = estimateStickman(fit.script, job.input.targetSec, job.input.resolution ?? 720, true);
    job.estimate = fitted;
    for (const s of job.stages) s.estSec = fitted.stageSec[s.key];
    setStage(job, "plan", { fraction: 0.5, detail: "Choosing visuals" });
    const plan = await planStickmanVideo(fit.script, title);
    Object.assign(job, { title: plan.title, description: plan.description, tags: plan.tags, scenes: plan.scenes.length, aiVisuals: plan.aiVisuals });
    setStage(job, "plan", { status: "done", fraction: 1 });
    log(`Planned ${plan.scenes.length} scenes (${plan.aiVisuals ? "AI" : "rule-based"} visuals)`);

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
      },
      (p) => applyProgress(job, p),
    );

    for (const s of job.stages) if (s.status !== "done") setStage(job, s.key, { status: "done", fraction: 1 });
    job.videoPath = result.videoPath;
    job.status = "done";
    job.finishedAt = Date.now();
    learn(job);
    log(`Done in ${Math.round((job.finishedAt - job.createdAt) / 1000)}s -> ${result.videoPath}`);
  } catch (err: any) {
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
  return { ...job, progress, elapsedSec, etaSec };
}

export const getStickmanJob = (id: string): JobSnapshot | undefined => {
  const j = jobs.get(id);
  return j ? snapshot(j) : undefined;
};

export const listStickmanJobs = (): JobSnapshot[] =>
  [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, KEEP).map(snapshot);
