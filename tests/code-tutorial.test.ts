import assert from "assert";
import fs from "fs";
import path from "path";
import { lessonQualityReport, looksLikeCodingLesson } from "../src/my-video/lessonQuality";
import {
  buildDirectorPrompt, buildPlanOnlyPrompt, checkPlanOnly, normalizeSceneShape, parsePlanText, planFromPlanOnly, sanitizeCode, sanitizeVisual, wrapCodeLine,
} from "../src/my-video/stickmanPlanner";

// ── 1. code panels: wrapped not cut, up to 14 lines, language, highlights follow the lines ──
const long = '    @Value("${payment.gateway.type:Razorpay}") private String paymentGatewayType;';
const wrapped = wrapCodeLine(long);
assert.ok(wrapped.length >= 2 && wrapped.every((l) => l.length <= 56), "long line wrapped within 56 chars");
assert.ok(wrapped[1].startsWith("        "), "continuation is indented 4 more spaces");
assert.strictEqual(wrapped.map((l) => l.trim()).join(" ").replace(/\s+/g, " "), long.trim().replace(/\s+/g, " "), "no characters lost");
assert.deepStrictEqual(wrapCodeLine("short"), ["short"]);

const code = sanitizeCode({
  filename: "PaymentGateway.java",
  lines: ["@Component", "public class PaymentGateway {", long, "    private int retryCount;", "}"],
  highlightLines: [3], // 1-based alias: the 3rd line, which wraps to two
  revealFrom: 3,
  animate: "type",
}) as any;
assert.strictEqual(code.title, "PaymentGateway.java");
assert.strictEqual(code.language, "java");
assert.strictEqual(code.animate, "type");
assert.ok(code.lines.length > 5, "wrapped lines add rows");
assert.strictEqual(code.lines[code.highlight[0]].trim().startsWith("@Value"), true, "highlight still points at the @Value line");
assert.strictEqual(code.lines[code.revealFrom].trim(), "private int retryCount;", "revealFrom still points at the first new line");
assert.strictEqual((sanitizeCode({ title: "application.properties", lines: ["a=1"] }) as any).language, "properties");
assert.strictEqual((sanitizeCode({ title: "application.yml", lines: ["a: 1"] }) as any).language, "yaml");
assert.strictEqual((sanitizeCode({ title: "pom.xml", lines: ["<a/>"] }) as any).language, "xml");
assert.strictEqual((sanitizeCode({ lines: ["x"], language: "cobol" }) as any).language, "java");
assert.strictEqual((sanitizeCode({ lines: Array.from({ length: 20 }, (_, i) => `line ${i}`) }) as any).lines.length, 14);
assert.strictEqual((sanitizeCode({ lines: "a\nb\nc" }) as any).lines.length, 3, "a string of lines is split");
assert.strictEqual(sanitizeCode({ lines: ["", "  "] }), null);
// blank lines inside code are kept (they separate members), trailing blanks dropped
assert.deepStrictEqual((sanitizeCode({ lines: ["a", "", "b", "", ""] }) as any).lines, ["a", "", "b"]);
// the visual sanitiser keeps all of it
const v = sanitizeVisual({ code: { title: "x.properties", lines: ["k=v"], animate: "type", highlight: [0] } }, 0) as any;
assert.deepStrictEqual([v.code.language, v.code.animate, v.code.highlight], ["properties", "type", [0]]);

