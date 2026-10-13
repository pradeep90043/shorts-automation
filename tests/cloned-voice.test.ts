import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { config } from "../src/config";
import { audioDuration, rateToTempo, retimeAudio } from "../src/audio/retime";
import { clonedVoiceEnabled, clonedVoiceProfile, spokenText } from "../src/audio/clonedVoice";
import { VERDICT_WINDOWS, buildClonedVerdictAudio, clonedVerdictAvailable, verdictNumber, verdictTempo } from "../src/audio/clonedVerdict";
import { TTSService } from "../src/audio/tts";
import { buildHowItWorksSpec, howItWorksLines } from "../src/my-video/howItWorksClip";

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cloned-voice-"));
  try {
    // ── speed fitting ──
    assert.strictEqual(rateToTempo("+25%"), 1.25);
    assert.strictEqual(rateToTempo("-10%"), 0.9);
    assert.strictEqual(rateToTempo(undefined), 1);
    assert.strictEqual(verdictTempo(1.0, 1.0), 1);
    assert.strictEqual(verdictTempo(3, 1), 1.3, "never faster than 1.3x");
    assert.strictEqual(verdictTempo(0.3, 1), 0.9, "never slower than 0.9x: a short phrase is not stretched");
    assert.ok(Math.abs(verdictTempo(1.44, 1.4) - 1.0286) < 1e-3);
    assert.strictEqual(verdictNumber(0.2), 1);
    assert.strictEqual(verdictNumber(6.6), 7);
    assert.strictEqual(verdictNumber(42), 10);

    // ── Storiyum speaks Hindi with its own sample; CodeOrCap keeps the default one ──
    process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || "x";
    assert.ok(clonedVoiceEnabled("storiyum") && clonedVoiceEnabled("codeorcap") && !clonedVoiceEnabled("other"));
    assert.strictEqual(clonedVoiceProfile("Storiyum")?.language, "hi");
    assert.strictEqual(clonedVoiceProfile("storiyum")?.inputs.sample_path, "assets/voice-samples/storiyum_female.mp3");
    assert.ok(fs.existsSync(path.join(config.paths.assetsDir, "voice-samples", "storiyum_female.mp3")), "the sample ships in the repo");
    assert.strictEqual(clonedVoiceProfile("codeorcap")?.inputs.sample_path, undefined);

    // ── text for the voice ──
    assert.strictEqual(spokenText("Wow 🔥 check https://x.co/a now #AI @bob **bold**"), "Wow check now bold");

    // ── the clip narrates exactly the lines the cloud run is asked to speak ──
    const explanation = "The model reads your prompt. It predicts the next token. Then it repeats until the answer is done.";
    const lines = howItWorksLines(explanation);
    const spec = buildHowItWorksSpec({ explanation }, "t");
    assert.strictEqual(lines.length, spec.scenes.length, "one voiced line per scene");
    assert.deepStrictEqual(spec.scenes.map((s) => s.text), lines);

    // ── a registered cloned clip is retimed instead of re-synthesised ──
    const clip = path.join(tmp, "claim.mp3");
    execFileSync(config.binaries.ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=5", "-codec:a", "libmp3lame", clip]);
    const tts = new TTSService();
    tts.registerCloned("codeorcap", "the claim script", Promise.resolve(clip));
    assert.ok(tts.hasCloned("codeorcap", "the claim script"));
    const natural = await tts.generateVoiceover("the claim script", path.join(tmp, "v1.mp3"), "codeorcap");
    assert.ok(Math.abs(natural - 5) < 0.15, `natural ${natural}`);
    const faster = await tts.generateVoiceover("the claim script", path.join(tmp, "v2.mp3"), "codeorcap", "+25%");
    assert.ok(Math.abs(faster - 4) < 0.15, `+25% -> ${faster}`);
    const slower = await tts.generateVoiceover("the claim script", path.join(tmp, "v3.mp3"), "codeorcap", "-20%");
    assert.ok(Math.abs(slower - 6.25) < 0.2, `-20% -> ${slower}`);
    assert.ok(Math.abs((await retimeAudio(clip, path.join(tmp, "v4.mp3"), 2)) - 2.5) < 0.15);

    // ── the cloned verdict, built from the real assets ──
    assert.ok(clonedVerdictAvailable(), "the cloned verdict assets are in assets/verdict-clips/cloned");
    const out = path.join(tmp, "verdict.wav");
    for (const score of [1, 6, 10]) {
      const built = await buildClonedVerdictAudio(score, out);
      assert.strictEqual(built, out);
      assert.ok(Math.abs((await audioDuration(out)) - 9.54) < 0.05, "exactly the clip length");
    }
    await buildClonedVerdictAudio(6, out, undefined, 8);
    assert.ok(Math.abs((await audioDuration(out)) - 8) < 0.05, "the length the pipeline asks for");
    await buildClonedVerdictAudio(6, out);
    const level = (from: number, len: number): number => {
      const res = spawnSync(config.binaries.ffmpeg, ["-hide_banner", "-nostats", "-ss", String(from), "-t", String(len), "-i", out, "-af", "astats=measure_overall=RMS_level", "-f", "null", "-"], { encoding: "utf-8" });
      const m = /RMS level dB: (-?[\d.inf]+)/.exec(String(res.stderr));
      return m ? (m[1] === "-inf" ? -120 : parseFloat(m[1])) : -120;
    };
    // voice where his lips move: p1, the score in the pause, "out of ten", the caption line, the follow line
    for (const [name, w] of Object.entries(VERDICT_WINDOWS)) {
      const mid = w.start + Math.min(w.window, 0.6) * 0.5;
      assert.ok(level(mid - 0.1, 0.2) > -45, `voice at "${name}" (${mid.toFixed(2)} s): ${level(mid - 0.1, 0.2)} dB`);
    }
    // silence where nobody speaks: before the first word and in the gap between the caption line and the follow line
    assert.ok(level(0, 0.45) < -60, "silent before the first word");
    assert.ok(level(6.0, 0.5) < -60, "silent between the caption line and the follow line");
    assert.strictEqual(await buildClonedVerdictAudio(6, out, path.join(tmp, "nothing-here")), null, "missing assets: null, the recorded audio is kept");

    console.log("✓ cloned voice");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
