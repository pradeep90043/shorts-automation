// tests/stickman.test.ts - pure logic of the my-video long video planner/estimator
import assert from "assert";
import { cleanScript, countWords, diversifyVisuals, sanitizeVisual, splitScriptIntoBeats } from "../src/my-video/stickmanPlanner";
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

// panels from the LLM are clamped to my-video's limits; only one panel and no props alongside it
const code = sanitizeVisual({
  props: [{ type: "laptop" }],
  code: { title: "T".repeat(90), lines: ["@GetMapping(\"/users\")", "x".repeat(200), "}"], highlight: [1, 9, -1] },
  steps: { items: ["a", "b"], current: 1 },
}, 0) as any;
assert.ok(code.code && !code.steps, "code wins, only one panel");
assert.strictEqual(code.props, undefined, "no props next to a panel");
assert.strictEqual(code.code.title.length, 40);
assert.ok(code.code.lines.every((l: string) => l.length <= 56));
assert.deepStrictEqual(code.code.highlight, [1], "out-of-range highlight lines dropped");
const steps = sanitizeVisual({ steps: { items: ["Core Java", "Spring Boot", "DB"], current: 99 } }, 1) as any;
assert.strictEqual(steps.steps.current, 2, "current clamped into range");
assert.strictEqual((sanitizeVisual({ steps: { items: ["only one"] } }, 1) as any).steps, undefined, "needs 2+ steps");
assert.strictEqual((sanitizeVisual({ quiz: { question: "q?", options: ["a", "b"], answer: 5 } }, 1) as any).quiz, undefined, "bad quiz answer dropped");
assert.strictEqual((sanitizeVisual({ hideFigure: true, steps: { items: ["a", "b"] } }, 1) as any).hideFigure, undefined);

// variety: no pose three times in a row, no camera move twice in a row
const flat = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, text: "x", visual: { pose: "idle", camera: "push" } }));
diversifyVisuals(flat);
for (let i = 2; i < flat.length; i++) {
  const p = flat.slice(i - 2, i + 1).map((s) => (s.visual as any).pose);
  assert.ok(!(p[0] === p[1] && p[1] === p[2]), "three identical poses in a row");
}
assert.ok(flat.slice(1).every((s, i) => (s.visual as any).camera !== (flat[i].visual as any).camera || (s.visual as any).camera === "none"));

// every sanitized visual must satisfy the real renderer schema (skipped when zod / my-video are not installed)
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { StickmanVisualSchema } = require("../my-video/src/stickman/schema");
  for (const raw of [code, steps, sanitizeVisual({ quiz: { question: "q?", options: ["a", "b"], answer: 1 } }, 2), sanitizeVisual({ container: { label: "Spring", beans: ["A"] } }, 3), sanitizeVisual({}, 4)]) {
    const r = StickmanVisualSchema.safeParse(raw);
    assert.ok(r.success, `schema rejected a sanitized visual: ${JSON.stringify(r.error?.issues)}`);
  }
} catch (e: any) {
  if (e?.code !== "MODULE_NOT_FOUND") throw e;
  console.log("  (renderer schema check skipped: my-video/zod not available)");
}

console.log("✓ stickman planner/estimator");
