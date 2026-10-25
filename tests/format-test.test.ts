import assert from "assert";
import { SHORT_FORMATS, formatForSlot, formatTestActive, formatTestFor, istDayIndex, leaderFormat } from "../src/schedule/formatTest";

// Latin square: over 4 consecutive days each format appears exactly once in every one of the first 4 slots, and once per day
for (let slot = 0; slot < 4; slot++) {
  const seen = new Set(Array.from({ length: 4 }, (_, d) => formatForSlot(slot, 100 + d, {})));
  assert.strictEqual(seen.size, 4, `slot ${slot} sees every format over 4 days`);
}
for (let day = 0; day < 8; day++) {
  const today = Array.from({ length: 4 }, (_, s) => formatForSlot(s, day, {}));
  assert.deepStrictEqual([...today].sort(), [...SHORT_FORMATS].sort(), `day ${day} runs every format once`);
}
// the pattern repeats every 4 days and never throws on a negative day
assert.strictEqual(formatForSlot(2, 7, {}), formatForSlot(2, 3, {}));
assert.ok((SHORT_FORMATS as readonly string[]).includes(formatForSlot(1, -5, {})));

// flex slots follow the leader, which defaults to image_music and ignores unknown values
assert.strictEqual(formatForSlot(4, 9, {}), "image_music");
assert.strictEqual(formatForSlot(4, 9, { FORMAT_TEST_LEADER: "image_voice" }), "image_voice");
assert.strictEqual(leaderFormat({ FORMAT_TEST_LEADER: "nonsense" }), "image_music");
assert.throws(() => formatForSlot(-1, 0, {}));

// on by default for CodeOrCap only, with FORMAT_TEST=off as the kill switch and FORMAT_TEST_CHANNELS to widen it
assert.strictEqual(formatTestActive({}), true);
assert.strictEqual(formatTestActive({ FORMAT_TEST: "off" }), false);
assert.strictEqual(formatTestFor("codeorcap", {}), true);
assert.strictEqual(formatTestFor("CodeOrCap", {}), true);
assert.strictEqual(formatTestFor("prompt_gag", {}), false);
assert.strictEqual(formatTestFor("prompt_gag", { FORMAT_TEST_CHANNELS: "codeorcap, prompt_gag" }), true);
assert.strictEqual(formatTestFor("codeorcap", { FORMAT_TEST: "off" }), false);

// the IST day changes at 18:30 UTC, not at UTC midnight
const base = Date.UTC(2026, 9, 25, 18, 29, 0);
assert.strictEqual(istDayIndex(base + 60_000), istDayIndex(base) + 1);
assert.strictEqual(istDayIndex(base), istDayIndex(Date.UTC(2026, 9, 25, 0, 0, 0)));

console.log("format-test: ok");
