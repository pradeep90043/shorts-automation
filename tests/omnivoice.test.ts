import assert from "assert";
import fs from "fs";
import path from "path";
import { buildOmniVoiceJob, characterKey, CHARACTER_VOICES } from "../src/audio/omnivoice/job";
import { embedJob, kaggleSlots, kernelMetadata, parseKernelStatus } from "../src/audio/omnivoice/kaggleRunner";
import { voiceEngine } from "../src/audio/narration";
import { sceneLines } from "../src/my-video/voiceboxNarration";

// the engine: OmniVoice unless the emergency switch brings Voicebox back
assert.strictEqual(voiceEngine({}), "omnivoice");
assert.strictEqual(voiceEngine({ VOICE_ENGINE: "voicebox" }), "voicebox");
assert.strictEqual(voiceEngine({ VOICE_ENGINE: " VoiceBox " }), "voicebox");
assert.strictEqual(voiceEngine({ VOICE_ENGINE: "anything" }), "omnivoice");

// a channel's job: its cloned narrator from voiceProfiles.ts, only the characters its lines use
const job = buildOmniVoiceJob("lv-1", [
  { name: "segment_0_s01", text: "बहुत समय पहले की बात है।" },
  { name: "segment_1_s02", text: "माँ! मुझे डर लग रहा है!", speaker: "Child", emotion: "surprise" },
  { name: "segment_2_s03", text: "मेरा छोटू आ गया!", speaker: "old-mother" },
  { name: "segment_3_s04", text: "कोई अनजान आदमी।", speaker: "stranger" },
  { name: "segment_4_s05", text: "कहानी खत्म।", speaker: "narrator" },
], { channelKey: "Storiyum", language: "hi", speed: "1.0" });
assert.strictEqual(job.sample.file, "pakizah.mp3", "Storiyum narrates in the Pakizah voice");
assert.strictEqual(job.sample.end, 14.7);
assert.ok(job.sample.text.length > 20, "the sample transcript is OmniVoice's ref_text");
assert.deepStrictEqual(Object.keys(job.characters).sort(), ["child", "old_mother"], "only the characters that speak");
assert.strictEqual(job.characters.child, CHARACTER_VOICES.child);
assert.deepStrictEqual(job.lines.map((l) => l.speaker), [undefined, "child", "old_mother", undefined, undefined], "unknown speakers and the narrator use the cloned voice");
assert.strictEqual(job.lines[1].emotion, "surprise", "the emotion reaches the runner");
assert.strictEqual(job.format, "mp3");

// a channel without a profile falls back to CodeOrCap's voice
assert.strictEqual(buildOmniVoiceJob("x", [], { channelKey: "unknown" }).sample.file, "paddy1_clean.mp3");
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
