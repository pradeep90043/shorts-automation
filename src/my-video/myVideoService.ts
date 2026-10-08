import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { spawn } from "child_process";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { config } from "../config";
import { logger } from "../utils/logger";

/**
 * Bridge to the separate `my-video` repo (Remotion + stickman templates).
 * It runs the repo's own `longform` pipeline as a child process, so its
 * dependencies (Remotion, React, three) stay out of this project.
 *
 * Location: MY_VIDEO_DIR env, else ./my-video (submodule), else ../my-video.
 */

export interface StickmanScene {
  id: string;
  text: string;
  /** Text sent to TTS when it should differ from the on-screen caption */
  ttsText?: string;
  pauseBefore?: number;
  /** Template visual spec, see my-video/src/stickman/schema.ts */
  visual?: unknown;
}

export interface StickmanVideoSpec {
  /** Folder name under my-video/public/content/ (letters, digits, - and _) */
  slug: string;
  title?: string;
  description?: string;
  tags?: string[];
  scenes: StickmanScene[];
  /** "vertical" = 1080x1920 Short/Reel, default 16:9 long-form */
  orientation?: "horizontal" | "vertical";
  theme?: string;
  voice?: string;
  rate?: string;
  pitch?: string;
  language?: string;
  fps?: number;
  /** Output size: frame width for vertical (default 1080), frame height for horizontal (default 720) */
  resolution?: 720 | 1080;
}

/** Pipeline stages inside my-video, in execution order. */
export type RenderStage = "audio" | "merge" | "bundle" | "render" | "finalize";

export interface RenderProgress {
  stage: RenderStage;
  /** 0..1 within the stage */
  fraction: number;
  detail?: string;
  /** total frames of the video, once Remotion reports it */
  totalFrames?: number;
  /** set once the GitHub run is known, so the app can resume watching it after a restart */
  cloudRun?: CloudRunRef;
}

export interface CloudRunRef {
  runId: number;
  repo: string;
  /** per-job token the runner uses for progress callbacks */
  token: string;
}

