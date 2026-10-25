import assert from "assert";
import { formatReportTable, summarizeFormats } from "../src/formats/formatReport";

const s = summarizeFormats(
  [
    { format: "image_music", views: 100, likes: 5 }, { format: "image_music", views: 300, likes: 15 }, { format: "image_music", views: 200, likes: 10 },
    { format: "stickman", views: 10, likes: 0 }, { format: "stickman", views: 20, likes: 1 },
  ],
  [10, 20, 30, 40, 50],
);
assert.strictEqual(s[0].format, "image_music", "best median first");
assert.strictEqual(s[0].n, 3);
assert.strictEqual(s[0].median, 200);
assert.strictEqual(s[0].mean, 200);
assert.ok(Math.abs(s[0].likesPerView - 0.05) < 1e-9);
assert.ok(Math.abs(s[0].vsBaseline - 200 / 30) < 1e-9, "median 200 against baseline median 30");
assert.strictEqual(s[1].median, 15);
assert.strictEqual(summarizeFormats([]).length, 0);
assert.strictEqual(summarizeFormats([{ format: "a", views: 5 }])[0].vsBaseline, 0, "no baseline -> no ratio");
assert.ok(formatReportTable(s).split("\n").length === 3);
console.log("format-report: ok");
