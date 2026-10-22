import assert from "assert";
import { extractNarration } from "../src/longvideo-auto/scriptWriter";

// a reasoning model's English analysis around the real chapter is never narrated
const deva = "आज हम बात करेंगे कि डेवलपर नौकरी मिलने के बाद पढ़ाई क्यों नहीं छोड़ते। यह एक बहुत जरूरी सवाल है।";
assert.strictEqual(extractNarration(`Here's a thinking process: 1. Analyze the request.\nDraft: <<<Aaj hum baat karenge>>>\nFinal: <<<${deva}>>>`), deva);
assert.strictEqual(extractNarration(`Here's a thinking process:\n1. Analyze the Request: Topic: Chapter\n2. Draft the text.\n${deva}\nNote: check length.`), deva);
assert.strictEqual(extractNarration(`<<<${deva}`), deva, "an unclosed block");
assert.strictEqual(extractNarration("only english"), "only english");
import { cleanNarration } from "../src/longvideo-auto/scriptWriter";
assert.ok(!/<<<|>>>/.test(cleanNarration(`<<<${deva}>>> और <<<बाकी`)), "no marker is ever narrated");
assert.ok(!/outline|word count|draft/i.test(cleanNarration("पहली बार फ़रवरी 2023 के Full Outline: 1. बाद ब्याज बढ़ा। Word count: 180. आगे भी बढ़ेगा।")), "working notes are never narrated");
assert.ok(cleanNarration("ब्याज बढ़ा। आगे भी बढ़ेगा।").includes("आगे भी बढ़ेगा"), "normal sentences are kept");
console.log("✓ extractNarration");
