import { CandidateStore, istDateOf } from "./candidateStore";
import { describeSwitch } from "../utils/switches";
import { CHANNEL_ORDER, DEFAULT_GRID, gridFromEnv, hhmm, longReleaseSlots, shortSlots, shortsGridActive } from "../schedule/shortsGrid";
import { insightChannels } from "../my-video/insightClip";
import { autoLongChannels, dailyLongEnabled } from "./config";
import { checkScript } from "./guardrails";
import type { Ask } from "./llm";
import { LongQueue, planDay, runNext } from "./queue";
import { assignRelease } from "./release";
import { FetchText, researchTopic } from "./research";
import { writeLongScript } from "./scriptWriter";
import { autoLongStatus, runStage } from "./status";
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
  const note = (m: string) => autoLongStatus.log("info", "produce", m, req.id);
  note(`seed ${seed.shortcode} "${seed.title.slice(0, 70)}"${useFallback ? " (runner-up)" : ""}`);

  const research = await runStage(req.id, "research", async () => {
    const r = await researchTopic(seed.title, deps.fetchText);
    if (!r.sources.length) autoLongStatus.log("warn", "research", "no web sources found: the script will rest on the Short's own text only", req.id);
    else note(`${r.sources.length} source(s): ${r.sources.map((x) => new URL(x.url).hostname).join(", ")}`);
    return r;
  });

  const targetWords = targetWordsFor(LONG_TARGET_SEC);
  const pkg = await runStage(req.id, "script", () =>
    writeLongScript(
      { channelKey: req.channelKey, brandName: brand, topic: seed.title, seedText: seed.text, research: research.text, targetWords },
      deps.ask,
    ),
  );

  await runStage(req.id, "guardrails", async () => {
    const guard = checkScript({
      channelKey: req.channelKey, script: pkg.script, title: pkg.title, description: pkg.description,
      sourceText: research.text + "\n" + seed.text, targetWords, tolerance: 0.1,
    });
    note(`script ${guard.words} words (target ${targetWords}), ${pkg.droppedSentences} unsupported sentence(s) removed`);
    if (!guard.ok) throw new Error(`rejected: ${guard.problems.join("; ")}`);
  });

  const job = await runStage(req.id, "render-start", async () => {
    if (deps.isStickmanBusy()) throw new Error("the video engine became busy; will retry");
    const j = deps.startJob({
      script: pkg.script,
      title: pkg.title,
      voice: "voicebox",
      language: "hi",
      channelKey: req.channelKey,
      orientation: "horizontal",
      targetSec: LONG_TARGET_SEC,
      resolution: 1080,
    });
    deps.queue.update(req.id, { jobId: j.id });
    return j;
  });

  const view = await runStage(req.id, "render", async () => {
    const deadline = deps.now() + (deps.jobTimeoutMs ?? 3 * 60 * 60 * 1000);
    let v: JobView | undefined;
    let lastLogged = 0;
    for (;;) {
      v = deps.getJob(job.id);
      if (v && v.status !== "running") break;
      if (!v) throw new Error(`job ${job.id} disappeared (app restarted?)`);
      if (deps.now() > deadline) throw new Error("the video did not finish within the time limit");
      if (deps.now() - lastLogged > 10 * 60 * 1000) { // a line every 10 minutes: alive, not spam
        lastLogged = deps.now();
        note(`still rendering job ${job.id}`);
      }
      await sleep(deps.pollMs ?? 20_000);
    }
    if (v.status !== "done") throw new Error(`video job ${v.status}: ${v.error ?? "no detail"}`);
    if (!v.remote?.videoId) throw new Error("the video was not uploaded by the runner, so it cannot be scheduled");
    return v as JobView & { remote: NonNullable<JobView["remote"]> };
  });

  const releaseAt = await runStage(req.id, "release", async () => {
    const yt = await deps.youtubeFor(req.channelKey);
    if (!yt) throw new Error(`no YouTube channel connected for ${req.channelKey}`);
    const taken = new Set<string>();
    for (const r of deps.queue.all()) if (r.releaseAt && r.id !== req.id) {
      const ist = new Date(Date.parse(r.releaseAt) + 5.5 * 3600e3);
      taken.add(`${istDateOf(Date.parse(r.releaseAt))}:${ist.getUTCHours() * 60 + ist.getUTCMinutes()}`);
    }
    const rel = assignRelease(req.channelKey, deps.now(), istDateOf(deps.now()), taken);
    const at = new Date(rel.atMs).toISOString();
    // the title/description fix is cosmetic: if it fails the video is still scheduled (private -> public by YouTube)
    await yt.updateSnippet(view.remote.videoId, { title: pkg.title, description: pkg.description, tags: pkg.tags }).catch((e: unknown) => {
      autoLongStatus.log("warn", "release", `could not update title/description: ${e instanceof Error ? e.message : e}`, req.id);
    });
    await yt.schedulePublish(view.remote.videoId, at);
    deps.store.markUsed(req.channelKey, seed.shortcode);
    note(`scheduled ${view.remote.url} for ${at} (${hhmm(rel.minute)} IST)`);
    return at;
  });

  await deps.notify(
    `🎬 ${brand}: 10-min video ready\n${pkg.title}\nGoes public ${new Date(Date.parse(releaseAt) + 5.5 * 3600e3).toISOString().replace("T", " ").slice(0, 16)} IST\n${view.remote.url}`,
  ).catch((e: unknown) => autoLongStatus.log("warn", "alert", `notice failed: ${e instanceof Error ? e.message : e}`, req.id));
  return { videoUrl: view.remote.url, jobId: job.id, releaseAt };
}

