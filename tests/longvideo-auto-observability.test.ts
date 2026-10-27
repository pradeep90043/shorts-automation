import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { dailyLongEnabled } from "../src/longvideo-auto/config";
import { describeSwitch, isOffValue, switchOn } from "../src/utils/switches";
import { CandidateStore } from "../src/longvideo-auto/candidateStore";
import { LongQueue, runNext, WorkerDeps } from "../src/longvideo-auto/queue";
import { autoLongStatus, runStage, StageError } from "../src/longvideo-auto/status";
import { autoLongSnapshot, effectiveConfig } from "../src/longvideo-auto/index";
import type { LongCandidate } from "../src/longvideo-auto/types";

// ---- switches: on unless clearly off, whatever the spelling
for (const v of ["off", "OFF", "0", "false", "No", " disabled ", "none"]) assert.strictEqual(isOffValue(v), true, v);
for (const v of ["on", "1", "true", "yes", "anything", "all"]) assert.strictEqual(isOffValue(v), false, v);
assert.strictEqual(switchOn("X", {} as any), true, "unset = on");
assert.strictEqual(switchOn("X", { X: "" } as any), true, "empty = default");
assert.strictEqual(switchOn("X", { X: "off" } as any), false);
assert.strictEqual(switchOn("X", {} as any, false), false, "a switch can default to off");
assert.strictEqual(describeSwitch("X", { X: "off" } as any), "OFF (X=off)");
assert.strictEqual(describeSwitch("X", {} as any), "on (default)");

// the daily video has its own name; the legacy companion flag must not turn it on or off
assert.strictEqual(dailyLongEnabled({} as any), true);
assert.strictEqual(dailyLongEnabled({ DAILY_LONG_VIDEO: "off" } as any), false);
assert.strictEqual(dailyLongEnabled({ AUTO_LONG_VIDEO_ENABLED: "true" } as any), true, "unrelated: default stays on");
assert.strictEqual(dailyLongEnabled({ AUTO_LONG_VIDEO_ENABLED: "false" } as any), true, "unrelated: not a way to stop it");

// the effective config shows every switch and the slots
const cfg = effectiveConfig({} as any);
assert.strictEqual(cfg.shortsGridActive, true);
assert.strictEqual(cfg.dailyLongEnabled, true);
assert.deepStrictEqual(cfg.longReleaseIst, ["18:25", "19:15", "20:05", "20:55"]);
assert.strictEqual(cfg.shortSlotsIst.codeorcap.length, 4);
assert.ok(cfg.switches.INSIGHT_CLIP_CHANNELS.includes("codeorcap,storiyum,prompt_gag,infoonspot") || cfg.switches.INSIGHT_CLIP_CHANNELS.includes("codeorcap"));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autolong-o-"));

  // ---- a stage failure names the stage and is recorded as the last failure
  await assert.rejects(runStage("req1", "script", async () => { throw new Error("llm returned nothing"); }), (e: any) => {
    assert.ok(e instanceof StageError);
    assert.strictEqual(e.stage, "script");
    assert.strictEqual(e.message, "[script] llm returned nothing");
    return true;
  });
  assert.strictEqual(autoLongStatus.lastFailure?.stage, "script");
  assert.ok(autoLongStatus.events().some((e) => e.stage === "script" && e.message.startsWith("FAILED")));
  // an already-staged error is not wrapped twice
  await assert.rejects(runStage("req1", "outer", async () => { throw new StageError("inner", new Error("x")); }), /\[inner\] x$/);

  // ---- corrupt files are quarantined, never silently overwritten
  const qf = path.join(dir, "q.json");
  fs.writeFileSync(qf, "{ this is not json");
  const q = new LongQueue(qf);
  assert.deepStrictEqual(q.all(), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("q.json.corrupt-")), "the unreadable file was kept");
  const cf = path.join(dir, "c.json");
  fs.writeFileSync(cf, "garbage");
  new CandidateStore(cf);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("c.json.corrupt-")));

  // ---- a write failure does not throw out of the queue (memory stays right, the failure is logged)
  const unwritable = new LongQueue(path.join(dir, "no", "such", "dir", "x.json"));
  fs.writeFileSync(path.join(dir, "no"), "a file where a directory should be");
  const seed: LongCandidate = { channelKey: "codeorcap", shortcode: "s", istDate: "2026-10-15", publishedAt: "", title: "t t t", text: "x", playCount: 0, likeCount: 0, commentCount: 0, viralScore: 0 };
  assert.doesNotThrow(() => unwritable.enqueue({ id: "2026-10-15:codeorcap", channelKey: "codeorcap", istDate: "2026-10-15", seed }));
  assert.strictEqual(unwritable.get("2026-10-15:codeorcap")?.status, "queued");
  assert.ok(autoLongStatus.events().some((e) => e.stage === "store" && e.level === "error" && e.message.includes("could not write")));

  // ---- run results reach the alert hook: retry then failed carry the error text
  const qr = new LongQueue(path.join(dir, "r.json"));
  qr.enqueue({ id: "2026-10-15:codeorcap", channelKey: "codeorcap", istDate: "2026-10-15", seed });
  const seen: string[] = [];
  let t = 0;
  const deps: WorkerDeps = {
    now: () => t, isShortActive: () => false, isLongBusy: () => false, backoffMs: 1,
    produce: async () => { throw new StageError("render", new Error("runner crashed")); },
    onResult: (r, req, err) => { seen.push(`${r}:${req.channelKey}:${err}`); },
  };
  assert.strictEqual(await runNext(qr, deps, ["codeorcap"]), "retry");
  t += 10;
  assert.strictEqual(await runNext(qr, deps, ["codeorcap"]), "failed");
  assert.deepStrictEqual(seen, ["retry:codeorcap:[render] runner crashed", "failed:codeorcap:[render] runner crashed"]);
  assert.strictEqual(qr.get("2026-10-15:codeorcap")!.error, "[render] runner crashed");
  assert.ok(autoLongStatus.counters.failed >= 1 && autoLongStatus.counters.retried >= 1);

  // a broken alert hook must not break the queue
  const qh = new LongQueue(path.join(dir, "h.json"));
  qh.enqueue({ id: "2026-10-15:storiyum", channelKey: "storiyum", istDate: "2026-10-15", seed });
  const res = await runNext(qh, { ...deps, produce: async () => ({}), onResult: () => { throw new Error("telegram down"); } }, ["storiyum"]);
  assert.strictEqual(res, "done");

  // ---- the status snapshot is complete and serialisable
  const store = new CandidateStore(path.join(dir, "snap-c.json"));
  const snap = autoLongSnapshot(store, qr);
  assert.ok(snap.config && snap.service && Array.isArray(snap.queue) && Array.isArray(snap.events));
  assert.strictEqual(snap.queue[0].error, "[render] runner crashed");
  assert.doesNotThrow(() => JSON.stringify(snap));

  console.log("✓ longvideo-auto observability");
})().catch((e) => { console.error(e); process.exit(1); });
