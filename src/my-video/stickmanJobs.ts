import { planStoryboard } from "./storyPlanner";
import { visualStyleFor } from "./channelStyle";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { cancelCloudRun, renderStickmanVideo, resumeCloudRender, type CloudRunRef, type RemoteVideo, type RenderProgress, type RunnerGrant } from "./myVideoService";

/**
 * Supplied by the server: builds the YouTube upload grant for a job's channel, or null when the runner cannot
 * upload (no channel, several channels, no token) and the video must be downloaded the usual way.
 */
type RunnerPublishProvider = (job: StickmanJob) => Promise<RunnerGrant | null>;
let runnerPublishProvider: RunnerPublishProvider | undefined;
type RunnerUploadedHook = (job: StickmanJob, videoId: string) => Promise<void>;
let runnerUploadedHook: RunnerUploadedHook | undefined;
export const setRunnerUploadedHook = (fn: RunnerUploadedHook): void => { runnerUploadedHook = fn; };
export const setRunnerPublishProvider = (fn: RunnerPublishProvider): void => { runnerPublishProvider = fn; };
import {
  estimateStickman, recordTimings, STAGE_LABELS, STAGE_ORDER,
  type StageKey, type StickmanEstimate,
} from "./stickmanEstimate";
import {
  assertImportablePlan, assertPlanOnly, cleanScript, fitScriptToDuration, importStickmanPlan, planFromPlanOnly, planStickmanVideo,
  sceneNotesForBeats, splitScriptIntoBeats, type StickmanPlan,
} from "./stickmanPlanner";
import { lessonQualityReport, type QualityWarning } from "./lessonQuality";
import { cancelVoiceboxRun, estimateVoiceboxSec, generateVoiceboxNarration, sceneLines, type VoiceboxRunRef } from "./voiceboxNarration";
import { voiceInputsFor } from "./voiceProfiles";

/** `voice: "voicebox"` = the cloned voice made on GitHub Actions (see voiceboxNarration.ts) instead of an edge-tts voice. */
export const isVoicebox = (voice?: string): boolean => /^voicebox/i.test(voice ?? "");

