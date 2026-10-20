import assert from "assert";
import { devanagariFromAnswer, splitForVoice, toDevanagari } from "../src/audio/clonedVoice";

// plain answers, quotes, numbering and chain-of-thought prose around the real answer
assert.strictEqual(devanagariFromAnswer('"आरबीआई ब्याज दर बढ़ा सकता है।"'), "आरबीआई ब्याज दर बढ़ा सकता है।");
assert.strictEqual(devanagariFromAnswer("We need to rewrite this in Devanagari.\nHere it is:\nआरबीआई ब्याज दर बढ़ा सकता है।"), "आरबीआई ब्याज दर बढ़ा सकता है।");
assert.strictEqual(devanagariFromAnswer("only english words here"), "");


// a long claim is split into sentence-sized pieces for parallel runners, and nothing is lost or reordered
{
  const claim = "आरबीआई ब्याज दरें बढ़ा सकता है। इसका सीधा असर आपकी होम लोन की ईएमआई पर पड़ेगा, खासकर फ्लोटिंग रेट वालों पर। " +
    "महंगाई 4.82 प्रतिशत तक पहुँच गई है और तेल की कीमतें भी ऊपर हैं। इसलिए बैंक अपनी दरें बदलने से पहले दो बार सोचेंगे। " +
    "अगर आपका लोन लंबा है तो थोड़ी बढ़त भी बड़ा फर्क डालती है। ध्यान रहे: यह सिर्फ जानकारी है, निवेश सलाह नहीं।";
  const parts = splitForVoice(claim, 120);
  assert.ok(parts.length >= 3, "split into several pieces, got " + parts.length);
  assert.ok(parts.every((p) => p.length <= 160), "no piece far above the limit");
  assert.strictEqual(parts.join(" ").replace(/\s+/g, " "), claim.replace(/\s+/g, " "), "the pieces read back as the same text, in order");
  assert.deepStrictEqual(splitForVoice("एक छोटा वाक्य।", 250), ["एक छोटा वाक्य।"]);
  const longWord = splitForVoice("शब्द ".repeat(120).trim(), 100);
  assert.ok(longWord.length > 3 && longWord.every((p) => p.length <= 100));
}

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

import { devanagariTooLong, devanagariFromAnswer as dfa, clampRunaway } from "../src/audio/clonedVoice";
{
  const src = "Yeh ek chhota sa test hai";
  const runaway = Array.from({ length: 400 }, () => "यह एक छोटा सा टेस्ट है और यह चलता ही रहता है").join("\n");
  assert.ok(devanagariTooLong(dfa(runaway), src) === false || dfa(runaway).length < 400, "a repeated line is collapsed");
  assert.ok(devanagariTooLong("क".repeat(5000), src), "a 5,000-character answer for a short line is rejected");
  assert.ok(!devanagariTooLong("यह एक छोटा सा टेस्ट है", src), "a normal rewrite is kept");
    const loop = "यह एक छोटा सा टेस्ट है। " + "और फिर वही बात दोहराता रहता है ".repeat(300);
  const kept = clampRunaway(loop, src);
  assert.ok(kept.startsWith("यह एक छोटा सा टेस्ट है।") && kept.length <= Math.max(60, src.length * 2) + 1, "the clean beginning of a looping answer is kept, cut at a boundary");
  console.log("✓ runaway Hindi answers are rejected");
}
