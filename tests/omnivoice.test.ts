import assert from "assert";
import fs from "fs";
import path from "path";
import { buildOmniVoiceJob, characterKey, CHARACTER_VOICES, NARRATOR_VOICES, narratorVoiceFor } from "../src/audio/omnivoice/job";
import { embedJob, kaggleSlots, kernelMetadata, parseKernelStatus } from "../src/audio/omnivoice/kaggleRunner";
import { voiceEngine } from "../src/audio/narration";
import { sceneLines } from "../src/my-video/voiceboxNarration";

// the engine: OmniVoice unless the emergency switch brings Voicebox back
assert.strictEqual(voiceEngine({}), "omnivoice");
assert.strictEqual(voiceEngine({ VOICE_ENGINE: "voicebox" }), "voicebox");
assert.strictEqual(voiceEngine({ VOICE_ENGINE: " VoiceBox " }), "voicebox");
assert.strictEqual(voiceEngine({ VOICE_ENGINE: "anything" }), "omnivoice");

// a channel's job: its designed narrator (no cloned recording), only the characters its lines use
const storyLines = [
  { name: "segment_0_s01", text: "बहुत समय पहले की बात है।" },
  { name: "segment_1_s02", text: "माँ! मुझे डर लग रहा है!", speaker: "Child", emotion: "surprise" },
  { name: "segment_2_s03", text: "मेरा छोटू आ गया!", speaker: "old-mother" },
  { name: "segment_3_s04", text: "कोई अनजान आदमी।", speaker: "stranger" },
  { name: "segment_4_s05", text: "कहानी खत्म।", speaker: "narrator" },
];
const job = buildOmniVoiceJob("lv-1", storyLines, { channelKey: "Storiyum", language: "hi", speed: "1.0" }, {});
assert.strictEqual(job.narrator, NARRATOR_VOICES.storiyum, "Storiyum's designed narrator");
assert.strictEqual(job.sample, undefined, "no cloned recording by default");
assert.strictEqual(narratorVoiceFor("infoonspot", { NARRATOR_VOICE_INFOONSPOT: " female, elderly, indian accent " }), "female, elderly, indian accent", "per-channel override");
assert.strictEqual(narratorVoiceFor("unknown", {}), NARRATOR_VOICES.codeorcap);
// VOICE_CLONE=on brings back the cloned voices from voiceProfiles.ts
const cloned = buildOmniVoiceJob("lv-1", storyLines, { channelKey: "Storiyum" }, { VOICE_CLONE: "on" });
assert.strictEqual(cloned.narrator, undefined);
assert.strictEqual(cloned.sample!.file, "pakizah.mp3", "Storiyum's clone is the Pakizah voice");
assert.strictEqual(cloned.sample!.end, 14.7);
assert.ok(cloned.sample!.text.length > 20, "the sample transcript is OmniVoice's ref_text");
assert.deepStrictEqual(Object.keys(job.characters).sort(), ["child", "old_mother"], "only the characters that speak");
assert.strictEqual(job.characters.child, CHARACTER_VOICES.child);
assert.deepStrictEqual(job.lines.map((l) => l.speaker), [undefined, "child", "old_mother", undefined, undefined], "unknown speakers and the narrator use the narrator voice");
assert.strictEqual(job.lines[1].emotion, "surprise", "the emotion reaches the runner");
assert.strictEqual(job.format, "mp3");

// a channel without a profile falls back to CodeOrCap's voice
assert.strictEqual(buildOmniVoiceJob("x", [], { channelKey: "unknown" }, { VOICE_CLONE: "on" }).sample!.file, "paddy1_clean.mp3");
assert.strictEqual(characterKey("Old Woman"), "old_woman");
assert.strictEqual(characterKey(""), undefined);

// scenes carry their speaker into the narration lines
assert.deepStrictEqual(sceneLines([{ id: "s01", text: "नमस्ते", speaker: "girl" }, { id: "s02", text: "हाँ" }]), [
  { name: "segment_0_s01", text: "नमस्ते", speaker: "girl" },
  { name: "segment_1_s02", text: "हाँ" },
]);