/** Stops a GitHub Actions render (used by the Cancel button). Never throws. */
export async function cancelCloudRun(ref: CloudRunRef): Promise<void> {
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!ghToken) return;
  try {
    await fetch(`https://api.github.com/repos/${ref.repo}/actions/runs/${ref.runId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
    });
  } catch {
    /* the run times out on its own if GitHub is unreachable */
  }
}

export type ProgressCallback = (p: RenderProgress) => void;

export interface MyVideoRenderResult {
  videoPath: string;
  slug: string;
}

export const resolveMyVideoDir = (): string => {
  const candidates = [
    process.env.MY_VIDEO_DIR,
    path.resolve(process.cwd(), "my-video"),
    path.resolve(process.cwd(), "..", "my-video"),
  ].filter((p): p is string => !!p);
  for (const dir of candidates) {
    // node_modules check: a freshly cloned submodule without `npm install` can't render
    if (
      fs.existsSync(path.join(dir, "scripts", "longs", "run.ts")) &&
      fs.existsSync(path.join(dir, "node_modules", "remotion"))
    ) return dir;
  }
  throw new Error(
    `my-video repo not found or its dependencies are not installed (npm install). Set MY_VIDEO_DIR or add the submodule. Tried: ${candidates.join(", ")}`,
  );
};

const RENDER_TIMEOUT_MS = Number(process.env.MY_VIDEO_TIMEOUT_MIN ?? 45) * 60 * 1000;
// Remotion spawns one Chromium tab per unit of concurrency; keep it low so a
// render can't starve the bot/postgres on a small VM. Raise on bigger hosts.
const RENDER_CONCURRENCY = process.env.MY_VIDEO_CONCURRENCY ?? "1";

const run = (cwd: string, args: string[], onText?: (text: string) => void): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn("npm", args, { cwd, env: process.env });
    const tail: string[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RENDER_TIMEOUT_MS);
    const onData = (buf: Buffer) => {
      const text = buf.toString();
      tail.push(text);
      if (tail.length > 50) tail.shift();
      logger.debug(`[my-video] ${text.trimEnd()}`);
      onText?.(text);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const why = timedOut ? `timed out after ${RENDER_TIMEOUT_MS / 60000} min` : `exited with code ${code}`;
      reject(new Error(`my-video ${args.join(" ")} ${why}:\n${tail.join("").slice(-2000)}`));
    });
  });

/** Live frame counts pushed by the GitHub runners (POST /api/longvideo/progress), keyed by slug, one entry per parallel chunk. */
const cloudProgress = new Map<string, { token: string; chunks: Map<number, { done: number; total: number }> }>();

export const recordCloudProgress = (slug: string, token: string, done: number, total: number, chunk = 0): boolean => {
  const entry = cloudProgress.get(slug);
  if (!entry || entry.token !== token || !Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return false;
  entry.chunks.set(chunk, { done: Math.min(done, total), total });
  return true;
};

const sumProgress = (slug: string): { done: number; total: number } => {
  let done = 0, total = 0;
  for (const c of cloudProgress.get(slug)?.chunks.values() ?? []) { done += c.done; total += c.total; }
  return { done, total };
};

/** fetch with retries: a single transient network error must not fail a render that already succeeded in the cloud. */
async function fetchRetry(url: string, init?: RequestInit, attempts = 6): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500 && res.status !== 429) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * 2 ** i)));
  }
  throw lastErr;
}

async function renderViaGithubActions(
  _dir: string,
  spec: StickmanVideoSpec,
  renderedPath: string,
  emit: (p: RenderProgress) => void,
  resume?: CloudRunRef,
): Promise<void> {
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!ghToken) throw new Error("No GITHUB_TOKEN configured for cloud rendering");

  const repo = process.env.MY_VIDEO_GITHUB_REPO || "pradeep90043/my-video";
  const publicUrl = process.env.PUBLIC_URL || "https://shorts-automation.duckdns.org";
  const bundleUrl = `${publicUrl}/api/longvideo/bundle/${spec.slug}`;
  const progressToken = resume?.token ?? randomBytes(12).toString("hex");
  cloudProgress.set(spec.slug, { token: progressToken, chunks: new Map() });
  const vertical = spec.orientation === "vertical";
  const resolution = String(spec.resolution ?? (vertical ? 1080 : 720));

  let runId: number | null = resume?.runId ?? null;
  if (resume) {
    cloudProgress.set(spec.slug, { token: resume.token, chunks: new Map() });
    logger.info(`[my-video] Resuming watch of GitHub Cloud run #${runId}`);
    emit({ stage: "render", fraction: 0, detail: "Reconnected to GitHub Cloud run...", cloudRun: resume });
  } else {
    logger.info(`[my-video] Dispatching Remotion render to GitHub Cloud (${repo})...`);
    emit({ stage: "bundle", fraction: 0.1, detail: "Dispatching to GitHub Cloud (7GB RAM)..." });

    const dispatchRes = await fetchRetry(`https://api.github.com/repos/${repo}/actions/workflows/render.yml/dispatches`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ghToken}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "shorts-automation",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          project: spec.slug,
          bundle_url: bundleUrl,
          progress_url: `${publicUrl}/api/longvideo/progress`,
          progress_token: progressToken,
        // parallel runners; the workflow only splits when there are enough frames per runner
        chunks: process.env.MY_VIDEO_RENDER_CHUNKS || "8",
          resolution,
          draft: "false",
        },
      }),
    });

    if (!dispatchRes.ok) {
      const errText = await dispatchRes.text();
      throw new Error(`GitHub Actions dispatch failed (${dispatchRes.status}): ${errText}`);
    }

    // Poll for newly created workflow run
    emit({ stage: "bundle", fraction: 0.3, detail: "Waiting for GitHub Cloud runner..." });
    let runUrl = "";
    const dispatchTime = Date.now() - 15000;

    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const runsRes = await fetchRetry(`https://api.github.com/repos/${repo}/actions/runs?event=workflow_dispatch&per_page=5`, {
          headers: {
            "Authorization": `Bearer ${ghToken}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "shorts-automation",
          },
        });
        if (runsRes.ok) {
          const data = (await runsRes.json()) as any;
          const matching = (data.workflow_runs || []).find(
            (r: any) => new Date(r.created_at).getTime() >= dispatchTime
          );
          if (matching) {
            runId = matching.id;
            runUrl = matching.html_url;
            logger.info(`[my-video] Found active GitHub Cloud run #${runId}: ${runUrl}`);
            emit({ stage: "render", fraction: 0, detail: "GitHub Cloud run started", cloudRun: { runId: runId!, repo, token: progressToken } });
            break;
          }
        }
      } catch (e) {
        // transient network poll error
      }
    }

    if (!runId) {
      throw new Error("Dispatched to GitHub Actions, but workflow run could not be found within 100s.");
    }

  }

  // Poll workflow run until completed
  while (true) {
    await new Promise((r) => setTimeout(r, 6000));
    let statusRes: Response;
    try {
      statusRes = await fetchRetry(`https://api.github.com/repos/${repo}/actions/runs/${runId}`, {
      headers: {
        "Authorization": `Bearer ${ghToken}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "shorts-automation",
      },
    });
    } catch (err) {
      logger.warn(`[my-video] GitHub status poll failed, will keep polling: ${(err as Error).message}`);
      continue;
    }
    if (!statusRes.ok) continue;
    const run = (await statusRes.json()) as any;

    if (run.status === "in_progress") {
      const live = sumProgress(spec.slug);
      if (live.total > 0) {
        emit({ stage: "render", fraction: live.done / live.total, totalFrames: live.total, detail: `Frame ${live.done}/${live.total} (GitHub Cloud)` });
      } else {
        emit({ stage: "render", fraction: 0, detail: "GitHub Cloud: voiceover, audio mix and bundling..." });
      }
    } else if (run.status === "completed") {
      if (run.conclusion !== "success") {
        throw new Error(`GitHub Cloud Render failed with status: ${run.conclusion}. Check logs: ${run.html_url}`);
      }
      break;
    }
  }

  // Fetch artifact
  emit({ stage: "finalize", fraction: 0.7, detail: "Downloading rendered video from GitHub Cloud..." });
  const artifactsRes = await fetchRetry(`https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts`, {
    headers: {
      "Authorization": `Bearer ${ghToken}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "shorts-automation",
    },
  });
  if (!artifactsRes.ok) throw new Error("Failed to list artifacts from GitHub run");
  const artifactsData = (await artifactsRes.json()) as any;
  const artifact = (artifactsData.artifacts || []).find((a: any) => a.name.startsWith(`video-${spec.slug}`));
  if (!artifact) throw new Error(`Video artifact not found in completed GitHub run #${runId}`);

  logger.info(`[my-video] Downloading artifact ${artifact.name} (${artifact.size_in_bytes} bytes)...`);
  const downloadRes = await fetchRetry(artifact.archive_download_url, {
    headers: { "Authorization": `Bearer ${ghToken}`, "User-Agent": "shorts-automation" },
  });
  if (!downloadRes.ok) throw new Error(`Failed to download artifact: ${downloadRes.status}`);

  const outDir = path.dirname(renderedPath);
  fs.mkdirSync(outDir, { recursive: true });
  const zipFile = path.join(outDir, `${spec.slug}.artifact.zip`);
  // stream to disk: buffering a few-hundred-MB zip in RAM swaps a small VM to a crawl
  if (!downloadRes.body) throw new Error("Artifact download had no body");
  await pipeline(Readable.fromWeb(downloadRes.body as any), fs.createWriteStream(zipFile));

  // async + low priority so unzipping never blocks the event loop / starves the API
  const runCmd = (cmd: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn("nice", ["-n", "15", cmd, ...args], { stdio: "ignore" });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    });
  try {
    await runCmd("unzip", ["-o", zipFile, "-d", outDir]);
  } catch {
    await runCmd("python3", ["-m", "zipfile", "-e", zipFile, outDir]);
  }
  fs.rmSync(zipFile, { force: true });

  // Locate the extracted mp4 file
  const extractedFiles = fs.readdirSync(outDir);
  const mp4 = extractedFiles.find((f) => f.endsWith(".mp4") && f.includes(spec.slug)) ?? extractedFiles.find((f) => f.endsWith(".mp4"));
  if (mp4 && path.join(outDir, mp4) !== renderedPath) {
    fs.renameSync(path.join(outDir, mp4), renderedPath);
  }
}

