import assert from "assert";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { dueSlot, istMinute, mythSlots, mythologyChannels } from "../src/mythology";
import { mythSceneSvg, renderMythShort, timeline, XFADE } from "../src/mythology/render";
import { mostlyDevanagari, mythDescription, parseMythScript } from "../src/mythology/script";
import { MYTH_TOPICS, pickTopic } from "../src/mythology/topics";

// topics: unique ids, never a told one while untold remain, then the oldest
assert.strictEqual(new Set(MYTH_TOPICS.map((t) => t.id)).size, MYTH_TOPICS.length);
const few = MYTH_TOPICS.slice(0, 3);
assert.strictEqual(pickTopic(["karna-kavach", "barbarik"], [], few).id, "eklavya-thumb");
assert.strictEqual(pickTopic(["barbarik", "karna-kavach", "eklavya-thumb"], [], few).id, "barbarik");
assert.strictEqual(pickTopic(["barbarik", "karna-kavach", "eklavya-thumb"], ["barbarik"], few).id, "karna-kavach");

// switches and slots
assert.deepStrictEqual(mythologyChannels({}), ["prompt_gag"]);
assert.deepStrictEqual(mythologyChannels({ MYTHOLOGY_CHANNELS: "off" }), []);
const slots = mythSlots("prompt_gag", {});
assert.strictEqual(slots.length, 2);
assert.ok(slots[0] < slots[1] && slots[1] - slots[0] >= 6 * 60, `spread over the day: ${slots}`);
assert.deepStrictEqual(slots, [9 * 60 + 40, 19 * 60 + 40], "09:40 and 19:40");
assert.strictEqual(mythSlots("prompt_gag", { MYTHOLOGY_PER_DAY: "5" }).length, 4, "at most the channel's 4 slots");
const at = (min: number) => Date.UTC(2026, 9, 27, 0, 0) - 5.5 * 3600_000 + min * 60_000; // IST minute -> epoch ms
assert.strictEqual(istMinute(at(510)), 510);
assert.strictEqual(dueSlot([510, 1230], [], at(400), 50), null, "too early");
assert.strictEqual(dueSlot([510, 1230], [], at(470), 50), 510);
assert.strictEqual(dueSlot([510, 1230], [510], at(470), 50), null, "done");
assert.strictEqual(dueSlot([510, 1230], [], at(700), 50), null, "more than 2 h late");

// script parsing
const line = "कर्ण ने अपना कवच और कुंडल इंद्र को दान कर दिए, यह जानते हुए कि इससे उसकी मृत्यु निश्चित हो जाएगी।";
const good = JSON.stringify({ title: "Why Karna Gave Away His Armour 😱 | कर्ण का कवच", hook: "कर्ण का सबसे बड़ा दान", description: "एक दान की कथा।", tags: ["karna"],
  scenes: Array.from({ length: 7 }, (_, i) => ({ narration: line, caption: `दृश्य ${i + 1}`, image: "a warrior at dawn" })) });
const s = parseMythScript("here: " + good);
assert.ok(s && s.scenes.length === 7 && s.hook === "कर्ण का सबसे बड़ा दान");
assert.strictEqual(parseMythScript(good.replace(/कर्ण ने अपना कवच और कुंडल इंद्र को दान कर दिए, यह जानते हुए कि इससे उसकी मृत्यु निश्चित हो जाएगी।/g, "Karna gave his armour away")), null, "Roman narration is rejected");
assert.ok(mostlyDevanagari(line) && !mostlyDevanagari("Karna ne kavach diya"));
assert.ok(mythDescription(s!, MYTH_TOPICS[0]).includes("स्रोत: Mahabharata, Vana Parva"));
assert.ok(mythSceneSvg({ narration: "", caption: "A & B", image: "" }, { hook: "हुक" }).includes("A &amp; B"));

// timeline: clips overlap by XFADE and the film is exactly as long as the voice
const tl = timeline([4, 5, 3]);
assert.deepStrictEqual(tl.starts, [0, 4, 9]);
assert.deepStrictEqual(tl.offsets, [4 - XFADE, 9 - XFADE]);
assert.strictEqual(tl.total, 12);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myth-"));
  const voices = s!.scenes.map((_, i) => {
    const f = path.join(dir, `v${i}.mp3`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=${220 + i * 30}:duration=${2 + (i % 3) * 0.5}`, f]);
    return f;
  });
  const out = await renderMythShort(s!, { tempDir: path.join(dir, "w"), out: path.join(dir, "o.mp4"), voices, handle: "@promptgag1", noAi: true });
  const p = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-show_entries", "format=duration", "-of", "json", out]).toString());
  assert.ok(p.streams.some((x: any) => x.codec_type === "video" && x.width === 1080 && x.height === 1920));
  assert.ok(p.streams.some((x: any) => x.codec_type === "audio"));
  // the film is exactly as long as the processed voice lines (pitch-shifted, ~3% faster, plus air after each)
  const sec = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f]).toString());
  const expected = voices.reduce((t, _f, i) => t + sec(path.join(dir, "w", `vx${i}.wav`)), 0);
  assert.ok(Math.abs(sec(path.join(dir, "w", "vx0.wav")) - (sec(voices[0]) / 1.026 + 0.25)) < 0.2, "the voice chain keeps the line's length (~3% faster)");
  assert.ok(Math.abs(Number(p.format.duration) - expected) < 0.1, `duration ${p.format.duration} vs ${expected}`);
  console.log("mythology: ok", out);
})().catch((e) => { console.error(e); process.exit(1); });
