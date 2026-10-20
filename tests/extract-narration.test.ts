import assert from "assert";
import { extractNarration } from "../src/longvideo-auto/scriptWriter";

// a reasoning model's English analysis around the real chapter is never narrated
const deva = "आज हम बात करेंगे कि डेवलपर नौकरी मिलने के बाद पढ़ाई क्यों नहीं छोड़ते। यह एक बहुत जरूरी सवाल है।";
assert.strictEqual(extractNarration(`Here's a thinking process: 1. Analyze the request.\nDraft: <<<Aaj hum baat karenge>>>\nFinal: <<<${deva}>>>`), deva);
assert.strictEqual(extractNarration(`Here's a thinking process:\n1. Analyze the Request: Topic: Chapter\n2. Draft the text.\n${deva}\nNote: check length.`), deva);
assert.strictEqual(extractNarration(`<<<${deva}`), deva, "an unclosed block");
assert.strictEqual(extractNarration("only english"), "only english");
console.log("✓ extractNarration");