// Renders are CPU/RAM heavy: run one at a time, queue the rest.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Write the project into my-video and run TTS -> merge -> Remotion render.
 * The mp4 is moved into this app's output dir (so the existing 24h cleanup
 * covers it) and the temporary project files in my-video are removed.
 */
export const renderStickmanVideo = (
  spec: StickmanVideoSpec,
  onProgress?: ProgressCallback,
): Promise<MyVideoRenderResult> => {
  const job = queue.then(() => doRender(spec, onProgress));
  queue = job.catch(() => undefined);
  return job;
};

/**
 * Re-attach to a GitHub Cloud run that was in flight when the app restarted:
 * keep polling it, download the finished video and return it like a normal render.
 */
export const resumeCloudRender = (
  slug: string,
  ref: CloudRunRef,
  onProgress?: ProgressCallback,
): Promise<MyVideoRenderResult> => {
  const job = queue.then(async () => {
    const dir = resolveMyVideoDir();
    const renderedPath = path.join(dir, "out", `${slug}.mp4`);
    const emit = (p: RenderProgress) => onProgress?.(p);
    try {
      await renderViaGithubActions(dir, { slug } as StickmanVideoSpec, renderedPath, emit, ref);
      emit({ stage: "finalize", fraction: 1 });
      if (!fs.existsSync(renderedPath)) throw new Error(`cloud render finished but ${renderedPath} is missing`);
      fs.mkdirSync(config.paths.outputDir, { recursive: true });
      const videoPath = path.join(config.paths.outputDir, `stickman-${slug}.mp4`);
      await fs.promises.copyFile(renderedPath, videoPath);
      return { videoPath, slug };
    } finally {
      cloudProgress.delete(slug);
      fs.rmSync(path.join(dir, "public", "content", slug), { recursive: true, force: true });
      const outDir = path.dirname(renderedPath);
      for (const f of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) {
        if (f.startsWith(`${slug}.`)) fs.rmSync(path.join(outDir, f), { force: true });
      }
    }
  });
  queue = job.catch(() => undefined);
  return job;
};

