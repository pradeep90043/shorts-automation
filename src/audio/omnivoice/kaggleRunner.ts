import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { config } from "../../config";
import { pipelineLogger as logger } from "../../utils/logger";
import type { VoiceboxLine, VoiceboxProgress } from "../../my-video/voiceboxNarration";
import type { OmniVoiceJob } from "./job";

/**
 * OmniVoice narration on a free Kaggle T4 (scripts/omnivoice_runner.py pushed as a private script kernel with the job embedded).
 * A kernel runs one version at a time and a new push cancels the running one, so jobs take turns on a few fixed "slot" kernels
 * (ov-slot-1..N, ov-dev-slot-* on the dev bot). The voice samples come from the private dataset <user>/voice-samples.
 */
const RUNNER = path.join(__dirname, "../../../scripts/omnivoice_runner.py");
const POLL_MS = 15000;
/** a COMPLETE seen this soon after a push can still be the slot's previous version */
const STALE_STATUS_MS = 90000;

export const kaggleUser = (env = process.env): string => env.KAGGLE_USERNAME || "spam2kaggle";
export const kaggleSlots = (env = process.env): string[] => {
  const n = Math.max(1, Math.min(4, Number(env.KAGGLE_SLOTS) || 2));
  const prefix = env.BOT_ENV === "dev" ? "ov-dev-slot" : "ov-slot";
  return Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);
};

/** The status word of `kaggle kernels status`: "...has status "KernelWorkerStatus.COMPLETE"" -> "complete". */
export function parseKernelStatus(out: string): string {
  const m = /status\s+"?(?:KernelWorkerStatus\.)?([A-Za-z_]+)"?\s*$/m.exec(out.trim());
  return m ? m[1].toLowerCase() : "unknown";
}

/** The runner with the job written into it, as Kaggle runs it. */
export function embedJob(runnerSource: string, job: OmniVoiceJob): string {
  const marker = "JOB_JSON = None";
  if (!runnerSource.includes(marker)) throw new Error("omnivoice_runner.py has no JOB_JSON marker");
  return runnerSource.replace(marker, `JOB_JSON = json.loads(${JSON.stringify(JSON.stringify(job))})`);
}

export function kernelMetadata(slug: string, env = process.env) {
  return {
    id: `${kaggleUser(env)}/${slug}`,
    title: slug,
    code_file: "runner.py",
    language: "python",
    kernel_type: "script",
    is_private: true,
    enable_gpu: true,
    enable_internet: true,
    machine_shape: "NvidiaTeslaT4",
    dataset_sources: [`${kaggleUser(env)}/voice-samples`],
    competition_sources: [],
    kernel_sources: [],
  };
}

function kaggle(args: string[], timeoutMs = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.KAGGLE_CLI || "kaggle", args, { env: process.env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("error", (err) => { clearTimeout(timer); reject(err); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`kaggle ${args.slice(0, 2).join(" ")} exited ${code}: ${out.trim().slice(-300)}`));
    });
  });
}

/** Slots in use by this process; a job waits for a free one. */
const busy = new Set<string>();
const waiters: (() => void)[] = [];

async function takeSlot(isCancelled?: () => boolean): Promise<string> {
  for (;;) {
    const free = kaggleSlots().find((s) => !busy.has(s));
    if (free) { busy.add(free); return free; }
    if (isCancelled?.()) throw new Error("cancelled");
    await new Promise<void>((r) => waiters.push(r));
  }
}

function releaseSlot(slot: string): void {
  busy.delete(slot);
  waiters.shift()?.();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface KaggleRunOptions {
  slug: string;
  job: OmniVoiceJob;
  lines: VoiceboxLine[];
  onProgress?: (p: VoiceboxProgress) => void;
  isCancelled?: () => boolean;
  giveUpMs?: number;
}

/** Speaks every line on Kaggle and returns the folder holding <name>.mp3 for each line. Throws on any failure (the caller falls back). */
export async function runOnKaggle(opts: KaggleRunOptions): Promise<{ dir: string; files: number }> {
  if (!process.env.KAGGLE_API_TOKEN && !fs.existsSync(path.join(os.homedir(), ".kaggle"))) throw new Error("No Kaggle credentials (KAGGLE_API_TOKEN)");
  const emit = (fraction: number, detail: string) => opts.onProgress?.({ fraction: Math.min(1, Math.max(0, fraction)), detail });
  emit(0.01, "Waiting for a free Kaggle GPU slot...");
  const slot = await takeSlot(opts.isCancelled);
  const kernel = `${kaggleUser()}/${slot}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ov-${slot}-`));
  try {
    fs.writeFileSync(path.join(tmp, "runner.py"), embedJob(fs.readFileSync(RUNNER, "utf8"), opts.job));
    fs.writeFileSync(path.join(tmp, "kernel-metadata.json"), JSON.stringify(kernelMetadata(slot), null, 1));
    emit(0.03, `Sending ${opts.lines.length} lines to Kaggle (${slot})...`);
    const pushed = await kaggle(["kernels", "push", "-p", tmp]);
    if (!/successfully pushed/i.test(pushed)) throw new Error(`Kaggle push failed: ${pushed.trim().slice(-300)}`);
    logger.info(`[omnivoice] ${opts.lines.length} lines -> Kaggle ${kernel} (${opts.slug})`, "OmniVoice");

    const started = Date.now();
    const giveUp = opts.giveUpMs ?? 45 * 60_000;
    let seenRunning = false;
    for (;;) {
      if (opts.isCancelled?.()) throw new Error("cancelled");
      if (Date.now() - started > giveUp) throw new Error(`Kaggle ${kernel} took longer than ${Math.round(giveUp / 60000)} minutes`);
      await sleep(POLL_MS);
      let status = "unknown";
      try {
        status = parseKernelStatus(await kaggle(["kernels", "status", kernel], 60000));
      } catch (err) {
        logger.warn(`[omnivoice] status of ${kernel}: ${err instanceof Error ? err.message : err}`, "OmniVoice");
        continue;
      }
      if (status === "running" || status === "queued") seenRunning = true;
      const fresh = seenRunning || Date.now() - started > STALE_STATUS_MS;
      if (!fresh) continue;
      if (status === "error" || status === "cancelacknowledged" || status === "cancelrequested") {
        throw new Error(`Kaggle ${kernel} ended with status ${status}: https://www.kaggle.com/code/${kernel}`);
      }
      if (status === "complete") break;
      // the runner speaks ~3-4x faster than real time on the T4; the bar is only a rough guide
      emit(0.05 + 0.85 * Math.min(1, (Date.now() - started) / (4 * 60_000 + opts.lines.length * 4000)), `OmniVoice on Kaggle (${status})...`);
    }

    emit(0.94, "Downloading the narration...");
    const dir = path.join(config.paths.outputDir, `omnivoice-${opts.slug}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await kaggle(["kernels", "output", kernel, "-p", dir], 10 * 60_000);
    const manifestFile = path.join(dir, "manifest.json");
    const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null;
    if (manifest?.tag !== opts.job.tag) throw new Error(`Kaggle ${kernel} returned another job's output (${manifest?.tag ?? "no manifest"})`);
    const missing = opts.lines.filter((l) => !fs.existsSync(path.join(dir, `${l.name}.mp3`)));
    if (missing.length) throw new Error(`The narration is missing ${missing.length} line(s): ${missing.slice(0, 5).map((m) => m.name).join(", ")}`);
    emit(1, "Narration ready");
    return { dir, files: opts.lines.length };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    releaseSlot(slot);
  }
}
