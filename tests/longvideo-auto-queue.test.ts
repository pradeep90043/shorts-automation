import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { CandidateStore } from "../src/longvideo-auto/candidateStore";
import { LongQueue, planDay, runNext, WorkerDeps } from "../src/longvideo-auto/queue";
import type { LongCandidate } from "../src/longvideo-auto/types";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "autolong-q-"));
const cand = (channelKey: string, shortcode: string, o: Partial<LongCandidate> = {}): LongCandidate => ({
  channelKey, shortcode, istDate: "2026-10-15", publishedAt: "2026-10-15T10:00:00Z", title: "A clear topic title here",
  text: Array(60).fill("word").join(" ") + ". More to say here.", playCount: 1, likeCount: 1, commentCount: 1, viralScore: 40, ...o,
});

(async () => {
  const dir = tmp();
  const store = new CandidateStore(path.join(dir, "c.json"));
  store.record(cand("codeorcap", "a1", { viralScore: 90 }));
  store.record(cand("codeorcap", "a2", { viralScore: 30 }));
  store.record(cand("storiyum", "s1"));
  store.record(cand("infoonspot", "i1", { text: "too thin" })); // nothing to expand
  // prompt_gag published nothing today and has no history -> skipped

  const queue = new LongQueue(path.join(dir, "q.json"));
  const channels = ["codeorcap", "storiyum", "prompt_gag", "infoonspot"];
  const planned = await planDay(queue, "2026-10-15", { store, channels });
  assert.deepStrictEqual(planned.queued, ["codeorcap", "storiyum"]);
  assert.deepStrictEqual(planned.skipped.sort(), ["infoonspot", "prompt_gag"]);
  assert.strictEqual(queue.get("2026-10-15:codeorcap")!.seed.shortcode, "a1", "the most viral substantial reel is the seed");
  assert.strictEqual(queue.get("2026-10-15:codeorcap")!.fallback!.shortcode, "a2");

  // planning twice, or after a restart, adds nothing: one request per channel per day
  const again = await planDay(new LongQueue(path.join(dir, "q.json")), "2026-10-15", { store, channels });
  assert.deepStrictEqual(again, { queued: [], skipped: [] });

  // a channel with no reels today uses its latest unused candidate from the last days
  const store2 = new CandidateStore(path.join(dir, "c2.json"));
  store2.record(cand("prompt_gag", "p1", { istDate: "2026-10-14" }));
  const q2 = new LongQueue(path.join(dir, "q2.json"));
  assert.deepStrictEqual((await planDay(q2, "2026-10-15", { store: store2, channels: ["prompt_gag"] })).queued, ["prompt_gag"]);

  // ---- the worker: Shorts first, one at a time, channel order, retry then fail
  let t = 1_000_000;
  let shortActive = true, longBusy = false;
  const produced: string[] = [];
  let failNext = 0;
  const deps: WorkerDeps = {
    now: () => t,
    isShortActive: () => shortActive,
    isLongBusy: () => longBusy,
    produce: async (req, useFallback) => {
      if (failNext > 0) { failNext--; throw new Error("llm timeout"); }
      produced.push(`${req.channelKey}${useFallback ? "(fallback)" : ""}`);
      return { videoUrl: `https://youtu.be/${req.channelKey}`, releaseAt: "2026-10-16T12:55:00.000Z" };
    },
    backoffMs: 60_000,
  };

  assert.strictEqual(await runNext(queue, deps, channels), "blocked", "a Short is being processed: nothing starts");
  shortActive = false; longBusy = true;
  assert.strictEqual(await runNext(queue, deps, channels), "blocked", "a video is already rendering: nothing starts");
  longBusy = false;

  assert.strictEqual(await runNext(queue, deps, channels), "done");
  assert.strictEqual(await runNext(queue, deps, channels), "done");
  assert.deepStrictEqual(produced, ["codeorcap", "storiyum"], "channel order, one per call");
  assert.strictEqual(await runNext(queue, deps, channels), "idle");
  assert.strictEqual(queue.get("2026-10-15:codeorcap")!.status, "done");
  assert.strictEqual(queue.get("2026-10-15:codeorcap")!.videoUrl, "https://youtu.be/codeorcap");

  // failure: retried after a backoff with the runner-up reel, then given up on (never stacked)
  const q3 = new LongQueue(path.join(dir, "q3.json"));
  await planDay(q3, "2026-10-15", { store, channels: ["codeorcap"] });
  failNext = 5;
  assert.strictEqual(await runNext(q3, deps, ["codeorcap"]), "retry");
  assert.strictEqual(await runNext(q3, deps, ["codeorcap"]), "idle", "still backing off");
  t += 61_000;
  assert.strictEqual(await runNext(q3, deps, ["codeorcap"]), "failed");
  assert.strictEqual(q3.get("2026-10-15:codeorcap")!.status, "failed");
  assert.strictEqual(q3.get("2026-10-15:codeorcap")!.attempts, 2);

  // a restart mid-run puts the request back instead of losing it
  const q4 = new LongQueue(path.join(dir, "q4.json"));
  q4.enqueue({ id: "2026-10-15:x", channelKey: "codeorcap", istDate: "2026-10-15", seed: cand("codeorcap", "z") });
  q4.update("2026-10-15:x", { status: "running" });
  assert.strictEqual(new LongQueue(path.join(dir, "q4.json")).get("2026-10-15:x")!.status, "queued");

  console.log("✓ longvideo-auto queue");
})().catch((e) => { console.error(e); process.exit(1); });
