import assert from "assert";
import { devanagariFromAnswer, splitForVoice, toDevanagari, plausibleRewrite, parseBatchAnswer } from "../src/audio/clonedVoice";

// one batched call for the whole script: numbered <<< >>> blocks, a block that is notes instead of a rewrite is dropped (and redone alone)
{
  const src = ["RBI ne repo rate badhaya to aapki EMI badhegi.", "Subscribe karna mat bhooliye.", "Crude oil ki keemat"];
  const answer = 'Here is the result:\n1. <<<आरबीआई ने रेपो रेट बढ़ाया तो आपकी ईएमआई बढ़ेगी।>>>\n2. <<<सब्सक्राइब करना मत भूलिए।>>>\n3. <<<क्रूड -> क्रूड, तेल -> तेल>>>';
  const parsed = parseBatchAnswer(answer, src);
  assert.strictEqual(parsed[0], "आरबीआई ने रेपो रेट बढ़ाया तो आपकी ईएमआई बढ़ेगी।");
  assert.strictEqual(parsed[1], "सब्सक्राइब करना मत भूलिए।");
  assert.strictEqual(parsed[2], null, "notes are not a rewrite");
  assert.deepStrictEqual(parseBatchAnswer("no blocks at all", src), [null, null, null]);
  // a long line wrapped by the model keeps its tail (a one-word "जाएगा।" on the second line was once dropped, ending a Short's sentence mid-way)
  const wrapped = "1. <<<आरबीआई ने रेपो रेट बढ़ाया तो आपकी ईएमआई बढ़ेगी\nऔर आपका लोन महंगा हो जाएगा।>>>\n2. सब्सक्राइब करना मत\nभूलिए।\n3. क्रूड ऑयल की कीमत।";
  const w = parseBatchAnswer(wrapped, ["RBI ne repo rate badhaya to aapki EMI badhegi aur loan mehenga ho jayega.", "Subscribe karna mat bhooliye.", "Crude oil ki keemat."]);
  assert.strictEqual(w[0], "आरबीआई ने रेपो रेट बढ़ाया तो आपकी ईएमआई बढ़ेगी और आपका लोन महंगा हो जाएगा।");
  assert.strictEqual(w[1], "सब्सक्राइब करना मत भूलिए।");
  assert.strictEqual(devanagariFromAnswer("<<<इसलिए अभी अपना लोन चेक करो, क्योंकि प्रिंसिपल कम होगा तो बोझ भी कम हो\nजाएगा।>>>"), "इसलिए अभी अपना लोन चेक करो, क्योंकि प्रिंसिपल कम होगा तो बोझ भी कम हो जाएगा।");
}

// The exact fragments a reasoning model's notes produced and a Short was narrated with: none may pass as a rewrite
{
  const garbage: [string, string][] = [
    ['आपके" or "आपक़े"?', "Aapke liye"],
    ["क्रूड -> क्रूड, तेल -> तेल, कीमतें -> कीमतें.", "Crude oil ki keemat"],
    ["पुट or डाल.", "put karo"],
    ['रिजर्व बैंक ऑफ इंडिया. की" or "रबीआई की". होने वाली है".', "Reserve Bank of India ki hone wali baithak"],
    ['हाइक" or "हाइक"? कन्फ़र्म" or "कन्फर्म". ऑप्शन्स" or "ऑप्शन".', "hike confirm options"],
  ];
  for (const [bad, src] of garbage) assert.ok(!plausibleRewrite(bad, src), `must reject: ${bad}`);
  assert.ok(plausibleRewrite("आरबीआई ने रेपो रेट बढ़ाया तो आपकी ईएमआई बढ़ेगी।", "RBI ne repo rate badhaya to aapki EMI badhegi."));
  assert.ok(plausibleRewrite("सब्सक्राइब करना मत भूलिए।", "Subscribe karna mat bhooliye."));
  assert.ok(!plausibleRewrite("आरबीआई ने रेपो रेट बढ़ाया तो आपकी ईएमआई बढ़ेगी। " + "और भी बहुत कुछ ".repeat(30), "RBI ne repo rate badhaya."), "far too long for its source");
}

