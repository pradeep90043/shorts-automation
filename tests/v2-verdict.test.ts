import assert from "assert";
import { buildHowItWorksSpec, howItWorksLines, verdictCategory, verdictLine } from "../src/my-video/howItWorksClip";

// CodeOrCap V2: the verdict closes the how-it-works clip (it replaces the avatar end card)
const explanation = "AI engineers earn between 8 and 40 lakh a year. Cloud architects are close behind.";
const verdict = { verdict: "Mostly True", score: 8 };

assert.strictEqual(verdictCategory("Mostly True").label, "PARTIALLY TRUE");
assert.strictEqual(verdictCategory("Misleading").label, "PARTIALLY WRONG");
assert.strictEqual(verdictLine(verdict), "So the verdict: partially true. Eight out of ten.");
assert.ok(verdictLine(verdict, "hi").includes("दस में से आठ"));
assert.strictEqual(verdictLine({ verdict: "False", score: 42 }), "So the verdict: wrong. Ten out of ten."); // clamped to 10

// the narrated lines (the cloned voice is matched against these) end with the verdict, and only when one is given
const lines = howItWorksLines(explanation, "Let us check how is it working.", verdict);
assert.strictEqual(lines[lines.length - 1], verdictLine(verdict));
assert.strictEqual(howItWorksLines(explanation).length, lines.length - 1);

// the spec gets one scene per line, the last one shows the label and the score
const spec = buildHowItWorksSpec({ explanation, verdict }, "t");
assert.strictEqual(spec.scenes.length, lines.length);
const last = spec.scenes[spec.scenes.length - 1] as any;
assert.strictEqual(last.text, verdictLine(verdict));
const shown = JSON.stringify(last.visual);
assert.ok(shown.includes("PARTIALLY TRUE") && shown.includes("8/10"), `verdict visual kept its label and score: ${shown}`);
assert.strictEqual(buildHowItWorksSpec({ explanation }, "t").scenes.length, lines.length - 1);

console.log("✓ v2 verdict");