/** What is switched on and when things happen: logged at startup and returned by the status endpoint. */
export function effectiveConfig(env: NodeJS.ProcessEnv = process.env) {
  const n = CHANNEL_ORDER.length;
  const cfg = gridFromEnv(env);
  return {
    switches: {
      SHORTS_GRID: describeSwitch("SHORTS_GRID", env),
      DAILY_LONG_VIDEO: describeSwitch("DAILY_LONG_VIDEO", env),
      INSIGHT_CLIP_CHANNELS: `${[...insightChannels(env)].join(",") || "OFF"} (${env.INSIGHT_CLIP_CHANNELS ?? "default"})`,
    },
    shortsGridActive: shortsGridActive(env),
    dailyLongEnabled: dailyLongEnabled(env),
    channels: autoLongChannels(env),
    shortSlotsIst: Object.fromEntries(CHANNEL_ORDER.map((c, i) => [c, shortSlots(i, n, cfg).map(hhmm)])),
    longReleaseIst: longReleaseSlots(n, n, 18 * 60, 21 * 60 + 30, cfg).map(hhmm),
    gridDefaults: { start: hhmm(DEFAULT_GRID.startMin), stepMin: DEFAULT_GRID.stepMin, perDay: DEFAULT_GRID.perDay },
  };
}

/**
 * Starts the nightly loop: from 00:00 IST it plans yesterday's seeds (idempotent), then works the queue one video at a
 * time whenever no Short is being processed. ON by default; DAILY_LONG_VIDEO=off stops it.
 * Every tick is wrapped: an error is logged with its stack and the next tick runs normally.
 */
