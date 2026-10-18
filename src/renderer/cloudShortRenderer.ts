import fs from "fs";
import { publicBaseUrl } from "../utils/publicUrl";
import path from "path";
import { spawn } from "child_process";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { pipelineLogger as logger } from "../utils/logger";
import { fetchRetry } from "../my-video/myVideoService";
import type { PipelineContext } from "../types";

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "shorts-automation",
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function unzip(zipFile: string, outDir: string): Promise<void> {
  const run = (cmd: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: "ignore" });
      const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} timed out after 120 s`)); }, 120_000);
      p.on("error", (e) => { clearTimeout(timer); reject(e); });
      p.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)); });
    });
  return run("unzip", ["-o", zipFile, "-d", outDir]).catch(() => run("python3", ["-m", "zipfile", "-e", zipFile, outDir]));
}

/**
 * Downloads the artifact zip. A transfer that goes quiet is cut after 25 s (and a whole attempt after 4 min) and retried: on
 * the small VM a stalled download used to hang the job for good.
 */
async function downloadArtifact(url: string, token: string, zipFile: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ctl = new AbortController();
    let idle: NodeJS.Timeout | undefined;
    const kick = (ms: number) => { if (idle) clearTimeout(idle); idle = setTimeout(() => ctl.abort(), ms); };
    const whole = setTimeout(() => ctl.abort(), 240_000);
    try {
      kick(45_000); // time to the first byte (GitHub redirects to storage first)
      const res = await fetchRetry(url, { headers: authHeaders(token), signal: ctl.signal }, 2);
      if (!res.ok || !res.body) {
        logger.warn(`[CloudShortRenderer] Failed to download artifact: ${res.status} (attempt ${attempt}/4)`);
      } else {
        const body = Readable.fromWeb(res.body as any);
        body.on("data", () => kick(25_000)); // every chunk resets the stall timer
        await pipeline(body, fs.createWriteStream(zipFile), { signal: ctl.signal });
        return true;
      }
    } catch (err) {
      logger.warn(`[CloudShortRenderer] Artifact download attempt ${attempt}/4 failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (idle) clearTimeout(idle);
      clearTimeout(whole);
    }
    await sleep(2000);
  }
  return false;
}

/**
 * Offloads full short video rendering (FFmpeg crop, watermark, cover card, sticker, captions, audio mix)
 * to a fast 4 vCPU GitHub Actions runner with 7GB RAM.
 */
