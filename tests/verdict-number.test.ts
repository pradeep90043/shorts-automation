import assert from "assert";
import { gainToTarget, numberWord, tempoToFit } from "../src/audio/verdictNumber";

// the spoken score is always a word, clamped to 0..10
assert.strictEqual(numberWord(6), "six");
assert.strictEqual(numberWord(10), "ten");
assert.strictEqual(numberWord(10.4), "ten");
assert.strictEqual(numberWord(0.2), "zero");
assert.strictEqual(numberWord(42), "ten");
assert.strictEqual(numberWord(6.6), "seven");

// a word shorter than the pause is left alone (never stretched); a longer one is sped up to fit, up to 1.5x
assert.strictEqual(tempoToFit(0.4, 0.6), 1);
assert.strictEqual(tempoToFit(0.6, 0.6), 1);
assert.ok(Math.abs(tempoToFit(0.9, 0.6) - 1.5) < 1e-9, "0.9s into 0.6s = 1.5x");
assert.strictEqual(tempoToFit(2, 0.6), 1.5, "capped");
assert.strictEqual(tempoToFit(NaN, 0.6), 1);
assert.strictEqual(tempoToFit(0.5, 0), 1);

// level: brought to -3 dB peak (the recorded person peaks at -0.8 dB), within +-15 dB, ignores bad measurements
assert.strictEqual(gainToTarget(-3), 0);
assert.strictEqual(gainToTarget(-13), 10);
assert.strictEqual(gainToTarget(-40), 15);
assert.strictEqual(gainToTarget(12), -15);
assert.strictEqual(gainToTarget(NaN), 0);

console.log("✓ verdict number");
