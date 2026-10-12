import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { config } from "../config";
import { pipelineLogger as logger } from "../utils/logger";
import { fetchRetry } from "./myVideoService";

/**
 * Narration for a video in the cloned Voicebox voice, made on GitHub Actions (.github/workflows/voicebox-scenes.yml):
 * one audio file per scene, spoken on up to 20 runners at once. The files come back as segment_<i>_<sceneId>.mp3, which
 * is exactly what my-video's `longform:audio --external` expects, so every scene lasts as long as its narration.
 */
export interface VoiceboxLine {
  /** file name without extension: segment_<scene index>_<scene id> */
  name: string;
  text: string;
}

export interface VoiceboxRunRef {
  runId: number;
  repo: string;
}

export interface VoiceboxProgress {
  /** 0..1 over the whole voice stage */
  fraction: number;
  detail: string;
}

const WORKFLOW = "voicebox-scenes.yml";
/** GitHub accepts at most 65,535 characters of workflow_dispatch inputs in total. */
const MAX_INPUT_CHARS = 60000;
const POLL_MS = 20000;
const GIVE_UP_MS = 3 * 60 * 60 * 1000;

/** The scenes as Voicebox lines, named the way my-video names a scene's audio file. */
export function sceneLines(scenes: { id: string; text: string; ttsText?: string }[]): VoiceboxLine[] {
  return scenes.map((s, i) => ({ name: `segment_${i}_${s.id}`, text: (s.ttsText || s.text).trim() }));
}

/**
 * Seconds the voice stage takes: runners start in parallel (~5 min: image pull, model, sample), then each speaks its share,
 * plus the join. Measured on CPU runners: Hindi (multilingual engine) ~13 characters spoken per second of audio and about
 * 8-10x real time (96.7 s in 8.5-13 min on 2 runners; the 211-scene lecture took 21 min); English (turbo engine) is about
 * 3.4x real time (13.8 s in 46.5 s including the model load).
 */
export function estimateVoiceboxSec(chars: number, maxShards = 20, shardChars = 800, language = "hi"): number {
  const english = language.toLowerCase().startsWith("en");
  const shards = Math.max(1, Math.min(maxShards, Math.ceil(chars / shardChars)));
  const speechSec = chars / (english ? 14 : 13) / shards;
  return Math.round(300 + speechSec * (english ? 4 : 9) * 1.2 + 60);
}

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

