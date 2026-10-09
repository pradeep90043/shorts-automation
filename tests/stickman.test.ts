// tests/stickman.test.ts - pure logic of the my-video long video planner/estimator
import assert from "assert";
import { cleanScript, countWords, diversifyVisuals, dropInventedNumbers, scriptNumbers, sanitizeVisual, splitScriptIntoBeats } from "../src/my-video/stickmanPlanner";
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

// plan-only: narration is never rewritten, speech time follows the characters (0.0827 s each at the default rate)
const poNatural = Math.round(script.length * 0.0827);
const po = estimateStickman(script, poNatural, 1080, false, true);
assert.strictEqual(po.fitToWords, undefined, "plan-only never plans a rewrite");
assert.ok(Math.abs(parseInt(po.rate) - 5) <= 4, `rate near the default at the natural length: ${po.rate}`);
assert.ok(Math.abs(po.videoSec - poNatural) < poNatural * 0.1, `length follows the characters: ${po.videoSec} vs ${poNatural}`);
assert.ok(estimateStickman(script, poNatural * 2, 1080, false, true).videoSec > poNatural * 1.15, "a longer target slows the voice (down to the -20% limit)");
assert.ok(po.stageSec.plan < 10, "plan-only has no planning stage to wait for");

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

// the new panels are clamped / validated the same way
const flow = sanitizeVisual({ callouts: ["X"], flow: { nodes: ["Controller", "Service", "Repository", "Database"], active: 9, packet: "GET /users" } }, 0) as any;
assert.strictEqual(flow.flow.active, undefined, "bad active index dropped");
assert.strictEqual(flow.callouts, undefined, "no callouts on a panel beat");
assert.deepStrictEqual(Object.keys(sanitizeVisual({ chart: { labels: ["a", "b"], values: [1] } }, 0)).includes("chart"), false, "chart needs matching labels/values");
const chart = sanitizeVisual({ chart: { kind: "line", labels: ["a", "b", "c"], values: [1, 2, 3], highlight: 7 } }, 0) as any;
assert.strictEqual(chart.chart.highlight, undefined);
assert.strictEqual((sanitizeVisual({ table: { columns: ["id", "name"], rows: [["1"], ["2", "x"]] } }, 0) as any).table.rows.length, 1, "ragged table rows dropped");
assert.strictEqual((sanitizeVisual({ alert: { kind: "boom", title: "x" } }, 0) as any).alert, undefined);
// news clipping panel: kept with trimmed fields; dropped without outlet or headline
const newsV = sanitizeVisual({ news: { outlet: "Reuters", date: "Oct 8, 2026", headline: "US halts green card applications", mark: "halts", stamp: "Alleged" } }, 0) as any;
assert.strictEqual(newsV.news.outlet, "Reuters");
assert.strictEqual(newsV.news.stamp, "Alleged");
assert.strictEqual((sanitizeVisual({ news: { outlet: "Reuters" } }, 0) as any).news, undefined);
assert.ok((sanitizeVisual({ compare: { cards: [{ title: "A", points: ["1", "2", "3", "4", "5"], winner: true }, { title: "B" }] } }, 0) as any).compare.cards[0].points.length === 4);
assert.ok((sanitizeVisual({ counter: { items: [{ value: 6, suffix: " mo", label: "FRESHER" }, { value: "x", label: "bad" }] } }, 0) as any).counter.items.length === 1);
assert.ok((sanitizeVisual({ terminal: { lines: ["$ ls", "", "ok"] } }, 0) as any).terminal.lines.length === 2);
assert.ok((sanitizeVisual({ browser: { url: "a.com", kind: "json", lines: ["{", "}"] } }, 0) as any).browser.kind === "json");
assert.ok((sanitizeVisual({ progress: { items: [{ label: "x", value: 400 }] } }, 0) as any).progress.items[0].value === 100);

// svg panel: a validated shape language, unreadable drawings are rejected
const goodSvg = {
  title: "Inheritance",
  shapes: [
    { t: "rect", x: 500, y: 70, w: 300, h: 100, rx: 22, fill: "accent", stroke: "ink", step: 0 },
    { t: "text", x: 650, y: 132, text: "Animal", size: 44, fill: "white", step: 0 },
    { t: "line", x1: 650, y1: 170, x2: 340, y2: 330, arrow: true, step: 1 },
    { t: "text", x: 340, y: 400, text: "Dog", size: 44 },
    { t: "script", src: "alert(1)" },
    { t: "path", d: "M0 0 L10 10 <script>", fill: "red" },
    { t: "circle", cx: "x", cy: 1, r: 5 },
  ],
};
const svgV = sanitizeVisual({ svg: goodSvg, callouts: ["X"], props: [{ type: "laptop" }] }, 0) as any;
assert.strictEqual(svgV.svg.shapes.length, 4, "unknown / unsafe / non-numeric shapes dropped");
assert.strictEqual(svgV.callouts, undefined);
assert.strictEqual(svgV.svg.shapes[3].anchor, "middle", "text defaults filled in");
assert.strictEqual((sanitizeVisual({ svg: { shapes: [{ t: "rect", x: 0, y: 0, w: 5, h: 5 }] } }, 0) as any).svg, undefined, "needs 2+ valid shapes");
const offCanvas = { shapes: [{ t: "rect", x: 10, y: 10, w: 100, h: 50 }, { t: "text", x: 1290, y: 100, text: "Way too long to fit here", size: 60 }] };
assert.strictEqual((sanitizeVisual({ svg: offCanvas }, 0) as any).svg, undefined, "text hanging off the panel rejects the drawing");
assert.strictEqual((sanitizeVisual({ svg: offCanvas }, 0) as any).steps, undefined, "a single label cannot become a step list");
const stacked = { shapes: [{ t: "text", x: 600, y: 300, text: "Spring Boot", size: 50 }, { t: "text", x: 620, y: 310, text: "Hibernate", size: 50 }] };
assert.strictEqual((sanitizeVisual({ svg: stacked }, 0) as any).svg, undefined, "overlapping texts reject the drawing");
assert.ok((sanitizeVisual({ svg: { shapes: [{ t: "rect", x: 0, y: 0, w: 5, h: 5, fill: "javascript:x" }, { t: "circle", cx: 5, cy: 5, r: 9999 }] } }, 0) as any).svg.shapes[0].fill === undefined, "unknown colours dropped");

