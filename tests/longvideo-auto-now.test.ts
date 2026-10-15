import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { CandidateStore, istDateOf } from "../src/longvideo-auto/candidateStore";
import { AutoLongDeps, JobView, enqueueNow, produceLongVideo } from "../src/longvideo-auto/index";
import { LongQueue, longQueue } from "../src/longvideo-auto/queue";
import { wordsOf } from "../src/longvideo-auto/guardrails";
import type { LongCandidate } from "../src/longvideo-auto/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autolong-now-"));
const NOW = Date.parse("2026-10-15T17:00:00Z"); // 22:30 IST
const today = istDateOf(NOW);
const cand = (sc: string, o: Partial<LongCandidate> = {}): LongCandidate => ({
  channelKey: "prompt_gag", shortcode: sc, istDate: today, publishedAt: new Date(NOW).toISOString(),
  title: "Don't do these 3 SIP mistakes", text: Array(50).fill("word").join(" ") + ". Another sentence follows here.",
  playCount: 0, likeCount: 0, commentCount: 0, viralScore: 0, ...o,
});

(async () => {
  // one shared queue per process: the worker, the status route and the button see the same rows
  assert.strictEqual(longQueue(), longQueue());

  const store = new CandidateStore(path.join(dir, "c.json"));
  const queue = new LongQueue(path.join(dir, "q.json"));

  // nothing published yet today: refuses with a reason the dashboard can show
  const none = await enqueueNow(queue, store, "prompt_gag", { now: NOW });
  assert.strictEqual(none.ok, false);
  assert.ok(/no Short was published today/i.test((none as any).reason));
  queue.remove(`${today}:prompt_gag`); // the skipped marker would otherwise block, which force handles in the UI

  // after the Short is published: queued for TODAY (not yesterday), publishNow remembered
  store.record(cand("DVbceETguso"));
  const ok = await enqueueNow(queue, store, "prompt_gag", { now: NOW, publishNow: true });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(queue.get(`${today}:prompt_gag`)!.status, "queued");
  assert.strictEqual(queue.get(`${today}:prompt_gag`)!.publishNow, true);
  assert.strictEqual(queue.get(`${today}:prompt_gag`)!.seed.shortcode, "DVbceETguso");

  // a double click cannot make two videos
  const dup = await enqueueNow(queue, store, "prompt_gag", { now: NOW, publishNow: true });
  assert.strictEqual(dup.ok, false);
  assert.strictEqual((dup as any).status, "queued");

  // a finished one needs force; a failed one can be replaced
  queue.update(`${today}:prompt_gag`, { status: "done" });
  assert.strictEqual((await enqueueNow(queue, store, "prompt_gag", { now: NOW })).ok, false);
  queue.update(`${today}:prompt_gag`, { status: "failed", error: "[render] x" });
  assert.strictEqual((await enqueueNow(queue, store, "prompt_gag", { now: NOW })).ok, true, "a failed day is planned again");

  // a hand-picked reel must be one of today's published Shorts
  store.record(cand("OTHER", { title: "A second reel topic here" }));
  queue.update(`${today}:prompt_gag`, { status: "failed" });
  const pick = await enqueueNow(queue, store, "prompt_gag", { now: NOW, shortcode: "OTHER" });
  assert.strictEqual(pick.ok, true);
  assert.strictEqual(queue.get(`${today}:prompt_gag`)!.seed.shortcode, "OTHER");
  queue.update(`${today}:prompt_gag`, { status: "failed" });
  assert.strictEqual((await enqueueNow(queue, store, "prompt_gag", { now: NOW, shortcode: "NOPE" })).ok, false);

  // ---- publishNow makes the video public immediately and does NOT schedule it
  const sentence = "यह एक सरल वाक्य है जो विषय को आसान भाषा में समझाता है।";
  const chapter = Array(Math.round(167 / wordsOf(sentence))).fill(sentence).join(" ") + " यह वीडियो सिर्फ जानकारी के लिए है, यह वित्तीय सलाह नहीं है।";
  const calls: string[] = [];
  const mkDeps = (): AutoLongDeps => ({
    store, queue,
    ask: async (p) => (p.startsWith("You plan")
      ? JSON.stringify({ title: "SIP की तीन गलतियाँ", description: "विवरण।", tags: ["sip"], chapters: Array.from({ length: 8 }, (_, i) => ({ heading: `भाग ${i + 1}`, points: ["क", "ख"] })) })
      : chapter),
    fetchText: async () => { throw new Error("offline"); },
    startJob: () => ({ id: "job1" }),
    getJob: (): JobView => ({ id: "job1", status: "done", remote: { videoId: "vid1", url: "https://youtu.be/vid1", privacy: "private" } }),
    isStickmanBusy: () => false, isShortActive: () => false,
    youtubeFor: async () => ({
      setPrivacy: async (id, p) => { calls.push(`privacy:${id}:${p}`); },
      schedulePublish: async (id, at) => { calls.push(`schedule:${id}:${at}`); },
      updateSnippet: async (id, patch) => { calls.push(`snippet:${id}`); },
    }),
    brandName: () => "PromptGag", notify: async () => undefined, now: () => NOW, pollMs: 1,
  });

  queue.remove(`${today}:prompt_gag`);
  queue.enqueue({ id: `${today}:prompt_gag`, channelKey: "prompt_gag", istDate: today, seed: cand("DVbceETguso"), publishNow: true });
  const now = await produceLongVideo(queue.get(`${today}:prompt_gag`)!, false, mkDeps());
  assert.deepStrictEqual(calls, ["snippet:vid1", "privacy:vid1:public"]);
  assert.strictEqual(now.releaseAt, new Date(NOW).toISOString());

  // and a normal request still schedules (never public instantly)
  calls.length = 0;
  queue.remove(`${today}:prompt_gag`);
  queue.enqueue({ id: `${today}:prompt_gag`, channelKey: "prompt_gag", istDate: today, seed: cand("DVbceETguso") });
  await produceLongVideo(queue.get(`${today}:prompt_gag`)!, false, mkDeps());
  assert.strictEqual(calls[0], "snippet:vid1");
  assert.ok(calls[1].startsWith("schedule:vid1:"), calls[1]);
  assert.ok(!calls.some((c) => c.startsWith("privacy:")));

  console.log("✓ longvideo-auto make-now");
})().catch((e) => { console.error(e); process.exit(1); });