export function startAutoLong(deps: AutoLongDeps, tickMs = 60_000): { stop(): void } {
  const cfg = effectiveConfig();
  autoLongStatus.log("info", "boot", `config ${JSON.stringify(cfg)}`);
  if (!dailyLongEnabled()) {
    autoLongStatus.log("warn", "boot", "daily long video is OFF (DAILY_LONG_VIDEO=off); Shorts are still recorded as candidates");
    return { stop() {} };
  }
  const channels = autoLongChannels();
  let busy = false;
  let ticks = 0;
  let lastState = "";
  autoLongStatus.log("info", "boot", `daily long video ON for ${channels.join(", ")}; release slots ${cfg.longReleaseIst.join(", ")} IST`);

  const alertFailure = async (result: string, req: LongRequest, error?: string) => {
    if (result !== "failed") return;
    await deps.notify(
      `❌ ${deps.brandName(req.channelKey)}: today's 10-min video FAILED after ${req.attempts + 1} attempt(s)\n${error ?? "unknown error"}\nrequest ${req.id}`,
    ).catch((e: unknown) => autoLongStatus.log("warn", "alert", `notice failed: ${e instanceof Error ? e.message : e}`, req.id));
  };

  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    ticks++;
    autoLongStatus.lastTickAt = new Date().toISOString();
    try {
      const nowIst = new Date(deps.now() + 5.5 * 3600e3);
      if (nowIst.getUTCHours() < 18) {
        // the day that just ended; also covers a box that was down at midnight (planning is idempotent)
        await planDay(deps.queue, istDateOf(deps.now() - 24 * 3600e3), { store: deps.store, channels });
      }
      const result = await runNext(
        deps.queue,
        {
          now: deps.now,
          isShortActive: deps.isShortActive,
          isLongBusy: deps.isStickmanBusy,
          produce: (req, useFallback) => produceLongVideo(req, useFallback, deps),
          onResult: (r, req, error) => alertFailure(r, req, error),
        },
        channels,
      );
      // log only changes (idle <-> blocked <-> working), plus one heartbeat an hour so silence is distinguishable from a hang
      const rows = deps.queue.all();
      const queued = rows.filter((r) => r.status === "queued").length;
      const state = `${result}|queued=${queued}`;
      if (state !== lastState) {
        lastState = state;
        autoLongStatus.log("info", "tick", `${result}; ${queued} queued, ${rows.filter((r) => r.status === "done").length} done, ${rows.filter((r) => r.status === "failed").length} failed`);
      } else if (ticks % 60 === 0) {
        autoLongStatus.log("info", "heartbeat", `alive: ${state}; Shorts-active=${deps.isShortActive()} engine-busy=${deps.isStickmanBusy()}`);
      }
    } catch (err) {
      autoLongStatus.counters.tickErrors++;
      autoLongStatus.error("tick", "tick failed", err);
    } finally {
      busy = false;
    }
  }, tickMs);
  return { stop: () => clearInterval(timer) };
}

/** Read-only view for GET /api/autolong/status: config, counters, the queue, today's candidates and the last events. */
export function autoLongSnapshot(store: CandidateStore, queue: LongQueue) {
  const today = istDateOf();
  const rows = queue.all();
  const channels = autoLongChannels();
  return {
    now: new Date().toISOString(),
    istDate: today,
    config: effectiveConfig(),
    service: {
      startedAt: autoLongStatus.startedAt,
      lastTickAt: autoLongStatus.lastTickAt,
      lastPlanAt: autoLongStatus.lastPlanAt,
      running: autoLongStatus.runningRequest ?? null,
      counters: autoLongStatus.counters,
      lastFailure: autoLongStatus.lastFailure ?? null,
    },
    candidatesToday: Object.fromEntries(channels.map((c) => [c, store.forDay(c, today).length])),
    queue: rows
      .sort((a, b) => b.istDate.localeCompare(a.istDate) || a.channelKey.localeCompare(b.channelKey))
      .slice(0, 30)
      .map((r) => ({
        id: r.id, channel: r.channelKey, status: r.status, attempts: r.attempts, error: r.error ?? null,
        seed: r.seed ? { shortcode: r.seed.shortcode, title: r.seed.title, viralScore: r.seed.viralScore } : null,
        videoUrl: r.videoUrl ?? null, releaseAt: r.releaseAt ?? null, startedAt: r.startedAt ?? null, finishedAt: r.finishedAt ?? null,
      })),
    events: autoLongStatus.events(60),
  };
}
