import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { CandidateStore } from "../src/longvideo-auto/candidateStore";
import { AutoLongDeps, JobView, produceLongVideo, targetWordsFor } from "../src/longvideo-auto/index";
import { LongQueue } from "../src/longvideo-auto/queue";
import { wordsOf } from "../src/longvideo-auto/guardrails";
import type { LongCandidate } from "../src/longvideo-auto/types";

assert.strictEqual(targetWordsFor(300), 825);

const sentence = "यह एक सरल वाक्य है जो विषय को आसान भाषा में समझाता है।";
const chapter = Array(Math.round(167 / wordsOf(sentence))).fill(sentence).join(" ");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autolong-p-"));
const seed: LongCandidate = {
  channelKey: "codeorcap", shortcode: "abc", istDate: "2026-10-15", publishedAt: "2026-10-15T09:00:00Z",
  title: "स्प्रिंग बूट कैसे काम करता है", text: Array(40).fill("शब्द").join(" ") + ". और बातें।", playCount: 1, likeCount: 1, commentCount: 1, viralScore: 80,
};

(async () => {
  const store = new CandidateStore(path.join(dir, "c.json"));
  store.record(seed);
  const queue = new LongQueue(path.join(dir, "q.json"));
  queue.enqueue({ id: "2026-10-15:codeorcap", channelKey: "codeorcap", istDate: "2026-10-15", seed });
  const req = queue.get("2026-10-15:codeorcap")!;

  const events: string[] = [];
  let polls = 0;
  const now = Date.parse("2026-10-16T01:30:00Z"); // 07:00 IST on the 16th: the day's slots are still ahead
  const deps: AutoLongDeps = {
    store, queue,
    ask: async (p) => (p.startsWith("You plan")
      ? JSON.stringify({ title: "स्प्रिंग बूट की पूरी कहानी", description: "पूरा विवरण।", tags: ["java"], chapters: Array.from({ length: 8 }, (_, i) => ({ heading: `भाग ${i + 1}`, points: ["क", "ख"] })) })
      : chapter),
    fetchText: async () => { throw new Error("offline"); },
    startJob: (input) => { events.push(`start:${(input as any).voice}:${(input as any).language}:${(input as any).targetSec}:${(input as any).channelKey}`); return { id: "job1" }; },
    getJob: (): JobView => (++polls < 3 ? { id: "job1", status: "running" } : { id: "job1", status: "done", remote: { videoId: "vid1", url: "https://youtu.be/vid1", privacy: "private" } }),
    isStickmanBusy: () => false,
    isShortActive: () => false,
    youtubeFor: async () => ({
      updateSnippet: async (id, patch) => { events.push(`snippet:${id}:${patch.title}`); },
      schedulePublish: async (id, at) => { events.push(`schedule:${id}:${at}`); },
    }),
    brandName: () => "CodeOrCap",
    notify: async (t) => { events.push("notify"); },
    now: () => now,
    pollMs: 1,
  };

  const out = await produceLongVideo(req, false, deps);
  assert.strictEqual(out.videoUrl, "https://youtu.be/vid1");
  assert.strictEqual(out.releaseAt, "2026-10-16T13:07:00.000Z", "CodeOrCap's slot: 18:37 IST that evening");
  assert.deepStrictEqual(events, [
    "start:voicebox:hi:600:codeorcap",
    "snippet:vid1:स्प्रिंग बूट की पूरी कहानी",
    "schedule:vid1:2026-10-16T13:07:00.000Z",
    "notify",
  ]);
  assert.ok(store.forDay("codeorcap", "2026-10-15")[0].usedForLongAt, "the seed is marked used");
  assert.strictEqual(queue.get(req.id)!.jobId, "job1");

  // the guardrail is a hard stop: a script that fails never reaches the render
  const events2: string[] = [];
  const badAsk: AutoLongDeps = { ...deps, ask: async (p) => (p.startsWith("You plan") ? "x" : "कम शब्द।"), startJob: () => { events2.push("start"); return { id: "j" }; } };
  await assert.rejects(produceLongVideo(req, false, badAsk), /chapter|guardrails/);
  assert.deepStrictEqual(events2, []);

  // a failed render is an error for the queue to retry, not a silent success
  const failing: AutoLongDeps = { ...deps, getJob: () => ({ id: "job1", status: "failed", error: "render crashed" }) };
  await assert.rejects(produceLongVideo(req, false, failing), /render crashed/);
  // a render that was not uploaded by the runner cannot be scheduled
  const noRemote: AutoLongDeps = { ...deps, getJob: () => ({ id: "job1", status: "done" }) };
  await assert.rejects(produceLongVideo(req, false, noRemote), /cannot be scheduled/);

  console.log("✓ longvideo-auto produce");
})().catch((e) => { console.error(e); process.exit(1); });