// ── 2. other models' panel shape is converted, not dropped ──
const converted = normalizeSceneShape({
  i: 3, text: "t",
  panel: { type: "code", language: "properties", filename: "application.properties", lines: ["payment.gateway.type=Paytm"], highlightLines: [1], animate: "type" },
});
assert.ok(!converted.panel && converted.code.title === "application.properties");
assert.deepStrictEqual((sanitizeCode(converted.code) as any).highlight, [0]);
const term = sanitizeVisual(normalizeSceneShape({ panel: { type: "terminal", command: "mvn spring-boot:run", output: ["Paytm", "5", "true", "3000"] } }), 0) as any;
assert.deepStrictEqual(term.terminal.lines, ["$ mvn spring-boot:run", "Paytm", "5", "true", "3000"]);
assert.deepStrictEqual(normalizeSceneShape({ panel: { type: "flow", nodes: ["a", "b"] } }).flow, { nodes: ["a", "b"] });
assert.deepStrictEqual(normalizeSceneShape({ code: { lines: ["own"] }, panel: { type: "code", lines: ["other"] } }).code, { lines: ["own"] }, "scene's own panel wins");
assert.deepStrictEqual(normalizeSceneShape({ panel: { type: "mystery" } }), { panel: { type: "mystery" } });
// through the whole import path
const pasted = JSON.stringify({ scenes: [
  { i: 0, text: "Add the key to application dot properties.", pose: "point", setting: "office", panel: { type: "code", language: "properties", filename: "application.properties", lines: ["payment.gateway.type=Paytm"], highlightLines: [1] } },
  { i: 1, text: "Now run it.", pose: "think", setting: "office", panel: { type: "terminal", command: "mvn spring-boot:run", output: ["Paytm"] } },
] });
assert.strictEqual(parsePlanText(pasted).scenes[0].code.title, "application.properties");
const plan = planFromPlanOnly(pasted);
assert.strictEqual((plan.scenes[0].visual as any).code.language, "properties");
assert.deepStrictEqual((plan.scenes[1].visual as any).terminal.lines, ["$ mvn spring-boot:run", "Paytm"]);

// ── 3. prompts teach the tutorial rules ──
const prompt = buildDirectorPrompt(["Spring injects the key."], [0], 1);
for (const needle of ["CODING TUTORIALS", "35-45%", "revealFrom", '"language"', "properties", "BEFORE the result is shown", "Code blocks inside them ARE real code"]) assert.ok(prompt.includes(needle) || needle === "Code blocks inside them ARE real code", `director prompt mentions ${needle}`);
const notes = buildDirectorPrompt(["x"], [0], 1, { beatScene: [0], notes: ["```java\n@Value(\"x\")\n```"] });
assert.ok(notes.includes("Code blocks inside them ARE real code"));
const po = buildPlanOnlyPrompt(20, "Hinglish");
assert.ok(po.includes("LESSON DESIGN") && po.includes('@Value(\\"${payment.gateway.type}\\")') && po.includes('"revealFrom":2') && po.includes("one practical task"));

// the JSON examples inside the plan-only prompt must be valid JSON that our own importer accepts
const exCode = /(\{"i":12,.*?"animate":"type"\}\})/.exec(po)?.[1];
const exTerm = /(\{"i":13,.*?"3"?\]?\}\})/.exec(po)?.[1] ?? /(\{"i":13,.*?\]\}\})/.exec(po)?.[1];
assert.ok(exCode && exTerm, "examples found in the prompt");
const exScenes = [JSON.parse(exCode!), JSON.parse(exTerm!)];
assert.strictEqual(exScenes[0].code.lines[2], '    @Value("${payment.gateway.type}")');
assert.strictEqual(sanitizeVisual(exScenes[0], 0) && (sanitizeVisual(exScenes[0], 0) as any).code.animate, "type");