// a drawing with a line through a box is rejected, but its labels survive as a step list
const crossing = { shapes: [
  { t: "rect", x: 450, y: 50, w: 400, h: 120, fill: "accent" }, { t: "text", x: 650, y: 112, text: "Animal", size: 48 },
  { t: "rect", x: 450, y: 200, w: 400, h: 120, fill: "blue" }, { t: "text", x: 650, y: 262, text: "Dog", size: 48 },
  { t: "line", x1: 650, y1: 170, x2: 650, y2: 350, arrow: true },
] };
const crossed = sanitizeVisual({ svg: crossing }, 0) as any;
assert.strictEqual(crossed.svg, undefined, "line through a box rejects the drawing");
assert.deepStrictEqual(crossed.steps.items, ["Animal", "Dog"], "labels become steps, top to bottom");
const overlapBoxes = { shapes: [{ t: "rect", x: 100, y: 100, w: 300, h: 100 }, { t: "rect", x: 150, y: 120, w: 300, h: 100 }, { t: "text", x: 250, y: 150, text: "A", size: 40 }, { t: "text", x: 300, y: 400, text: "B", size: 40 }] };
assert.ok(!(sanitizeVisual({ svg: overlapBoxes }, 0) as any).svg, "overlapping boxes rejected");
const grid = { shapes: [
  { t: "rect", x: 500, y: 60, w: 300, h: 100, fill: "accent" }, { t: "text", x: 650, y: 126, text: "Animal", size: 44, fill: "white" },
  { t: "line", x1: 600, y1: 160, x2: 300, y2: 250, arrow: true },
  { t: "rect", x: 100, y: 250, w: 300, h: 100, fill: "green" }, { t: "text", x: 250, y: 316, text: "Dog", size: 44, fill: "white" },
] };
assert.ok((sanitizeVisual({ svg: grid }, 0) as any).svg, "a clean grid drawing passes");
// containers (big background rect with shapes inside) are fine
const matrixLike = { shapes: [{ t: "rect", x: 50, y: 50, w: 1200, h: 600 }, { t: "line", x1: 650, y1: 60, x2: 650, y2: 640 }, { t: "text", x: 350, y: 300, text: "Do first", size: 44 }, { t: "text", x: 950, y: 300, text: "Plan it", size: 44 }] };
assert.ok((sanitizeVisual({ svg: matrixLike }, 0) as any).svg, "axes inside a container rect are allowed");
// no hand-drawn diagram on two beats in a row
const two = [{ id: "a", text: "x", visual: { pose: "idle", camera: "none", svg: { shapes: [] } } }, { id: "b", text: "y", visual: { pose: "idle", camera: "none", svg: { shapes: [] } } }];
diversifyVisuals(two);
assert.ok(two[0].visual.svg && !(two[1].visual as any).svg);

// numbers shown as facts must come from the script
const nums = scriptNumbers("A fresher needs three to six months. Backend takes 6 to 10 weeks. About 1,200 words.");
assert.ok([3, 6, 10, 1200].every((n) => nums.has(n)) && !nums.has(5));
const numScenes: any[] = [
  { id: "a", text: "x", visual: { chart: { labels: ["a", "b"], values: [3, 6] } } },
  { id: "b", text: "y", visual: { chart: { labels: ["a", "b"], values: [3, 5] } } },
  { id: "c", text: "z", visual: { counter: { items: [{ value: 42, label: "L" }] }, steps: undefined } },
  { id: "d", text: "w", visual: { progress: { items: [{ label: "x", value: 6 }] } } },
];
assert.strictEqual(dropInventedNumbers(numScenes, "three to six months, 10 weeks"), 2);
assert.ok(numScenes[0].visual.chart && !numScenes[1].visual.chart && !numScenes[2].visual.counter && numScenes[3].visual.progress);

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
  for (const raw of [svgV, flow, chart, sanitizeVisual({ compare: { cards: [{ title: "A" }, { title: "B", winner: true }] } }, 1), sanitizeVisual({ table: { columns: ["a", "b"], rows: [["1", "2"]] } }, 1), sanitizeVisual({ alert: { kind: "error", title: "x" } }, 1), sanitizeVisual({ browser: { url: "u", lines: ["l"] } }, 1), sanitizeVisual({ terminal: { lines: ["$ x"] } }, 1), sanitizeVisual({ progress: { items: [{ label: "a", value: 5 }] } }, 1), sanitizeVisual({ counter: { items: [{ value: 3, label: "L" }] } }, 1), code, steps, sanitizeVisual({ quiz: { question: "q?", options: ["a", "b"], answer: 1 } }, 2), sanitizeVisual({ container: { label: "Spring", beans: ["A"] } }, 3), sanitizeVisual({}, 4)]) {
    const r = StickmanVisualSchema.safeParse(raw);
    assert.ok(r.success, `schema rejected a sanitized visual: ${JSON.stringify(r.error?.issues)}`);
  }
} catch (e: any) {
  if (e?.code !== "MODULE_NOT_FOUND") throw e;
  console.log("  (renderer schema check skipped: my-video/zod not available)");
}

console.log("✓ stickman planner/estimator");
