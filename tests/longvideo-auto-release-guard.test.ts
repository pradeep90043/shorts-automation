import { cleanScriptMarkers } from "../src/longvideo-auto/guardrails";
import assert from "assert";
import { assignRelease, istMinuteToUtcMs } from "../src/longvideo-auto/release";
import { checkScript, numbersIn } from "../src/longvideo-auto/guardrails";

// ---- release: each channel has its own evening slot, 22+ minutes away from any Short
const day = "2026-10-16";
const at = (hhmm: string) => istMinuteToUtcMs(day, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const earlyMorning = at("04:00");
const r0 = assignRelease("codeorcap", earlyMorning, day);
assert.strictEqual(new Date(r0.atMs + 5.5 * 3600e3).toISOString().slice(11, 16), "18:25");
const r3 = assignRelease("infoonspot", earlyMorning, day);
assert.strictEqual(new Date(r3.atMs + 5.5 * 3600e3).toISOString().slice(11, 16), "20:55");

// a video that finishes after its slot gets the next free one, never "now"
const late = assignRelease("codeorcap", at("18:40"), day);
assert.strictEqual(new Date(late.atMs + 5.5 * 3600e3).toISOString().slice(11, 16), "19:15");
// two videos never share a slot
const taken = new Set([`${day}:${r0.minute}`]);
assert.notStrictEqual(assignRelease("codeorcap", earlyMorning, day, taken).minute, r0.minute);
// past the last slot of the day -> tomorrow's
const tomorrow = assignRelease("infoonspot", at("21:30"), day);
assert.strictEqual(tomorrow.istDate, "2026-10-17");

// ---- guardrails
assert.deepStrictEqual(numbersIn("कीमत 1,250 रुपये, ८५ प्रतिशत और 7"), ["1250", "85"]);
const source = "Sensex closed at 81,200 points, up 1.2 percent. Nifty 24,500.";
const goodScript = Array(100).fill("शब्द").join(" ") + " Sensex 81,200 और 1.2 प्रतिशत। यह वित्तीय सलाह नहीं है।";
const ok = checkScript({ channelKey: "prompt_gag", script: goodScript, title: "आज का बाज़ार", description: "यह वित्तीय सलाह नहीं है", sourceText: source, targetWords: 110 });
assert.strictEqual(ok.ok, true, ok.problems.join("; "));

// a figure the sources never gave is a failure, not a quiet pass
const invented = checkScript({ channelKey: "codeorcap", script: goodScript + " 99999", title: "t", sourceText: source, targetWords: 110, tolerance: 0.2 });
assert.ok(invented.unsupportedNumbers.includes("99999"));
assert.strictEqual(invented.ok, false);

// finance rules apply to prompt_gag only
const advice = goodScript + " इस शेयर को अभी खरीद लो, पक्का मुनाफा है।";
assert.strictEqual(checkScript({ channelKey: "prompt_gag", script: advice, title: "t", sourceText: source, targetWords: 120, tolerance: 0.3 }).ok, false);
assert.ok(checkScript({ channelKey: "codeorcap", script: advice, title: "t", sourceText: source, targetWords: 120, tolerance: 0.3 }).ok);
const noDisclaimer = checkScript({ channelKey: "prompt_gag", script: Array(100).fill("शब्द").join(" "), title: "t", sourceText: "", targetWords: 100 });
assert.ok(noDisclaimer.problems.some((p) => p.includes("disclaimer")));

// length, placeholder, title
assert.ok(checkScript({ channelKey: "codeorcap", script: "छोटा", title: "t", sourceText: "", targetWords: 1340 }).problems[0].startsWith("length"));
assert.ok(checkScript({ channelKey: "codeorcap", script: goodScript + " [TODO]", title: "t", sourceText: source, targetWords: 110, tolerance: 0.5 }).problems.some((p) => p.includes("placeholder")));
assert.ok(checkScript({ channelKey: "codeorcap", script: goodScript, title: "x".repeat(101), sourceText: source, targetWords: 110, tolerance: 0.5 }).problems.some((p) => p.includes("title")));

// harmless markers are cleaned, template slots are kept (and rejected)
assert.strictEqual(cleanScriptMarkers("आज [1] की बात [संगीत] शुरू<br>करते हैं"), "आज की बात शुरू करते हैं");
assert.ok(cleanScriptMarkers("नमस्ते [channel name] दोस्तों").includes("[channel name]"));
assert.ok(cleanScriptMarkers("नमस्ते [यहाँ नाम] दोस्तों").includes("[यहाँ नाम]"));
const slotCheck = checkScript({ channelKey: "codeorcap", script: goodScript + " [channel name]", title: "t", sourceText: source, targetWords: 110, tolerance: 0.5 });
assert.ok(slotCheck.problems.some((p) => p.includes('"[channel name]"')));
console.log("✓ longvideo-auto release + guardrails");