// Kaggle: status parsing, the job embedded in the runner, private GPU kernels on separate dev/prod slots
assert.strictEqual(parseKernelStatus('spam2kaggle/ov-slot-1 has status "KernelWorkerStatus.COMPLETE"'), "complete");
assert.strictEqual(parseKernelStatus('x has status "KernelWorkerStatus.RUNNING"\n'), "running");
assert.strictEqual(parseKernelStatus('x has status "error"'), "error");
assert.strictEqual(parseKernelStatus("garbage"), "unknown");

const runner = fs.readFileSync(path.join(__dirname, "../scripts/omnivoice_runner.py"), "utf8");
const embedded = embedJob(runner, job);
assert.ok(!embedded.includes("JOB_JSON = None"));
const literal = /JOB_JSON = json\.loads\((".*")\)/.exec(embedded);
assert.ok(literal, "the job is a JSON string literal");
assert.deepStrictEqual(JSON.parse(JSON.parse(literal![1])), JSON.parse(JSON.stringify(job)), "the job survives the round trip (Devanagari, quotes)");
assert.throws(() => embedJob("print(1)", job), /JOB_JSON marker/);

assert.deepStrictEqual(kaggleSlots({}), ["ov-slot-1", "ov-slot-2"]);
assert.deepStrictEqual(kaggleSlots({ BOT_ENV: "dev", KAGGLE_SLOTS: "3" }), ["ov-dev-slot-1", "ov-dev-slot-2", "ov-dev-slot-3"]);
assert.strictEqual(kaggleSlots({ KAGGLE_SLOTS: "99" }).length, 4, "capped");
const meta = kernelMetadata("ov-dev-slot-1", { KAGGLE_USERNAME: "someone" });
assert.strictEqual(meta.id, "someone/ov-dev-slot-1");
assert.strictEqual(meta.is_private, true);
assert.strictEqual(meta.enable_gpu, true);
assert.deepStrictEqual(meta.dataset_sources, ["someone/voice-samples"]);

console.log("omnivoice tests passed");

// story dialogue: the planner's scenes get the speaker of the line they are; mixed scenes stay with the narrator
import { assignSpeakers, tagSpeakers } from "../src/audio/omnivoice/speakers";
(async () => {
  const scenes = assignSpeakers(
    [
      { text: "उस रात घर में सिर्फ़ एक रोटी बची थी।" },
      { text: "माँ, तुमने खाना खाया?" },
      { text: "माँ ने कहा, हाँ बेटा, मैंने खा लिया। और वो मुस्कुरा दी, पर उसकी आँखें नम थीं।" },
    ],
    [{ speaker: "child", text: "माँ, तुमने खाना खाया?" }, { speaker: "mother", text: "हाँ बेटा, मैंने खा लिया।" }],
  );
  assert.deepStrictEqual(scenes.map((x) => (x as any).speaker), [undefined, "child", undefined]);

  const story = "उस रात घर में सिर्फ़ एक रोटी बची थी। माँ, तुमने खाना खाया? हाँ बेटा, मैंने खा लिया। छोटू सो गया।";
  const tagged = await tagSpeakers(story, async () => 'sure: [{"n": 2, "speaker": "Child"}, {"n": 3, "speaker": "old woman"}, {"n": 9, "speaker": "child"}, {"n": 4, "speaker": "dragon"}]');
  assert.deepStrictEqual(tagged, [{ speaker: "child", text: "माँ, तुमने खाना खाया?" }, { speaker: "old_woman", text: "हाँ बेटा, मैंने खा लिया।" }], "out-of-range and unknown voices are dropped");
  assert.deepStrictEqual(await tagSpeakers(story, async () => { throw new Error("down"); }), [], "an LLM failure narrates everything");
  assert.deepStrictEqual(await tagSpeakers(story, async () => '[{"n":1,"speaker":"child"},{"n":2,"speaker":"child"},{"n":3,"speaker":"child"}]'), [], "almost all dialogue = misread, narrate all");
  console.log("omnivoice speaker tests passed");
})().catch((err) => { console.error(err); process.exit(1); });
