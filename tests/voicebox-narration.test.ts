import assert from "assert";
import { estimateVoiceboxSec, sceneLines } from "../src/my-video/voiceboxNarration";
import { interruptedJobAction, isVoicebox } from "../src/my-video/stickmanJobs";
import { planFromPlanOnly } from "../src/my-video/stickmanPlanner";
import { voiceInputsFor } from "../src/my-video/voiceProfiles";

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

// "pause the video" quizzes: the thinking time and the reveal timing survive planning
const quizPlan = planFromPlanOnly({
  title: "t", description: "d", tags: [],
  scenes: [
    { i: 0, text: "Pause the video and choose your answer.", pauseAfter: 9.5, quiz: { question: "Which one?", options: ["A", "B", "C"], answer: 1, revealBeforeEnd: 1.5 } },
    { i: 1, text: "The answer is B.", pauseAfter: 999, pauseBefore: -3 },
  ],
});
assert.strictEqual(quizPlan.scenes[0].pauseAfter, 9.5);
assert.strictEqual((quizPlan.scenes[0].visual as any).quiz.revealBeforeEnd, 1.5, "the reveal timing is kept");
assert.strictEqual(quizPlan.scenes[1].pauseAfter, 30, "capped at 30 s");
assert.strictEqual(quizPlan.scenes[1].pauseBefore, undefined, "a negative pause is ignored");

// after an app restart a job re-attaches to its GitHub run instead of starting over (the voice stage is ~10 minutes on 20 runners)
assert.strictEqual(interruptedJobAction({ cloudRun: { runId: 1, repo: "r", token: "t" } }), "render");
assert.strictEqual(interruptedJobAction({ voiceRun: { runId: 2, repo: "r" } }), "voice");
assert.strictEqual(interruptedJobAction({ cloudRun: { runId: 1, repo: "r", token: "t" }, voiceRun: { runId: 2, repo: "r" } }), "render", "the render is the later stage");
assert.strictEqual(interruptedJobAction({}), "scratch");

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
// English runs on the faster turbo engine: the same text is ready sooner than in Hindi
assert.ok(estimateVoiceboxSec(17000, 20, 800, "en") < twentyMin * 0.75, "English voice is quicker than Hindi");
assert.strictEqual(estimateVoiceboxSec(17000), estimateVoiceboxSec(17000, 20, 800, "hi"), "Hindi stays the default");

console.log("✓ voicebox narration");

// per-channel cloned voice: Storiyum speaks as paki1 (the Pakizah sample); a channel with no entry keeps the workflow defaults
const storiyum = voiceInputsFor("Storiyum");
assert.strictEqual(storiyum.voice, "paki1");
assert.strictEqual(storiyum.sample_path, "assets/voice-samples/pakizah.mp3");
assert.ok(Number(storiyum.sample_end) - Number(storiyum.sample_start) < 30, "the sample window stays under 30 s");
const codeorcap = voiceInputsFor("codeorcap");
assert.strictEqual(codeorcap.voice, "paddy1");
assert.strictEqual(codeorcap.sample_path, "assets/voice-samples/paddy1_clean.mp3");
assert.ok(require("fs").existsSync(codeorcap.sample_path), "the sample file is committed in the repo");
assert.ok(require("fs").existsSync(storiyum.sample_path), "the Storiyum sample file is committed in the repo");
assert.notStrictEqual(codeorcap.voice, storiyum.voice, "the two channels have different voices");
assert.deepStrictEqual(voiceInputsFor(undefined), {});

// all four channels: CodeOrCap and Prompt Gag speak as paddy1, Storiyum and InfoOnSpot as paki1
assert.strictEqual(voiceInputsFor("prompt_gag").voice, "paddy1");
assert.strictEqual(voiceInputsFor("PROMPT_GAG").sample_path, "assets/voice-samples/paddy1_clean.mp3");
assert.strictEqual(voiceInputsFor("infoonspot").voice, "paki1");
assert.strictEqual(voiceInputsFor("infoonspot").sample_path, "assets/voice-samples/pakizah.mp3");
assert.ok(require("fs").existsSync(voiceInputsFor("prompt_gag").sample_path));
assert.ok(require("fs").existsSync(voiceInputsFor("infoonspot").sample_path));