export async function cancelVoiceboxRun(ref: VoiceboxRunRef): Promise<void> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.github.com/repos/${ref.repo}/actions/runs/${ref.runId}/cancel`, { method: "POST", headers: authHeaders(token) });
  } catch {
    /* best effort: the run also ends by itself */
  }
}

export interface VoiceboxOptions {
  /** the video's slug: names the run's artifact and the output folder */
  slug: string;
  lines: VoiceboxLine[];
  language: string;
  onProgress?: (p: VoiceboxProgress) => void;
  /** called once the GitHub run is known, so a restarted app can re-attach to it */
  onRun?: (ref: VoiceboxRunRef) => void;
  /** re-attach to this run instead of starting a new one */
  resume?: VoiceboxRunRef;
  isCancelled?: () => boolean;
}

/** Speaks every line on GitHub Actions and returns the folder holding <name>.mp3 for each line. */
export async function generateVoiceboxNarration(opts: VoiceboxOptions): Promise<{ dir: string; files: number }> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error("No GITHUB_TOKEN configured: the cloned voice is made on GitHub Actions");
  const repo = opts.resume?.repo || process.env.VOICEBOX_GITHUB_REPO || "pradeep90043/shorts-automation";
  const emit = (fraction: number, detail: string) => opts.onProgress?.({ fraction: Math.min(1, Math.max(0, fraction)), detail });
  const gh = async (url: string, init?: RequestInit) => fetchRetry(`https://api.github.com/repos/${repo}${url}`, { ...init, headers: { ...authHeaders(token), ...(init?.headers || {}) } });

  let runId = opts.resume?.runId ?? null;
  if (!runId) {
    const linesJson = JSON.stringify(opts.lines);
    if (linesJson.length > MAX_INPUT_CHARS) {
      throw new Error(`The narration is too long for one voice run (${linesJson.length} of ${MAX_INPUT_CHARS} characters). Split the video in two parts.`);
    }
    const english = opts.language.toLowerCase().startsWith("en");
    const dispatchedAt = Date.now() - 15000;
    emit(0.01, "Sending the script to the voice runners...");
    const res = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      body: JSON.stringify({
        ref: process.env.VOICEBOX_GITHUB_REF || "main",
        inputs: { tag: opts.slug, lines: linesJson, language: opts.language, engine: english ? "chatterbox_turbo" : "chatterbox" },
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Could not start the voice run on ${repo} (${res.status}): ${body}. The GitHub token needs access to ${repo} (Actions: read and write).`);
    }
    for (let i = 0; i < 20 && !runId; i++) {
      await sleep(5000);
      const list = (await (await gh(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=5`)).json()) as any;
      const found = (list.workflow_runs || []).find((r: any) => new Date(r.created_at).getTime() >= dispatchedAt);
      if (found) runId = found.id;
    }
    if (!runId) throw new Error("The voice run was started, but GitHub did not list it within 100 s.");
    opts.onRun?.({ runId, repo });
    logger.info(`[voicebox] ${opts.lines.length} scenes -> run #${runId} on ${repo}`, "Voicebox");
  }

  const started = Date.now();
  for (;;) {
    if (opts.isCancelled?.()) throw new Error("cancelled");
    if (Date.now() - started > GIVE_UP_MS) throw new Error(`The voice run #${runId} took longer than ${GIVE_UP_MS / 3600000} hours`);
    const run = (await (await gh(`/actions/runs/${runId}`)).json()) as any;
    const jobs = ((await (await gh(`/actions/runs/${runId}/jobs?per_page=100`)).json()) as any).jobs || [];
    const speak = jobs.filter((j: any) => String(j.name).startsWith("speak"));
    const done = speak.filter((j: any) => j.status === "completed").length;
    if (speak.length) emit(0.05 + 0.9 * (done / speak.length), `Cloned voice: ${done}/${speak.length} runners finished`);
    else emit(0.03, "Planning the voice run...");
    if (run.status === "completed") {
      if (run.conclusion !== "success") throw new Error(`The voice run #${runId} ${run.conclusion}: https://github.com/${repo}/actions/runs/${runId}`);
      break;
    }
    await sleep(POLL_MS);
  }

  emit(0.96, "Downloading the narration...");
  const arts = (await (await gh(`/actions/runs/${runId}/artifacts`)).json()) as any;
  const artifact = (arts.artifacts || []).find((a: any) => a.name === `voicebox-${opts.slug}`);
  if (!artifact) throw new Error(`The voice run #${runId} finished without its audio artifact`);
  const dl = await fetchRetry(artifact.archive_download_url, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "shorts-automation" } });
  if (!dl.ok || !dl.body) throw new Error(`Could not download the narration (${dl.status})`);

  const dir = path.join(config.paths.outputDir, `voicebox-${opts.slug}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, "narration.zip");
  await pipeline(Readable.fromWeb(dl.body as any), fs.createWriteStream(zip));
  await unzip(zip, dir);
  fs.rmSync(zip, { force: true });

  const missing = opts.lines.filter((l) => !fs.existsSync(path.join(dir, `${l.name}.mp3`)));
  if (missing.length) {
    throw new Error(`The narration is missing ${missing.length} scene(s): ${missing.slice(0, 5).map((m) => m.name).join(", ")}`);
  }
  emit(1, "Narration ready");
  return { dir, files: opts.lines.length };
}
