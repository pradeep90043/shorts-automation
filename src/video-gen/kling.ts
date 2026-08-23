import fs from "fs";
import path from "path";
import { pipelineLogger } from "../utils/logger";

const KLING_API_BASE = "https://api.klingai.com/v1";
const KLING_API_KEY = process.env.KLING_API_KEY || "";

export interface KlingVideoOptions {
  prompt: string;
  duration?: 5 | 10;           // seconds — 5 or 10
  aspectRatio?: "9:16" | "16:9" | "1:1";
  mode?: "std" | "pro";        // std = faster, pro = higher quality
  negativePrompt?: string;
  cfgScale?: number;           // 0.0–1.0, default 0.5
}

interface KlingTask {
  task_id: string;
  task_status: "submitted" | "processing" | "succeed" | "failed";
  task_status_msg?: string;
  task_result?: {
    videos?: Array<{ id: string; url: string; duration: string }>;
  };
}

/** Submit a text-to-video task to Kling AI */
async function submitTask(opts: KlingVideoOptions): Promise<string> {
  const body = {
    model_name: "kling-v2-master",
    prompt: opts.prompt,
    negative_prompt: opts.negativePrompt ?? "blurry, low quality, watermark, text, logo, distorted",
    cfg_scale: opts.cfgScale ?? 0.5,
    mode: opts.mode ?? "std",
    duration: String(opts.duration ?? 5),
    aspect_ratio: opts.aspectRatio ?? "9:16",
  };

  const res = await fetch(`${KLING_API_BASE}/videos/text2video`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KLING_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Kling submit failed (${res.status}): ${err}`);
  }

  const data = (await res.json()) as { code: number; message: string; data: { task_id: string } };
  if (data.code !== 0) throw new Error(`Kling API error: ${data.message}`);

  pipelineLogger.info(`Kling task submitted: ${data.data.task_id}`, "KlingVideoGen");
  return data.data.task_id;
}

/** Poll task until complete (max ~5 minutes) */
async function pollTask(taskId: string, timeoutMs = 300_000): Promise<KlingTask> {
  const interval = 8_000; // poll every 8s
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${KLING_API_BASE}/videos/text2video/${taskId}`, {
      headers: { Authorization: `Bearer ${KLING_API_KEY}` },
    });

    if (!res.ok) throw new Error(`Kling poll failed (${res.status})`);

    const data = (await res.json()) as { code: number; data: KlingTask };
    if (data.code !== 0) throw new Error(`Kling poll error: ${JSON.stringify(data)}`);

    const task = data.data;
    pipelineLogger.info(`Kling task ${taskId} — status: ${task.task_status}`, "KlingVideoGen");

    if (task.task_status === "succeed") return task;
    if (task.task_status === "failed") {
      throw new Error(`Kling task failed: ${task.task_status_msg ?? "unknown"}`);
    }

    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`Kling task ${taskId} timed out after ${timeoutMs / 1000}s`);
}

/** Download video from URL and save to disk */
async function downloadVideo(url: string, outputPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download Kling video: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buf);
  pipelineLogger.info(`Kling video saved → ${outputPath}`, "KlingVideoGen");
}

/**
 * Generate a video with Kling AI and save it to disk.
 * Returns the output file path.
 */
export async function generateKlingVideo(
  opts: KlingVideoOptions,
  outputPath: string,
): Promise<string> {
  if (!KLING_API_KEY) throw new Error("KLING_API_KEY is not set in environment");

  pipelineLogger.info(
    `Generating Kling video — "${opts.prompt.slice(0, 80)}…"`,
    "KlingVideoGen",
  );

  const taskId = await submitTask(opts);
  const task = await pollTask(taskId);

  const videoUrl = task.task_result?.videos?.[0]?.url;
  if (!videoUrl) throw new Error("Kling returned no video URL");

  await downloadVideo(videoUrl, outputPath);
  return outputPath;
}

/** Quick test — generates a 5s sample video */
export async function testKlingConnection(): Promise<boolean> {
  try {
    pipelineLogger.info("Testing Kling API connection…", "KlingVideoGen");
    const res = await fetch(`${KLING_API_BASE}/videos/text2video`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KLING_API_KEY}`,
      },
      body: JSON.stringify({
        model_name: "kling-v2-master",
        prompt: "test",
        duration: "5",
        aspect_ratio: "9:16",
        mode: "std",
      }),
    });
    // We just check auth — even a 400 means the key works
    if (res.status === 401) {
      pipelineLogger.error("Kling API key is invalid!", "KlingVideoGen");
      return false;
    }
    pipelineLogger.info("✅ Kling API key is valid!", "KlingVideoGen");
    return true;
  } catch (err) {
    pipelineLogger.error(`Kling connection test failed: ${err}`, "KlingVideoGen");
    return false;
  }
}
