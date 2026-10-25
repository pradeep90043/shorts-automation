import assert from "assert";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { askUntil, buildFormatShort } from "../src/formats/runFormat";

const card = JSON.stringify({ title: "Lemon farming: 1 acre", rows: [{ label: "Plants", value: "250-300" }, { label: "Yield", value: "15-25 t" }, { label: "Price", value: "₹20-60/kg" }], closing: "Estimates.", image: "orchard" });
const voice = JSON.stringify({ title: "Lemon math", scenes: [{ narration: "One acre of lemons.", caption: "1 acre", image: "orchard", stat: "1 acre" }, { narration: "Plants cost money first.", caption: "250-300 plants", image: "saplings" }, { narration: "Income comes later.", caption: "2-3 years", image: "tree" }] });
const tts = (text: string, file: string) => new Promise<number>((res, rej) => { const s = 1 + text.length / 40; execFile("ffmpeg", ["-y", "-f", "lavfi", "-i", `sine=frequency=300:duration=${s}`, "-c:a", "libmp3lame", file], (e) => (e ? rej(e) : res(s))); });
const base = { brandKey: "codeorcap", seed: "abc", material: "Lemon farming on one acre needs 250 to 300 plants and pays after 2 to 3 years.", hindi: false, tts, noAi: true, cardSeconds: 3 };

(async () => {
  // retries until the answer parses
  let n = 0;
  const flaky = async () => (++n < 3 ? "thinking process..." : card);
  assert.ok(await askUntil(flaky, "p", (r) => (r.includes("{") ? r : null)));
  assert.strictEqual(n, 3);
  assert.strictEqual(await askUntil(async () => "no", "p", () => null, 2), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runfmt-"));
  const a = await buildFormatShort({ ...base, format: "image_music", llm: async () => card, tempDir: path.join(dir, "a") });
  assert.ok(fs.existsSync(a.videoPath) && a.cardPng && fs.existsSync(a.cardPng) && a.title === "Lemon farming: 1 acre");
  const m = await buildFormatShort({ ...base, format: "manual", llm: async () => card, tempDir: path.join(dir, "m") });
  assert.strictEqual(m.format, "manual");
  const v = await buildFormatShort({ ...base, format: "image_voice", llm: async () => voice, tempDir: path.join(dir, "v") });
  assert.ok(fs.existsSync(v.videoPath) && v.title === "Lemon math");

  // the LLM never answers: a static card falls back to the OCR lines, voice has no fallback and throws (caller uses the normal Short)
  const ocr = "Plants :- 250 to 300\nStart :- 2-3 years\nYield :- 15 to 25 t\nPrice :- 20 to 60";
  const f = await buildFormatShort({ ...base, format: "image_music", llm: async () => "nope", ocrText: ocr, title: "Lemon", tempDir: path.join(dir, "f") });
  assert.ok(fs.existsSync(f.videoPath));
  await assert.rejects(buildFormatShort({ ...base, format: "image_voice", llm: async () => "nope", tempDir: path.join(dir, "g") }));
  await assert.rejects(buildFormatShort({ ...base, format: "image_music", material: "short", llm: async () => card, tempDir: path.join(dir, "h") }), /not enough/);
  console.log("run-format: ok");
})().catch((e) => { console.error(e); process.exit(1); });
