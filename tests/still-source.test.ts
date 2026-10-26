import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { frozenShare, isStillTextSource, stillFraction } from "../src/formats/stillSource";

(async () => {
  // log parsing: two freezes, the second still open at the end of a 10 s video
  const log = "Duration: 00:00:10.00, start\n[freezedetect] freeze_start: 0\n freeze_duration: 4\n freeze_end: 4\n[freezedetect] freeze_start: 6\n";
  assert.ok(Math.abs(frozenShare(log) - 0.8) < 1e-9);
  assert.strictEqual(frozenShare("no duration here"), 0);

  const text = "Top 10 highest paid jobs in India 2026: AI engineer 8-40 LPA, data scientist 8-35 LPA";
  assert.strictEqual(isStillTextSource(0.9, text), true);
  assert.strictEqual(isStillTextSource(0.3, text), false, "a moving reel keeps the normal Short");
  assert.strictEqual(isStillTextSource(0.9, "short"), false, "too little text to rebuild");
  assert.strictEqual(isStillTextSource(0.9, text, { STILL_SOURCE_CARD: "off" }), false);

  // real videos: a still picture vs a moving test pattern
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "still-"));
  const still = path.join(dir, "still.mp4"), moving = path.join(dir, "moving.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=540x960:d=6", "-vf", "drawbox=x=40:y=100:w=400:h=300:color=black", "-pix_fmt", "yuv420p", still]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=540x960:d=6", "-pix_fmt", "yuv420p", moving]);
  const s = await stillFraction(still, "ffmpeg"), m = await stillFraction(moving, "ffmpeg");
  assert.ok(s >= 0.9, `still video frozen share ${s}`);
  assert.ok(m <= 0.1, `moving video frozen share ${m}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`✓ still source (still ${s.toFixed(2)}, moving ${m.toFixed(2)})`);
})().catch((e) => { console.error(e); process.exit(1); });