// plain answers, quotes, numbering and chain-of-thought prose around the real answer
assert.strictEqual(devanagariFromAnswer('"आरबीआई ब्याज दर बढ़ा सकता है।"'), "आरबीआई ब्याज दर बढ़ा सकता है।");
assert.strictEqual(devanagariFromAnswer("We need to rewrite this in Devanagari.\nHere it is:\nआरबीआई ब्याज दर बढ़ा सकता है।"), "आरबीआई ब्याज दर बढ़ा सकता है।");
assert.strictEqual(devanagariFromAnswer("only english words here"), "");
// a reasoning model analyses first and may draft the text in the analysis: the LAST <<< >>> block is the answer
assert.strictEqual(
  devanagariFromAnswer("Here's a thinking process:\n\n1.  **Analyze the Input:**\n   - Input text: \"RBI ne repo rate badhaya\"\n2. Draft: <<<आरबीआई ने रेपो रेट</>>> \n\nFinal: <<<आरबीआई ने रेपो रेट बढ़ाया।>>>"),
  "आरबीआई ने रेपो रेट बढ़ाया।",
);
assert.strictEqual(devanagariFromAnswer("<<<आरबीआई ने रेपो रेट बढ़ाया।>>>"), "आरबीआई ने रेपो रेट बढ़ाया।");
// an echoed instruction quotes one Devanagari word but is English prose: it must never be spoken (a Short once read it aloud)
assert.strictEqual(
  devanagariFromAnswer('आरबीआई ब्याज दर बढ़ा सकता है।\nWrite English words in Devanagari too (e.g. "video" -> "वीडियो"); keep numbers and punctuation.'),
  "आरबीआई ब्याज दर बढ़ा सकता है।",
);
// the real rewrite and the echo on the SAME line (a ratio filter on whole lines dropped this and muted a Short)
assert.strictEqual(
  devanagariFromAnswer('आरबीआई ब्याज दर बढ़ा सकता है। Keep the meaning and every word; write English words in Devanagari too (e.g. "video" -> "वीडियो"); keep numbers and punctuation.'),
  "आरबीआई ब्याज दर बढ़ा सकता है।",
);
// a sentence repeated with its last copy cut off is kept once
assert.strictEqual(devanagariFromAnswer("ध्यान रखिए, सभी बैंक्स तुरंत रेट नहीं बढ़ाते. ध्यान रखिए, सभी बैंक्स तुरंत रेट नहीं बढ़"), "ध्यान रखिए, सभी बैंक्स तुरंत रेट नहीं बढ़ाते.");
// a short source line may legitimately be one or two words
assert.strictEqual(devanagariFromAnswer("ठीक है", 1), "ठीक है");
assert.strictEqual(devanagariFromAnswer("Hindi: 25 बेसिस पॉइंट की बढ़ोतरी हो सकती है"), "25 बेसिस पॉइंट की बढ़ोतरी हो सकती है");


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
  // 2 batch attempts (this model does not answer in the numbered <<< >>> format) + 1 per-line call for each of the 2 lines that need it
  assert.strictEqual(calls.length, 4);
  // a model that never answers in Devanagari fails the voice cleanly (after 3 tries per line) instead of hanging
  let n = 0;
  const bad = await toDevanagari([{ name: "claim", text: "hello there friend" }], async () => { n++; return "I cannot do that"; });
  assert.strictEqual(bad, null);
  assert.strictEqual(n, 5); // 2 batch attempts + 3 per-line attempts
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
  assert.ok(kept.startsWith("यह एक छोटा सा टेस्ट है।") && kept.length <= Math.max(60, Math.round(src.length * 1.4)) + 1, "the clean beginning of a looping answer is kept, cut at a boundary");
  console.log("✓ runaway Hindi answers are rejected");
}
