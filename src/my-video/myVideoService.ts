import fs from "fs";
import path from "path";
import { spawn } from "child_process";
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

    emit({ stage: "bundle", fraction: 0 });
    let totalFrames: number | undefined;
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
    emit({ stage: "finalize", fraction: 1, totalFrames });
    if (!fs.existsSync(renderedPath)) throw new Error(`my-video finished but ${renderedPath} is missing`);

    fs.mkdirSync(config.paths.outputDir, { recursive: true });
    const videoPath = path.join(config.paths.outputDir, `stickman-${spec.slug}.mp4`);
    fs.copyFileSync(renderedPath, videoPath);
    return { videoPath, slug: spec.slug };
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    // my-video leaves the mp4 plus a QA stamp (<slug>.mp4.qa.json) in out/
    const outDir = path.dirname(renderedPath);
    for (const f of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) {
      if (f.startsWith(`${spec.slug}.`)) fs.rmSync(path.join(outDir, f), { force: true });
    }
  }
};
