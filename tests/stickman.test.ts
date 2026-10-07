// tests/stickman.test.ts - pure logic of the my-video long video planner/estimator
import assert from "assert";
import { cleanScript, countWords, sanitizeVisual, splitScriptIntoBeats } from "../src/my-video/stickmanPlanner";
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

// timing labels / markdown pasted from script docs are never spoken
const messy = "**Hook — 0–5 sec**\n\n“Java vs Node.js vs Python… kya choose karein?”\n\n**5–12 sec — Java**\n\nJava enterprise ka heavyweight hai.";
const cleaned = cleanScript(messy);
assert.ok(!/sec|\*|“/.test(cleaned), `labels stripped: ${cleaned}`);
assert.ok(cleaned.includes("Java vs Node.js vs Python"));

// a script far from the target is planned for an automatic rewrite; a near one only tunes the voice rate
const fit = estimateStickman(script, 120);
assert.ok(fit.fitToWords && fit.fitToWords > countWords(script), "short script gets expanded");
assert.strictEqual(fit.videoSec, 120);
const near = estimateStickman(script, Math.round(countWords(script) / 2.4 / 0.93));
assert.strictEqual(near.fitToWords, undefined);
assert.ok(estimateStickman(script, 120, 1080).stageSec.render > estimateStickman(script, 120, 720).stageSec.render, "1080p renders slower");

console.log("✓ stickman planner/estimator");
