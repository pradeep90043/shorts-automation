import assert from "assert";
import { devanagariFromAnswer, toDevanagari } from "../src/audio/clonedVoice";

// plain answers, quotes, numbering and chain-of-thought prose around the real answer
assert.strictEqual(devanagariFromAnswer('"आरबीआई ब्याज दर बढ़ा सकता है।"'), "आरबीआई ब्याज दर बढ़ा सकता है।");
assert.strictEqual(devanagariFromAnswer("We need to rewrite this in Devanagari.\nHere it is:\nआरबीआई ब्याज दर बढ़ा सकता है।"), "आरबीआई ब्याज दर बढ़ा सकता है।");
assert.strictEqual(devanagariFromAnswer("only english words here"), "");

(async () => {
  const calls: string[] = [];
  const ask = async (p: string) => { calls.push(p); return p.includes("EMI") ? "ईएमआई बढ़ सकती है" : "ये एक सामान्य बात है"; };
  const lines = [{ name: "claim", text: "EMI badh sakti hai" }, { name: "hiw_0", text: "ye ek samanya baat hai" }, { name: "hiw_1", text: "5.50" }, { name: "hiw_2", text: "पहले से देवनागरी" }];
  const res = await toDevanagari(lines, ask);
  assert.ok(res && res.length === 4);
  assert.strictEqual(res![0].text, "ईएमआई बढ़ सकती है");
  assert.strictEqual(res![2].text, "5.50");        // a bare figure is left alone, no call
  assert.strictEqual(res![3].text, "पहले से देवनागरी"); // already Devanagari, no call
  assert.strictEqual(calls.length, 2);
  // a model that never answers in Devanagari fails the voice cleanly (after 3 tries per line) instead of hanging
  let n = 0;
  const bad = await toDevanagari([{ name: "claim", text: "hello there friend" }], async () => { n++; return "I cannot do that"; });
  assert.strictEqual(bad, null);
  assert.strictEqual(n, 3);
  console.log("✓ devanagari lines");
})();