// ── 4. the quality gate ──
const spring = (n: number) => Array.from({ length: n }, (_, i) => ({ text: i % 2 ? "The @Value annotation injects the property into this field." : "application.properties holds the payment gateway type.", visual: { pose: "present", callouts: ["@VALUE"] } }));
// the video that had no code: lots of code talk, zero code panels
const noCode = lessonQualityReport(spring(60));
assert.ok(noCode.some((w) => w.level === "warn" && /only 0% of the scenes show code/.test(w.message)));
assert.ok(noCode.some((w) => w.level === "warn" && /name code .* but show no code panel/.test(w.message)));
assert.ok(noCode.some((w) => /pause and think/.test(w.message)));
assert.ok(noCode.some((w) => /practical task/.test(w.message)));
assert.strictEqual(looksLikeCodingLesson(spring(10)), true);
assert.strictEqual(looksLikeCodingLesson([{ text: "The ocean is deep and blue.", visual: {} }]), false);
assert.deepStrictEqual(lessonQualityReport([{ text: "The ocean is deep and blue.", visual: {} }]), []);
// a healthy mix passes the share check
const mixed = spring(10).map((s, i) => (i % 2 ? { ...s, visual: { code: { title: "A.java", lines: ["@Value(\"x\")"], language: "java" } } } : s));
assert.ok(!lessonQualityReport(mixed).some((w) => /only \d+% of the scenes/.test(w.message)));
// per-scene findings
const findings = lessonQualityReport([
  { text: "Look at this.", visual: { code: { title: "A.java", language: "java", lines: ["String s = \"oops;", "x".repeat(70)] } } },
  { text: "Now more.", visual: { code: { title: "A.java", language: "java", lines: ["// changed", "b"], revealFrom: 1 } } },
  { text: "Which one wins? The primary bean wins.", visual: { quiz: { question: "Which bean wins?", options: ["primary bean", "qualifier", "none"], answer: 0 } } },
  { text: "Run it.", visual: { terminal: { lines: ["Paytm"] } } },
  ...Array.from({ length: 3 }, () => ({ text: "The @Autowired class uses application.properties.", visual: { code: { lines: ["a"] } } })),
]);
assert.ok(findings.some((w) => w.scene === 1 && /unbalanced quote/.test(w.message)));
assert.ok(findings.some((w) => w.scene === 1 && w.level === "info" && /longer than 56/.test(w.message)));
assert.ok(findings.some((w) => w.scene === 2 && /revealFrom is 1/.test(w.message)));
assert.ok(findings.some((w) => w.scene === 3 && /quiz answer/.test(w.message)));
assert.ok(findings.some((w) => w.scene === 4 && /no command line/.test(w.message)));
assert.ok(lessonQualityReport([{ text: "x", visual: { code: { title: "A.java", lines: Array.from({ length: 16 }, (_, i) => `l${i}`) } } }]).some((w) => /16 lines/.test(w.message)));
// warnings sort before tips; the gate is wired into the plan check
assert.strictEqual(findings[0].level, "warn");
const check = checkPlanOnly(pasted);
assert.deepStrictEqual(check.errors, []);
assert.ok(Array.isArray(check.warnings));

// ── 5. catalogue sync with my-video (when its submodule has the new code panel) ──
const mineCode = path.resolve(__dirname, "../my-video/src/stickman/code.ts");
if (fs.existsSync(mineCode) && fs.readFileSync(mineCode, "utf8").includes("CODE_LANGUAGES")) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CODE_LANGUAGES } = require("../my-video/src/stickman/code");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { validateStickmanScenes } = require("../my-video/src/stickman/schema");
  assert.deepStrictEqual([...CODE_LANGUAGES], ["java", "properties", "yaml", "bash", "xml", "text"], "planner's CODE_LANGUAGES mirrors my-video");
  assert.deepStrictEqual(validateStickmanScenes(plan.scenes.map((s: any) => ({ id: s.id, visual: s.visual }))), []);
  const big = sanitizeVisual({ code: { title: "PaymentGateway.java", lines: ["@Component", "public class PaymentGateway {", long, "}"], highlightLines: [3], revealFrom: 2, animate: "type" } }, 0);
  assert.deepStrictEqual(validateStickmanScenes([{ id: "x", visual: big }]), []);
} else {
  console.log("(my-video submodule without the new code panel: schema sync check skipped)");
}

console.log("✓ code tutorial: wrapping, language, import mapping, prompts, quality gate");
