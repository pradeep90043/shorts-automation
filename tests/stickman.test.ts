// tests/stickman.test.ts - pure logic of the my-video long video planner/estimator
import assert from "assert";
import { countWords, sanitizeVisual, splitScriptIntoBeats } from "../src/my-video/stickmanPlanner";
import { estimateStickman } from "../src/my-video/stickmanEstimate";

const script =
  "Kya aapko pata hai ki Spring Boot mein dependency injection kya hota hai? Simple bhasha mein samjhte hain. " +
  "Jab ek class ko doosri class ki zaroorat hoti hai, toh hum use khud nahi banate, Spring container banata hai aur hume de deta hai.";

// narration is never rewritten, only split
const beats = splitScriptIntoBeats(script);
assert.strictEqual(beats.join(" "), script, "beats must reassemble to the original script");
assert.ok(beats.every((b) => countWords(b) <= 20), "beats stay short");
assert.deepStrictEqual(splitScriptIntoBeats("   \n "), []);

// LLM output is clamped to values my-video's schema accepts
const v = sanitizeVisual({ pose: "moonwalk", mood: "happy", props: [{ type: "laptop" }, { type: "ufo" }], title: "x".repeat(200) }, 0);
assert.notStrictEqual(v.pose, "moonwalk");
assert.strictEqual(v.mood, "happy");
assert.strictEqual((v.props as unknown[]).length, 1);
assert.strictEqual((v.title as string).length, 60);

// a target length picks a TTS rate that lands near it, and flags impossible targets
const e = estimateStickman(script, 30);
assert.ok(Math.abs(e.videoSec - 30) < 6, `video length ${e.videoSec} should be near 30s`);
assert.ok(e.totalSec > e.videoSec * 0.5 && Object.keys(e.stageSec).length === 6);
assert.ok(estimateStickman(script, 3).note, "unreachable target gets a warning");
assert.ok(estimateStickman(script, 30, 1080).stageSec.render > estimateStickman(script, 30, 720).stageSec.render, "1080p renders slower");

console.log("✓ stickman planner/estimator");