export async function renderShortCloud(
  context: PipelineContext,
  onProgress?: (detail: string) => void,
): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    logger.warn("[CloudShortRenderer] No GITHUB_TOKEN configured — skipping cloud render");
    return null;
  }

  const defaultRepo = process.env.BOT_ENV === "dev"
    ? "pradeep90043/shorts-automation-test"
    : "pradeep90043/shorts-automation";
  const repo = process.env.VOICEBOX_GITHUB_REPO || defaultRepo;

  const baseUrl = publicBaseUrl();

  const id = context.id;
  const tempDir = context.tempDir;
  const settings = (context.reviewSettings || {}) as any;

  // 1. Write short_spec.json for the runner
  const spec = {
    jobId: id,
    profile: (context.channel || "codeorcap").toLowerCase(),
    mood: (context.metadata?.mood || "technical").toLowerCase(),
    cropTopPct: settings.cropTopPct ?? 0,
    cropBottomPct: settings.cropBottomPct ?? 0,
    cover: true,
    watermark: true,
    sticker: settings.sticker ?? true,
    captions: settings.captions ?? true,
    originalAudio: settings.originalAudio ?? false,
    useVoiceover: !!context.useVoiceover,
    durationSeconds: context.videoDurationSeconds || 0,
    blurRegions: context.brandingDetection?.zones || [],
  };

  const specPath = path.join(tempDir, "short_spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf-8");

  const bundleUrl = `${baseUrl}/api/short/bundle/${id}`;
  logger.info(`[CloudShortRenderer] Dispatching short render for ${id} to ${repo} (bundle: ${bundleUrl})...`);
  onProgress?.("Dispatching short render to GitHub Cloud...");

  const dispatchTime = Date.now() - 15000;
  const dispatchRes = await fetchRetry(`https://api.github.com/repos/${repo}/actions/workflows/render-short.yml/dispatches`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        job_id: id,
        bundle_url: bundleUrl,
      },
    }),
  });

  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text();
    logger.warn(`[CloudShortRenderer] Workflow dispatch failed (${dispatchRes.status}): ${errText}`);
    return null;
  }

  // 2. Poll for the newly created workflow run
  let runId: number | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(3000);
    try {
      const runsRes = await fetchRetry(`https://api.github.com/repos/${repo}/actions/workflows/render-short.yml/runs?event=workflow_dispatch&per_page=5`, {
        headers: authHeaders(token),
      });
      if (runsRes.ok) {
        const data = (await runsRes.json()) as any;
        const matching = (data.workflow_runs || []).find(
          (r: any) => new Date(r.created_at).getTime() >= dispatchTime
        );
        if (matching) {
          runId = matching.id;
          logger.info(`[CloudShortRenderer] Found active cloud render run #${runId}: ${matching.html_url}`);
          break;
        }
      }
    } catch {
      // transient network poll error
    }
  }

  if (!runId) {
    logger.warn("[CloudShortRenderer] Dispatched cloud render but run ID not found in 60s");
    return null;
  }

  // 3. Watch run until completed (timeout: 10 minutes)
  const startTime = Date.now();
  const timeoutMs = 10 * 60 * 1000;
  while (Date.now() - startTime < timeoutMs) {
    await sleep(5000);
    try {
      const statusRes = await fetchRetry(`https://api.github.com/repos/${repo}/actions/runs/${runId}`, {
        headers: authHeaders(token),
      });
      if (!statusRes.ok) continue;
      const run = (await statusRes.json()) as any;
      if (run.status === "in_progress") {
        onProgress?.("Rendering short on GitHub Cloud runner (4 vCPU)...");
      } else if (run.status === "completed") {
        if (run.conclusion !== "success") {
          logger.warn(`[CloudShortRenderer] GitHub run #${runId} concluded with: ${run.conclusion}`);
          return null;
        }
        break;
      }
    } catch (err) {
      logger.warn(`[CloudShortRenderer] Error polling run status: ${(err as Error).message}`);
    }
  }

  // 4. Download artifact
  onProgress?.("Downloading rendered video from GitHub Cloud...");
  const artifactsRes = await fetchRetry(`https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts`, {
    headers: authHeaders(token),
  });
  if (!artifactsRes.ok) {
    logger.warn(`[CloudShortRenderer] Failed to list artifacts for run #${runId}`);
    return null;
  }

  const artifactsData = (await artifactsRes.json()) as any;
  const artifact = (artifactsData.artifacts || []).find((a: any) => a.name === `rendered-short-${id}`);
  if (!artifact) {
    logger.warn(`[CloudShortRenderer] Artifact rendered-short-${id} not found in run #${runId}`);
    return null;
  }

  logger.info(`[CloudShortRenderer] Downloading artifact ${artifact.name} (${artifact.size_in_bytes} bytes)...`);
  const zipFile = path.join(tempDir, `short-${id}.zip`);
  if (!(await downloadArtifact(artifact.archive_download_url, token, zipFile))) return null;

  // Unzip artifact
  await unzip(zipFile, tempDir);
  try { fs.unlinkSync(zipFile); } catch {}

  const finalVideoPath = path.join(tempDir, "video_final.mp4");
  if (fs.existsSync(finalVideoPath)) {
    logger.info(`[CloudShortRenderer] ✓ Successfully retrieved cloud-rendered short: ${finalVideoPath}`);
    return finalVideoPath;
  }

  return null;
}