/** A plan-only JSON may carry its own `"voice": "voicebox"` and `"language": "hi"` next to title/description/tags. */
function planVoice(plan: unknown): { voice?: string; language?: string } {
  try {
    const obj = typeof plan === "string" ? JSON.parse(plan) : plan;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const o = obj as any;
      return { voice: typeof o.voice === "string" ? o.voice : undefined, language: typeof o.language === "string" ? o.language : undefined };
    }
  } catch {
    /* pasted text that is not plain JSON has no voice setting */
  }
  return {};
}

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
  /** edge-tts voice for the narration, e.g. "en-IN-PrabhatNeural"; "voicebox" = the cloned voice; omit for my-video's default Hindi voice */
  voice?: string;
  /** language code of the narration ("hi", "en"); used by the cloned voice (default "hi") */
  language?: string;
  resolution?: 720 | 1080;
  channelKey?: string;
  /** the finished file is only handed back: the runner must not upload it to YouTube itself (a Short is published by its own pipeline) */
  noRunnerPublish?: boolean;
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
  /** the cloned-voice run (voicebox-scenes.yml) while the narration is being made */
  voiceRun?: VoiceboxRunRef;
  /** how many times this job was (re)started after an app restart */
  restarts?: number;
  publish?: PublishState;
  /** Set when the cloud runner uploaded the finished video straight to YouTube (no local file) */
  remote?: RemoteVideo & { channelKey?: string };
  /** Persisted StickmanPlan so a cancelled/failed job can continue without re-running LLM planning */
  plan?: StickmanPlan;
  /** Directory with generated narration audio if cloned voice succeeded */
  narrationDir?: string;
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
    const pv = planVoice(input.plan);
    input = { ...input, repairMissing: undefined, voice: input.voice || pv.voice, language: input.language || pv.language };
  } else {
    if (!script) throw new Error("Script is empty");
    // an imported plan is checked against the script up front, so a mismatch is rejected before a job exists
    if (input.plan != null && input.plan !== "") assertImportablePlan(script, input.plan, !!input.repairMissing);
    else input = { ...input, plan: undefined, repairMissing: undefined };
  }

  const estimate = estimateStickman(script, input.targetSec, input.resolution ?? 720, false, !!input.planOnly);
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
      finishJob(job, result.videoPath, log, result.remote);
      return;
    }
    let plan: StickmanPlan;
    const planStageDone = job.stages.find((s) => s.key === "plan")?.status === "done";
    let planReused = false;
    if (resume && job.plan && planStageDone) {
      planReused = true;
      plan = job.plan;
      log(`Reusing planned video: ${plan.scenes.length} scenes`);
    } else {
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
      const fitted = estimateStickman(fit.script, job.input.targetSec, job.input.resolution ?? 720, true, planOnly);
      job.estimate = fitted;
      for (const s of job.stages) s.estSec = fitted.stageSec[s.key];
      setStage(job, "plan", { fraction: 0.5, detail: imported ? "Applying imported visuals" : "Choosing visuals" });
      // the author's Stickman/Remotion-visual sections steer the director, but only while the narration is still their script
      const notes = !planOnly && fit.script === cleanScript(script) ? sceneNotesForBeats(script, splitScriptIntoBeats(fit.script)) : null;
      if (notes) log(`Structured script: narrating only the Voiceover sections; ${notes.notes.filter(Boolean).length} section(s) of visual directions passed to the director`);
      plan = planOnly
        ? planFromPlanOnly(job.input.plan, title)
        : imported
          ? await importStickmanPlan(fit.script, job.input.plan, { repair: job.input.repairMissing, titleHint: title, notes })
          : visualStyleFor(job.input.channelKey) === "story"
            ? await planStoryboard(fit.script, title)
            : await planStickmanVideo(fit.script, title, notes);
      if (isCancelled(job)) return;
      job.plan = plan;
      Object.assign(job, { title: plan.title, description: plan.description, tags: plan.tags, scenes: plan.scenes.length, aiVisuals: plan.aiVisuals });
      setStage(job, "plan", { status: "done", fraction: 1 });
      log(`Planned ${plan.scenes.length} scenes (${planOnly ? "imported plan, no AI" : plan.aiVisuals ? "AI" : "rule-based"} visuals)`);
      // lesson-quality gate: warnings only, shown in the dashboard and kept on the job
      const warnings = lessonQualityReport(plan.scenes.map((s) => ({ text: s.text, visual: s.visual }))).slice(0, 15);
      job.warnings = warnings;
      for (const w of warnings.filter((x) => x.level === "warn")) log(`quality: ${w.scene ? `scene ${w.scene}: ` : ""}${w.message}`);
    }

    // cloned voice: one audio file per scene, made on GitHub Actions; the video is then built on the real audio lengths
    // jobs made before narrationDir was saved: the narration folder has a fixed name
    let narrationDir: string | undefined = job.narrationDir ?? (isVoicebox(job.input.voice) ? path.join(config.paths.outputDir, `voicebox-lv-${job.id}`) : undefined);
    const language = job.input.language || (/-en$/i.test(job.input.voice ?? "") ? "en" : "hi");
    const audioStageDone = job.stages.find((s) => s.key === "audio")?.status === "done";
    if (isVoicebox(job.input.voice)) {
      // only reuse the audio when the scenes are the ones it was spoken for (the plan was reused, not re-made)
      if (resume && planReused && audioStageDone && narrationDir && fs.existsSync(narrationDir)) {
        log(`Reusing cloned-voice narration from ${narrationDir}`);
      } else {
        const lines = sceneLines(plan.scenes);
        const voiceSec = estimateVoiceboxSec(lines.reduce((n, l) => n + l.text.length, 0), 20, 800, language);
        const audio = job.stages.find((s) => s.key === "audio");
        if (audio) {
          job.estimate.totalSec += voiceSec - audio.estSec;
          job.estimate.stageSec.audio = voiceSec;
          audio.estSec = voiceSec;
        }
        setStage(job, "audio", { status: "running", fraction: 0.01, detail: `Cloned voice for ${lines.length} scenes` });
        const made = await generateVoiceboxNarration({
          slug: `lv-${job.id}`,
          lines,
          language,
          resume: resume ? job.voiceRun : undefined,
          inputs: voiceInputsFor(job.input.channelKey), // the channel's own cloned voice (Storiyum = paki1)
          isCancelled: () => isCancelled(job),
          onRun: (ref) => { job.voiceRun = ref; persist(); },
          onProgress: (p) => { setStage(job, "audio", { status: "running", fraction: p.fraction, detail: p.detail }); persistSoon(); },
        });
        if (isCancelled(job)) return;
        narrationDir = made.dir;
        job.narrationDir = narrationDir;
        job.voiceRun = undefined;
        setStage(job, "audio", { status: "done", fraction: 1, detail: "Cloned voice ready" });
        log(`Cloned-voice narration ready: ${made.files} scenes`);
      }
    }

    const result = await renderStickmanVideo(
      {
        slug: `lv-${job.id}`,
        title: plan.title,
        description: plan.description,
        tags: plan.tags,
        scenes: plan.scenes,
        cast: plan.cast,
        orientation: orientation ?? "horizontal",
        theme: "dark", // developers prefer a dark screen: code panels and the CodeOrCap brand are built for it
        runnerPublish: runnerPublishProvider && job.input.channelKey && !job.input.noRunnerPublish ? () => runnerPublishProvider!(job) : undefined,
        onRunnerUploaded: runnerUploadedHook ? (videoId: string) => runnerUploadedHook!(job, videoId) : undefined,
        resolution: resolution ?? (orientation === "vertical" ? 1080 : 720),
        rate: job.estimate.rate,
        ...(narrationDir
          ? { narrationDir, language }
          : job.input.voice ? { voice: job.input.voice, language: job.input.voice.slice(0, 2) } : {}),
      },
      (p) => applyProgress(job, p),
    );

    finishJob(job, result.videoPath, log, result.remote);
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

