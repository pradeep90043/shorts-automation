import fs from "fs";
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
      const p = spawn("nice", ["-n", "15", cmd, ...args], { stdio: "ignore" });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    });
  return run("unzip", ["-o", zipFile, "-d", outDir]).catch(() => run("python3", ["-m", "zipfile", "-e", zipFile, outDir]));
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

  const defaultBaseUrl = process.env.BOT_ENV === "dev"
    ? "https://shorts-dev.duckdns.org"
    : "https://shorts-automation.duckdns.org";
  const baseUrl = (process.env.BASE_URL || process.env.PUBLIC_URL || defaultBaseUrl).replace(/\/+$/, "");

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
  const downloadRes = await fetchRetry(artifact.archive_download_url, {
    headers: authHeaders(token),
  });
  if (!downloadRes.ok || !downloadRes.body) {
    logger.warn(`[CloudShortRenderer] Failed to download artifact: ${downloadRes.status}`);
    return null;
  }

  const zipFile = path.join(tempDir, `short-${id}.zip`);
  await pipeline(Readable.fromWeb(downloadRes.body as any), fs.createWriteStream(zipFile));

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
