import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { buildCardHtml, renderListCardHtml } from "../src/formats/htmlCardRenderer";
import { ListCardContent } from "../src/formats/listCard";

const c: ListCardContent = {
  title: "5 Career Mistakes <deal>",
  rows: [
    { label: "Focusing solely on salary", value: "instead of learning" },
    { label: "Not networking", value: "start early" },
    { label: "Afraid to ask questions", value: "ask proactively" },
  ],
  closing: "First two years matter most.",
  image: "career advice photo",
};

// 1. buildCardHtml unit tests
const html = buildCardHtml(c, "#FFB800", { footer: "@CodeOrCap" });
assert.ok(html.includes("5 Career Mistakes &lt;deal&gt;"), "title escaped");
assert.ok(html.includes("@CodeOrCap"), "footer present");
assert.ok(html.includes("Focusing solely on salary"), "row label present");
assert.ok(html.includes("card-box"), "card container present");

// 2. renderListCardHtml end-to-end test (headless Puppeteer)
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "htmlcard-test-"));
  const outPng = path.join(dir, "out.png");

  try {
    await renderListCardHtml(c, "#FFB800", outPng, { footer: "@CodeOrCap" });
    assert.ok(fs.existsSync(outPng), "file created");

    const meta = await sharp(outPng).metadata();
    assert.strictEqual(meta.width, 1080, "width is 1080");
    assert.strictEqual(meta.height, 1920, "height is 1920");
    const fileSize = fs.statSync(outPng).size;
    assert.ok(fileSize > 20_000, `file size is reasonable: ${fileSize}`);

    console.log("html-card: ok", outPng);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error("html-card test failed:", err);
  process.exit(1);
});
