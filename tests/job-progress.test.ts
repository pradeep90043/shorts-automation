import assert from "assert";
import { ProgressTracker, StageStats } from "../src/utils/jobProgress";

// 25 real log lines of a finished Prompt Gag Short (dev run, 22 minutes), replayed with their real times
const RUN: Array<[string, string, string, string]> = [
  ["15:04:03", "info", "Notify", "[PromptGag] Injected reel, downloading... (gen-1792316043523-250)"],
  ["15:04:03", "info", "ChannelWatcher", "[PromptGag] Interactive manual ingest triggered for reel @manual_inject/Dd9SV8HNFFO (jobId: gen-1792316043523-250)"],
  ["15:04:07", "info", "Pipeline", "✓ Instagram frame ready (video) — starting pipeline (/app/temp/gen-1792316043523-250/original.jpg)"],
  ["15:04:30", "info", "DirectUploader", "Running unified AI vision for metadata and branding detection…"],
  ["15:05:29", "info", "Pipeline", "✓ Unified AI vision completed (Metadata: \"Will RBI Hike Rates? Impact on Home Loans Explained 🏠\", Branding zones: 1)"],
  ["15:05:29", "info", "Shazam", "[Shazam] Running audio identification on reel_video.mp4..."],
  ["15:05:30", "info", "Shazam", "[Shazam] No commercial match found for reel_video.mp4 (likely royalty-free or original audio)"],
  ["15:05:30", "info", "DirectUploader", "Kicking off TTS generation asynchronously..."],
  ["15:05:30", "info", "ClonedVoice", "Cloned voice (prompt_gag): 6 line(s) -> GitHub Actions (give up after 20 min)"],
  ["15:05:30", "info", "Pipeline", "✓ ✓ Remotion rendering completed successfully"],
  ["15:19:51", "info", "ClonedVoice", "Cloned voice ready in 861s"],
  ["15:19:51", "info", "TTSService", "Cloned-voice voiceover (957 chars): 58.2s"],
  ["15:19:51", "info", "Pipeline", "[CloudShortRenderer] Dispatching short render for gen-1792316043523-250 to pradeep90043/shorts-automation-test (bundle: https://classroom-produces-rec"],
  ["15:21:05", "info", "Pipeline", "[CloudShortRenderer] Downloading artifact rendered-short-gen-1792316043523-250 (24298620 bytes)..."],
  ["15:21:07", "info", "Pipeline", "[CloudShortRenderer] ✓ Successfully retrieved cloud-rendered short: /app/temp/gen-1792316043523-250/video_final.mp4"],
  ["15:21:07", "info", "Shazam", "[Shazam] Running audio identification on video_final.mp4..."],
  ["15:21:08", "info", "Shazam", "[Shazam] No commercial match found for video_final.mp4 (likely royalty-free or original audio)"],
  ["15:21:08", "info", "DirectUploader", "Generating V2 transition clip explaining how it works (Pexels cinematic b-roll)..."],
  ["15:21:56", "info", "HowItWorksClip", "Rendering 5-scene clip with my-video (timeout 10 min)"],
  ["15:25:42", "info", "None", "[my-video] Downloading artifact video-hiw-c9cc8223-15 (4484645 bytes)..."],
  ["15:25:43", "info", "HowItWorksClip", "✓ my-video clip ready"],
  ["15:25:50", "info", "DirectUploader", "✓ Transition clip generated successfully (my-video)."],
  ["15:26:13", "info", "Pipeline", "✓ Verdict sequence appended (avatar mode, score: 10/10) (gen-1792316043523-250)"],
  ["15:26:13", "info", "Pipeline", "✓ Compilation complete — sending for manual review with 60s auto-publish timeout (gen-1792316043523-250)"],
  ["15:26:13", "info", "DirectUploader", "[DirectUploader] Manual injected reel (gen-1792316043523-250) — awaiting explicit user publish approval. Auto-publish timer DISABLED."],
  ["15:26:13", "info", "Pipeline", "✓ Job gen-1792316043523-250 completed successfully"]
];
const at = (hms: string) => {
  const [h, m, s] = hms.split(":").map(Number);
  return Date.UTC(2026, 9, 18, h, m, s);
};

const t = new ProgressTracker(new StageStats()); // no file: defaults
for (const [time, level, label, msg] of RUN) t.observe(msg, label, level, at(time));
const done = t.snapshot(at("15:30:00"))[0];

assert.strictEqual(done.id, "gen-1792316043523-250");
assert.strictEqual(done.channel, "PromptGag");
assert.strictEqual(done.state, "review", "a manual inject ends waiting for the owner");
assert.strictEqual(done.elapsedSec, 1330, "15:04:03 -> 15:26:13");
const by = Object.fromEntries(done.stages.map((s) => [s.id, s]));
for (const id of ["download", "prepare", "vision", "voice", "render", "v2", "assemble"]) assert.strictEqual(by[id].state, "done", id + " is done");
assert.strictEqual(by.publish.state, "pending");
assert.strictEqual(by.publish.typicalSec, 0, "a manual inject is published by the owner: no estimate");
assert.ok(/approve/.test(by.publish.label));
assert.ok(Math.abs((by.voice.durSec as number) - 861) <= 2, "voice took ~861 s, got " + by.voice.durSec);
assert.ok((by.v2.durSec as number) > 200 && (by.v2.durSec as number) < 330, "V2 clip ~4-5 min, got " + by.v2.durSec);
assert.strictEqual(done.etaRemainingSec, 0);
assert.strictEqual(done.current, undefined);

// mid-run: 15:12 the cloned voice is the stage that is running, ~6.5 minutes in
const t2 = new ProgressTracker(new StageStats());
for (const [time, level, label, msg] of RUN) if (time <= "15:12:00") t2.observe(msg, label, level, at(time));
const mid = t2.snapshot(at("15:12:00"))[0];
assert.strictEqual(mid.state, "running");
assert.strictEqual(mid.current?.id, "voice");
assert.strictEqual(mid.current?.sinceSec, 390);
assert.strictEqual(mid.current?.slow, false);
// remaining = voice (860-390) + render 150 + v2 330 + assemble 90
assert.strictEqual(mid.etaRemainingSec, 470 + 150 + 330 + 90);
assert.strictEqual(mid.etaTotalSec, mid.elapsedSec + (mid.etaRemainingSec as number));

// a stage far past its typical time is flagged as slow, with the overrun
const slow = t2.snapshot(at("15:40:00"))[0];
assert.strictEqual(slow.current?.slow, true);
assert.ok((slow.stages.find((s) => s.id === "voice")!.overrunSec as number) > 600);

// background noise (the long-video worker's heartbeat) is not "what this job is doing"
t2.observe("[AutoLong][tick] blocked; 0 queued, 0 done, 0 failed", "AutoLong", "info", at("15:12:30"));
assert.ok(!/AutoLong/.test(t2.snapshot(at("15:12:31"))[0].current?.detail ?? ""));

// a restart cancels the running job and says why
t2.observe("Cancelled old job gen-1792316043523-250 on startup.", "DirectUploader", "info", at("15:41:00"));
const cancelled = t2.snapshot(at("15:41:30"))[0];
assert.strictEqual(cancelled.state, "failed");
assert.ok(/restarted/.test(cancelled.note || ""));

// learning: after real runs the typical time becomes their median (needs 2+ samples)
const st = new StageStats();
st.record("voice", 800); st.record("voice", 900); st.record("voice", 1000);
assert.strictEqual(st.typical("voice", 860), 900);
assert.strictEqual(new StageStats().typical("voice", 860), 860);
console.log("✓ job progress");