const doRender = async (spec: StickmanVideoSpec, onProgress?: ProgressCallback): Promise<MyVideoRenderResult> => {
  if (!/^[A-Za-z0-9_-]+$/.test(spec.slug)) {
    throw new Error(`Invalid slug "${spec.slug}": use letters, digits, - and _ only`);
  }
  if (!spec.scenes.length) throw new Error("Stickman video needs at least one scene");

  const dir = resolveMyVideoDir();
  const projectDir = path.join(dir, "public", "content", spec.slug);
  const renderedPath = path.join(dir, "out", `${spec.slug}.mp4`);
  fs.mkdirSync(projectDir, { recursive: true });

  const vertical = spec.orientation === "vertical";
  const videoJson = {
    format: "longform",
    template: "stickman",
    theme: spec.theme ?? "light",
    composition: "StickmanVideo",
    orientation: spec.orientation ?? "horizontal",
    fps: spec.fps ?? 30,
    voice: spec.voice ?? "hi-IN-MadhurNeural",
    rate: spec.rate ?? "+5%",
    pitch: spec.pitch ?? "+0Hz",
    language: spec.language ?? "hi",
    title: spec.title,
    description: spec.description,
    tags: spec.tags,
    scenes: spec.scenes,
  };
  fs.writeFileSync(path.join(projectDir, "video.json"), JSON.stringify(videoJson, null, 2));
  logger.info(`[my-video] Rendering "${spec.slug}" (${vertical ? "short" : "long"}, ${spec.scenes.length} scenes)`);

  try {
    const project = ["--project", spec.slug];
    const sceneCount = spec.scenes.length;
    const emit = (p: RenderProgress) => onProgress?.(p);

    const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const forceLocal = process.env.RENDER_LOCAL === "true";
    let totalFrames: number | undefined;
    const useCloud = Boolean(ghToken) && !forceLocal;

    // Cloud runner generates TTS + merge itself (free edge-tts, no secrets), so the VM skips them.
    if (!useCloud) {
      emit({ stage: "audio", fraction: 0 });
      await run(dir, ["run", "longform:audio", "--", ...project], (t) => {
        // "  -> Scene 3: id (...)" is logged as each scene starts
        const m = [...t.matchAll(/-> Scene (\d+):/g)].pop();
        if (m) emit({ stage: "audio", fraction: Number(m[1]) / sceneCount, detail: `Scene ${Number(m[1]) + 1}/${sceneCount}` });
      });
      emit({ stage: "audio", fraction: 1 });

      emit({ stage: "merge", fraction: 0 });
      await run(dir, ["run", "longform:merge", "--", ...project]);
      emit({ stage: "merge", fraction: 1 });

    }

    if (useCloud) {
      logger.info(`[my-video] Dispatching Remotion render to GitHub Cloud Runner (7GB RAM)...`);
      await renderViaGithubActions(dir, spec, renderedPath, emit);
    } else {
      logger.info(`[my-video] Running local Remotion render (concurrency=${RENDER_CONCURRENCY})...`);
      emit({ stage: "bundle", fraction: 0 });
      let stage: RenderStage = "bundle";
      await run(
        dir,
        [
          "run", "longform:render", "--", ...project,
          "--concurrency", RENDER_CONCURRENCY,
          // vertical: resolution = frame width (1080 -> 1080x1920); horizontal: frame height (720 -> 1280x720)
          "--resolution", String(spec.resolution ?? (vertical ? 1080 : 720)),
        ],
        (t) => {
          // Remotion redraws progress with \r, so a chunk may hold several updates: use the latest.
          const b = [...t.matchAll(/Bundling (\d+)%/g)].pop();
          if (b && stage === "bundle") emit({ stage: "bundle", fraction: Number(b[1]) / 100 });
          const r = [...t.matchAll(/Rendered (\d+)\/(\d+)/g)].pop();
          if (r) {
            if (stage === "bundle") {
              emit({ stage: "bundle", fraction: 1 });
              stage = "render";
            }
            totalFrames = Number(r[2]);
            const done = Number(r[1]);
            emit({ stage: "render", fraction: done / totalFrames, totalFrames, detail: `Frame ${done}/${totalFrames}` });
            if (done >= totalFrames) stage = "finalize";
          }
          if (/Branding added|Running QA/.test(t)) {
            stage = "finalize";
            emit({ stage: "finalize", fraction: 0.6, totalFrames });
          }
        },
      );
    }

    emit({ stage: "finalize", fraction: 1, totalFrames });
    if (!fs.existsSync(renderedPath)) throw new Error(`my-video finished but ${renderedPath} is missing`);

    fs.mkdirSync(config.paths.outputDir, { recursive: true });
    const videoPath = path.join(config.paths.outputDir, `stickman-${spec.slug}.mp4`);
    await fs.promises.copyFile(renderedPath, videoPath);
    return { videoPath, slug: spec.slug };
  } finally {
    cloudProgress.delete(spec.slug);
    fs.rmSync(projectDir, { recursive: true, force: true });
    // my-video leaves the mp4 plus a QA stamp (<slug>.mp4.qa.json) in out/
    const outDir = path.dirname(renderedPath);
    for (const f of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) {
      if (f.startsWith(`${spec.slug}.`)) fs.rmSync(path.join(outDir, f), { force: true });
    }
  }
};
