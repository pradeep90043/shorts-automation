import assert from "assert";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { cardSvg, listCardFromLines, listCardPrompt, parseListCard, pickMusicBed, renderListCardPng, renderStillReel } from "../src/formats/listCard";

// the LLM answer: JSON is found inside chatter, clamped and validated
const good = parseListCard('Sure! {"title":"1 acre lemon farming: ₹5-15 lakh a year?","rows":[{"label":"Plants","value":"250-300"},{"label":"Yield","value":"15-25 tonnes"},{"label":"Price","value":"₹20-60/kg"},{"label":"","value":"x"}],"closing":"Estimates only.","image":"lemon orchard"} done');
assert.ok(good && good.rows.length === 3 && good.closing === "Estimates only." && good.image === "lemon orchard", "valid card parsed, empty row dropped");
assert.strictEqual(parseListCard("no json here"), null);
assert.strictEqual(parseListCard('{"title":"x","rows":[{"label":"a","value":"b"}]}'), null, "needs at least 3 rows");
assert.strictEqual(parseListCard('{"title":"","rows":[]}'), null);
const long = parseListCard(JSON.stringify({ title: "T".repeat(200), rows: Array.from({ length: 12 }, (_, i) => ({ label: "L".repeat(80) + i, value: "V".repeat(80) })) }));
assert.ok(long && long.title.length <= 60 && long.rows.length === 10 && long.rows.every((r) => r.label.length <= 26 && r.value.length <= 22), "lengths and row count clamped");

// OCR-style fallback
const ocr = "सोने का अंडा देने वाला\nपौधे :- 250 से 300\nउत्पादन शुरू :- 2-3 साल बाद\nसालाना उत्पादन :- 15 से 25 टन\nबिक्री :- 20 से 60 रु/किलो";
const fb = listCardFromLines(ocr, "Lemon farming");
assert.ok(fb && fb.rows.length === 4 && fb.rows[0].label === "पौधे" && fb.rows[0].value === "250 से 300");
assert.strictEqual(listCardFromLines("just a sentence", "t"), null);
assert.ok(listCardPrompt("m", true).includes("Devanagari") && listCardPrompt("m", false).includes("English"));

// layout: every row and the title are in the SVG, text is escaped
const svg = cardSvg({ title: "A & B <deal>", rows: [{ label: "a", value: "1" }, { label: "b", value: "2" }, { label: "c", value: "3" }], image: "x" }, "#FFB800", "footer");
assert.ok(svg.includes("A &amp; B &lt;deal&gt;") && svg.includes("footer") && (svg.match(/<text /g) || []).length >= 8);

// bed choice is stable per seed and the file exists
assert.strictEqual(pickMusicBed("abc"), pickMusicBed("abc"));
assert.ok(fs.existsSync(pickMusicBed("zzz")));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listcard-"));
  const png = await renderListCardPng(fb!, "codeorcap", path.join(dir, "c.png"), { background: null, footer: "test" });
  assert.ok(fs.statSync(png).size > 20_000, "card PNG written");
  const mp4 = await renderStillReel(png, pickMusicBed("abc"), path.join(dir, "r.mp4"), 4);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-show_entries", "format=duration", "-of", "json", mp4]).toString());
  const dur = Number(probe.format.duration);
  assert.ok(dur > 3.9 && dur < 4.2, `duration ${dur}`);
  assert.ok(probe.streams.some((s: any) => s.codec_type === "video" && s.width === 1080 && s.height === 1920));
  assert.ok(probe.streams.some((s: any) => s.codec_type === "audio"));
  console.log("list-card: ok", mp4);
})().catch((e) => { console.error(e); process.exit(1); });

// Pexels answer -> the portrait crop first, nothing when there is no photo
import { pexelsPhotoUrl } from "../src/cover/coverImage";
assert.strictEqual(pexelsPhotoUrl({ photos: [{ src: { portrait: "p.jpg", large2x: "l.jpg", landscape: "w.jpg" } }] }, "portrait"), "p.jpg");
assert.strictEqual(pexelsPhotoUrl({ photos: [{ src: { portrait: "p.jpg", landscape: "w.jpg" } }] }, "landscape"), "w.jpg");
assert.strictEqual(pexelsPhotoUrl({ photos: [] }, "portrait"), null);
assert.strictEqual(pexelsPhotoUrl(null, "portrait"), null);
