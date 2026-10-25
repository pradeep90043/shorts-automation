import assert from "assert";
import { execFile, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { parseImageVoice, renderImageVoice, sceneSvg } from "../src/formats/imageVoice";
import { pickMusicBed } from "../src/formats/listCard";

const ok = parseImageVoice('x {"title":"Lemon farming math","scenes":[{"narration":"One acre.","caption":"1 acre","image":"orchard","stat":"1 acre"},{"narration":"Two","caption":"two"},{"narration":"Three","caption":"three"},{"narration":"","caption":"dropped"}]}');
assert.ok(ok && ok.scenes.length === 3 && ok.scenes[1].image === "two" && ok.scenes[0].stat === "1 acre");
assert.strictEqual(parseImageVoice('{"title":"t","scenes":[{"narration":"a","caption":"b"}]}'), null, "needs 3 scenes");
assert.strictEqual(parseImageVoice("nope"), null);
assert.ok(sceneSvg({ narration: "n", caption: "A & B", image: "i", stat: "₹5-15 lakh" }, "#fb0").includes("A &amp; B"));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imgvoice-"));
  // a stand-in TTS: a tone whose length depends on the text, so the test needs no network
  const tts = (text: string, file: string) =>
    new Promise<number>((resolve, reject) => {
      const sec = 1.2 + text.length / 40;
      execFile("ffmpeg", ["-y", "-f", "lavfi", "-i", `sine=frequency=330:duration=${sec}`, "-c:a", "libmp3lame", file], (e) => (e ? reject(e) : resolve(sec)));
    });
  const out = await renderImageVoice(ok!, { brandKey: "codeorcap", tempDir: path.join(dir, "w"), tts, bed: pickMusicBed("t"), out: path.join(dir, "o.mp4"), noAi: true });
  const p = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-show_entries", "format=duration", "-of", "json", out]).toString());
  const expected = (1.2 + 10 / 40) + (1.2 + 3 / 40) + (1.2 + 5 / 40) + 3 * 0.4;
  assert.ok(Math.abs(Number(p.format.duration) - expected) < 0.6, `duration ${p.format.duration} vs ${expected}`);
  assert.ok(p.streams.some((s: any) => s.codec_type === "video" && s.width === 1080 && s.height === 1920));
  assert.ok(p.streams.some((s: any) => s.codec_type === "audio"));
  console.log("image-voice: ok", out);
})().catch((e) => { console.error(e); process.exit(1); });
