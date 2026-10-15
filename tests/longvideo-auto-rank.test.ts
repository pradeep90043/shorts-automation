import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { pickSeed, rankCandidates, substanceScore, wordCount } from "../src/longvideo-auto/rank";
import { CandidateStore, istDateOf } from "../src/longvideo-auto/candidateStore";
import type { LongCandidate } from "../src/longvideo-auto/types";

const mk = (shortcode: string, o: Partial<LongCandidate> = {}): LongCandidate => ({
  channelKey: "codeorcap", shortcode, istDate: "2026-10-15", publishedAt: "2026-10-15T08:00:00.000Z",
  title: "How a hash map really works", text: Array(60).fill("word").join(" ") + ". Another sentence follows here.",
  playCount: 1000, likeCount: 100, commentCount: 10, viralScore: 50, ...o,
});

// IST day boundary: 18:30 UTC is already the next IST day
assert.strictEqual(istDateOf(Date.parse("2026-10-15T18:29:00Z")), "2026-10-15");
assert.strictEqual(istDateOf(Date.parse("2026-10-15T18:31:00Z")), "2026-10-16");

// substance: more words and a real title score higher; the same input always gives the same number
assert.ok(substanceScore(mk("a")) > substanceScore(mk("b", { text: "short thing" })));
assert.strictEqual(substanceScore(mk("a")), substanceScore(mk("a")));

// ranking: viral dominates, substance breaks near-ties, thin reels can never be the seed
const strongViralThin = mk("thin", { viralScore: 100, text: "too short" });
const solid = mk("solid", { viralScore: 70 });
const weak = mk("weak", { viralScore: 20 });
const ranked = rankCandidates([weak, strongViralThin, solid]);
assert.strictEqual(ranked[0].shortcode, "solid", "a reel with nothing to expand is not picked, however viral");
assert.strictEqual(ranked[ranked.length - 1].shortcode, "thin");
assert.strictEqual(pickSeed(ranked)!.seed.shortcode, "solid");
assert.strictEqual(pickSeed(ranked)!.fallback!.shortcode, "weak");

// the LLM judgement can reorder close calls; a missing judgement is neutral
const a = mk("a", { viralScore: 60 }), b = mk("b", { viralScore: 58 });
assert.strictEqual(rankCandidates([a, b])[0].shortcode, "a");
assert.strictEqual(rankCandidates([a, b], { a: 10, b: 95 })[0].shortcode, "b");

// used candidates are excluded; an empty day gives no seed
assert.strictEqual(rankCandidates([{ ...a, usedForLongAt: "x" }]).length, 0);
assert.strictEqual(pickSeed([]), null);
assert.strictEqual(wordCount("  one two  three "), 3);

// the store: idempotent record, per-channel/day lookup, used flag, and it survives a restart (new instance, same file)
const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "autolong-")), "c.json");
const s1 = new CandidateStore(f);
assert.strictEqual(s1.record(mk("x1")), true);
assert.strictEqual(s1.record(mk("x1")), false, "the same reel is recorded once");
s1.record(mk("y1", { channelKey: "storiyum" }));
assert.strictEqual(s1.forDay("codeorcap", "2026-10-15").length, 1);
assert.strictEqual(s1.forDay("storiyum", "2026-10-15").length, 1);
assert.strictEqual(s1.forDay("codeorcap", "2026-10-14").length, 0);
s1.markUsed("codeorcap", "x1");
const s2 = new CandidateStore(f);
assert.ok(s2.forDay("codeorcap", "2026-10-15")[0].usedForLongAt, "used flag persisted");
assert.strictEqual(s2.latestUnused("codeorcap", "2026-10-16").length, 0, "used reels are not offered again");

console.log("✓ longvideo-auto rank + candidate store");
