import assert from "assert";
import { estimateVoiceboxSec, sceneLines } from "../src/my-video/voiceboxNarration";
import { isVoicebox } from "../src/my-video/stickmanJobs";
import { planFromPlanOnly } from "../src/my-video/stickmanPlanner";

// each scene becomes one line named the way my-video names a scene's audio file: segment_<index>_<id>
const lines = sceneLines([
  { id: "s01", text: "  दोस्तों, आज हम स्प्रिंग एमवीसी सीखेंगे।  " },
  { id: "s02", text: "on screen text", ttsText: "spoken text" },
  { id: "s10", text: "तीसरा" },
]);
assert.deepStrictEqual(lines.map((l) => l.name), ["segment_0_s01", "segment_1_s02", "segment_2_s10"]);
assert.strictEqual(lines[0].text, "दोस्तों, आज हम स्प्रिंग एमवीसी सीखेंगे।", "trimmed");
assert.strictEqual(lines[1].text, "spoken text", "ttsText wins over the caption text");

// a plan-only scene can be captioned in English class names and spoken in Devanagari: ttsText reaches the voice, text stays the caption
const planned = planFromPlanOnly({
  title: "t", description: "d", tags: [],
  scenes: [
    { i: 0, text: "DispatcherServlet सारी requests लेता है।", ttsText: "डिस्पैचर सर्वलेट सारी रिक्वेस्ट्स लेता है।", pose: "present" },
    { i: 1, text: "Tomcat पोर्ट 8080 पर सुनता है।" },
  ],
});
assert.strictEqual(planned.scenes[0].text, "DispatcherServlet सारी requests लेता है।");
assert.strictEqual(planned.scenes[0].ttsText, "डिस्पैचर सर्वलेट सारी रिक्वेस्ट्स लेता है।");
assert.strictEqual(planned.scenes[1].ttsText, undefined, "no ttsText: the caption is spoken");
assert.deepStrictEqual(sceneLines(planned.scenes).map((l) => l.text), ["डिस्पैचर सर्वलेट सारी रिक्वेस्ट्स लेता है।", "Tomcat पोर्ट 8080 पर सुनता है।"]);

// the cloned voice is chosen by name, never confused with an edge-tts voice
assert.ok(isVoicebox("voicebox") && isVoicebox("Voicebox-hi"));
assert.ok(!isVoicebox("hi-IN-MadhurNeural") && !isVoicebox(undefined) && !isVoicebox(""));

// estimate: more text costs more only until the 20 runners are busy, then it grows with the share per runner
const small = estimateVoiceboxSec(800);
const twentyMin = estimateVoiceboxSec(17000);
const hour = estimateVoiceboxSec(51000);
assert.ok(small > 600 && small < 1300, `one runner (~60 s of speech): ${small}s`);
assert.ok(twentyMin > 900 && twentyMin < 1500, `20 minutes of Hindi: ${twentyMin}s`);
assert.ok(hour > twentyMin, "an hour needs longer than 20 minutes (capped at 20 runners)");
assert.ok(hour < 3 * twentyMin, "but parallelism keeps it far from linear");

console.log("✓ voicebox narration");
