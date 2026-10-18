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
