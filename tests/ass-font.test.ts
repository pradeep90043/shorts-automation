import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { generateASSFile } from "../src/audio/subtitles";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-"));
const line = (text: string) => [{ text, start: 0, end: 2, words: text.split(" ").map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.4 })) }];

const hi = path.join(dir, "hi.ass");
generateASSFile(line("आरबीआई ब्याज दर बढ़ा सकता है"), hi, "classic");
assert.ok(fs.readFileSync(hi, "utf8").includes("Style: Default,Noto Sans Devanagari,"), "Hindi captions use a Devanagari font");

const en = path.join(dir, "en.ass");
generateASSFile(line("RBI may raise the rate"), en, "classic");
assert.ok(fs.readFileSync(en, "utf8").includes("Style: Default,Arial Black,"), "English captions keep Arial Black");
fs.rmSync(dir, { recursive: true, force: true });
console.log("✓ ass font");

// captions that say what the voice says, timed across the heard span
import { alignScriptToSpan } from "../src/audio/subtitles";
import { keyPhrase } from "../src/my-video/howItWorksClip";
const al = alignScriptToSpan("आरबीआई ब्याज दर बढ़ा सकता है।", 2, 8);
assert.strictEqual(al.length, 6);
assert.strictEqual(al[0].start, 2);
assert.ok(Math.abs(al[al.length - 1].end - 8) < 1e-9);
assert.ok(al.every((w, i) => i === 0 || Math.abs(w.start - al[i - 1].end) < 1e-9));
assert.deepStrictEqual(alignScriptToSpan("", 0, 5), []);
// Devanagari vowel signs survive the diagram-label cleaning
assert.ok(keyPhrase("आरबीआई ब्याज दर बढ़ा सकता है।").includes("आरबीआई"));
console.log("✓ alignment + devanagari labels");
