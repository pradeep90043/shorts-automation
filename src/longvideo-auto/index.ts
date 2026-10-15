import { pipelineLogger } from "../utils/logger";
import { CandidateStore, istDateOf } from "./candidateStore";
import { autoLongChannels, autoLongEnabled } from "./config";
import { checkScript } from "./guardrails";
import type { Ask } from "./llm";
import { LongQueue, planDay, runNext } from "./queue";
import { assignRelease } from "./release";
import { FetchText, researchTopic } from "./research";
import { writeLongScript } from "./scriptWriter";
import type { LongRequest } from "./types";

export const LONG_TARGET_SEC = 600;
/** about 134 spoken words per minute at the pace the cloned voices read Devanagari (2.4 words/s x 0.93 speech share) */
export const targetWordsFor = (sec: number): number => Math.round(sec * 2.4 * 0.93);

/** The slice of a stickman job this module reads. */
export interface JobView {
  id: string;
  status: "running" | "done" | "failed" | "cancelled";
  error?: string;
  remote?: { videoId: string; url: string; privacy: string };
}

export interface YoutubeLike {
  schedulePublish(videoId: string, publishAtIso: string): Promise<void>;
  updateSnippet(videoId: string, patch: { title?: string; description?: string; tags?: string[] }): Promise<void>;
}

export interface AutoLongDeps {
  store: CandidateStore;
  queue: LongQueue;
  ask: Ask;
  fetchText: FetchText;
  startJob(input: Record<string, unknown>): { id: string };
  getJob(id: string): JobView | undefined;
  isStickmanBusy(): boolean;
  isShortActive(): boolean;
  youtubeFor(channelKey: string): Promise<YoutubeLike | null>;
  brandName(channelKey: string): string;
  notify(text: string): Promise<void>;
  now(): number;
  pollMs?: number;
  jobTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The whole job for one request: research, script, guardrails, render + voice (existing engine), private upload, scheduled release. */
export async function produceLongVideo(
  req: LongRequest,
  useFallback: boolean,
  deps: AutoLongDeps,
): Promise<{ videoUrl?: string; jobId?: string; releaseAt?: string }> {
  const seed = useFallback && req.fallback ? req.fallback : req.seed;
  const brand = deps.brandName(req.channelKey);
  const log = (m: string) => pipelineLogger.info(`[AutoLong ${req.id}] ${m}`, "AutoLong");

  log(`researching "${seed.title}"`);
  const research = await researchTopic(seed.title, deps.fetchText);
  log(`${research.sources.length} source(s)`);

  const targetWords = targetWordsFor(LONG_TARGET_SEC);
  const pkg = await writeLongScript(
    { channelKey: req.channelKey, brandName: brand, topic: seed.title, seedText: seed.text, research: research.text, targetWords },
    deps.ask,
  );
  const guard = checkScript({
    channelKey: req.channelKey, script: pkg.script, title: pkg.title, description: pkg.description,
    sourceText: research.text + "\n" + seed.text, targetWords, tolerance: 0.1,
  });
  if (!guard.ok) throw new Error(`guardrails: ${guard.problems.join("; ")}`);
  log(`script ready: ${guard.words} words, ${pkg.droppedSentences} unsupported sentence(s) removed`);

  if (deps.isStickmanBusy()) throw new Error("the video engine became busy; will retry");
  const job = deps.startJob({
    script: pkg.script,
    title: pkg.title,
    voice: "voicebox",
    language: "hi",
    channelKey: req.channelKey,
    orientation: "horizontal",
    targetSec: LONG_TARGET_SEC,
    resolution: 1080,
  });
  deps.queue.update(req.id, { jobId: job.id });

  const deadline = deps.now() + (deps.jobTimeoutMs ?? 3 * 60 * 60 * 1000);
  let view: JobView | undefined;
  for (;;) {
    view = deps.getJob(job.id);
    if (view && view.status !== "running") break;
    if (deps.now() > deadline) throw new Error("the video did not finish within the time limit");
    await sleep(deps.pollMs ?? 20_000);
  }
  if (view.status !== "done") throw new Error(`video job ${view.status}: ${view.error ?? "no detail"}`);
  if (!view.remote?.videoId) throw new Error("the video was not uploaded by the runner, so it cannot be scheduled");

  const yt = await deps.youtubeFor(req.channelKey);
  if (!yt) throw new Error(`no YouTube channel connected for ${req.channelKey}`);

  const taken = new Set<string>();
  for (const r of deps.queue.all()) if (r.releaseAt && r.id !== req.id) {
    const d = istDateOf(Date.parse(r.releaseAt));
    const m = new Date(Date.parse(r.releaseAt) + 5.5 * 3600e3);
    taken.add(`${d}:${m.getUTCHours() * 60 + m.getUTCMinutes()}`);
  }
  const rel = assignRelease(req.channelKey, deps.now(), istDateOf(deps.now()), taken);
  const releaseAt = new Date(rel.atMs).toISOString();

  await yt.updateSnippet(view.remote.videoId, { title: pkg.title, description: pkg.description, tags: pkg.tags });
  await yt.schedulePublish(view.remote.videoId, releaseAt);
  deps.store.markUsed(req.channelKey, seed.shortcode);
  log(`scheduled for ${releaseAt}: ${view.remote.url}`);
  await deps.notify(`🎬 ${brand}: 10-min video ready\n${pkg.title}\nGoes public ${new Date(rel.atMs + 5.5 * 3600e3).toISOString().replace("T", " ").slice(0, 16)} IST\n${view.remote.url}`).catch(() => undefined);
  return { videoUrl: view.remote.url, jobId: job.id, releaseAt };
}

/**
 * Starts the nightly loop: at/after 00:00 IST it plans yesterday's seeds (idempotent), then works the queue one video at
 * a time whenever no Short is being processed. Off unless AUTO_LONG_VIDEO_ENABLED is set.
 */
export function startAutoLong(deps: AutoLongDeps, tickMs = 60_000): { stop(): void } {
  if (!autoLongEnabled()) {
    pipelineLogger.info("Daily long video is OFF (AUTO_LONG_VIDEO_ENABLED not set); Shorts are still recorded as candidates", "AutoLong");
    return { stop() {} };
  }
  const channels = autoLongChannels();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const nowIst = new Date(deps.now() + 5.5 * 3600e3);
      const hour = nowIst.getUTCHours();
      if (hour < 18) {
        // the day that just ended; also covers a box that was down at midnight (planning is idempotent)
        const yesterday = istDateOf(deps.now() - 24 * 3600e3);
        await planDay(deps.queue, yesterday, { store: deps.store, channels });
      }
      await runNext(
        deps.queue,
        {
          now: deps.now,
          isShortActive: deps.isShortActive,
          isLongBusy: deps.isStickmanBusy,
          produce: (req, useFallback) => produceLongVideo(req, useFallback, deps),
        },
        channels,
      );
    } catch (err) {
      pipelineLogger.warn(`AutoLong tick failed: ${err instanceof Error ? err.message : err}`, "AutoLong");
    } finally {
      busy = false;
    }
  }, tickMs);
  pipelineLogger.info(`Daily long video ON for: ${channels.join(", ")}`, "AutoLong");
  return { stop: () => clearInterval(timer) };
}