function finishJob(job: StickmanJob, videoPath: string, log: (m: string) => void, remote?: RemoteVideo): void {
  if (isCancelled(job)) return;
  for (const s of job.stages) if (s.status !== "done") setStage(job, s.key, { status: "done", fraction: 1 });
  if (remote) {
    // the runner put it on YouTube (private by default): there is no local file to preview or download
    job.remote = { ...remote, channelKey: job.input.channelKey };
    videoPath = "";
  }
  job.videoPath = videoPath || undefined;
  job.status = "done";
  job.finishedAt = Date.now();
  job.cloudRun = undefined;
  job.voiceRun = undefined;
  if (job.input.plan != null) job.input.plan = "imported"; // keep the marker, free the data
  learn(job);
  log(`Done in ${Math.round((job.finishedAt - job.createdAt) / 1000)}s -> ${remote ? `${remote.url} (${remote.privacy}, uploaded by the runner)` : videoPath}`);
}

/** The runner uploaded the video privately; the user made it public from the dashboard. */
export function markRemotePublic(jobId: string, urlForChannel: { channelName: string; url: string }): PublishState | undefined {
  const job = jobs.get(jobId);
  if (!job?.remote) return undefined;
  job.remote.privacy = "public";
  job.publish = { status: "done", startedAt: Date.now(), finishedAt: Date.now(), channelKey: job.remote.channelKey, url: urlForChannel.url, urls: [urlForChannel], pct: 100 };
  persist();
  return job.publish;
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
  const voiceRef = job.voiceRun;
  job.cloudRun = undefined;
  job.voiceRun = undefined;
  persist();
  pipelineLogger.info(`[${job.id}] Cancelled by user${ref ? ` (stopping GitHub run #${ref.runId})` : ""}`, "StickmanJob");
  if (ref) await cancelCloudRun(ref);
  if (voiceRef) await cancelVoiceboxRun(voiceRef);
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
  job.plan = undefined;
  job.narrationDir = undefined;
  restartFromScratch(job);
  pipelineLogger.info(`[${job.id}] Restarted by user from scratch`, "StickmanJob");
  return job;
}

/** Continues a cancelled (or failed) job from the last completed stage. */
export function continueStickmanJob(id: string): StickmanJob {
  const job = jobs.get(id);
  if (!job) throw new Error("Job not found");
  if (isStickmanBusy()) throw new Error("A video is already being created - wait for it to finish.");
  if (job.status !== "cancelled" && job.status !== "failed") {
    throw new Error(`Cannot continue job in '${job.status}' state`);
  }
  const hasProgress = job.stages.some((s) => s.status === "done") || job.plan != null;
  if (!hasProgress) {
    throw new Error("No steps have completed yet - use restart instead.");
  }
  job.status = "running";
  job.error = undefined;
  job.finishedAt = undefined;
  job.videoPath = undefined;
  job.publish = undefined;
  job.cloudRun = undefined;
  // job.voiceRun is kept: a voice run that already finished is re-attached and downloaded instead of re-spoken
  for (const s of job.stages) {
    if (s.status !== "done") {
      s.status = "pending";
      s.fraction = 0;
      s.detail = undefined;
      s.startedAt = undefined;
      s.actualSec = undefined;
    }
  }
  persist();
  pipelineLogger.info(`[${job.id}] Continuing from last step`, "StickmanJob");
  void run(job, true);
  return job;
}

/** Feed measured stage timings back so the next estimate is closer. */
function learn(job: StickmanJob): void {
  if (isVoicebox(job.input.voice)) return;
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
  /** True when the job has at least one completed stage or saved plan, so it can be continued from the last step */
  canContinue: boolean;
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
  const canContinue = job.stages.some((s) => s.status === "done") || job.plan != null;
  // the imported plan can be hundreds of KB: the dashboard only needs to know there was one
  const input = job.input.plan != null ? { ...job.input, plan: "imported" } : job.input;
  return { ...job, input, progress, elapsedSec, etaSec, canContinue };
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
  job.voiceRun = undefined;
  job.stages = STAGE_ORDER.map((key) => ({
    key, label: STAGE_LABELS[key], status: "pending", fraction: 0, estSec: estimate.stageSec[key],
  }));
  persist();
  void run(job);
}

/**
 * What to do with a job that was running when the app restarted: re-attach to its render run, re-attach to its cloned-voice run
 * (the voice stage is ~10 minutes of GitHub time on 20 runners: starting it again throws that away), or start over.
 */
export function interruptedJobAction(job: Pick<StickmanJob, "cloudRun" | "voiceRun">): "render" | "voice" | "scratch" {
  if (job.cloudRun) return "render";
  if (job.voiceRun) return "voice";
  return "scratch";
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
    const action = interruptedJobAction(job);
    if (action !== "scratch") {
      pipelineLogger.info(`[${job.id}] Re-attaching to GitHub ${action === "voice" ? "voice" : "render"} run #${(job.cloudRun ?? job.voiceRun)!.runId}`, "StickmanJob");
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
