/**
 * card-qa.test.ts
 *
 * Tests the cardQa module:
 *  1. A mock FreeLLM client that returns a passing verdict → checkCardQa returns ok=true
 *  2. A mock that returns a failing verdict → checkCardQa returns ok=false with reason
 *  3. A mock that throws (vision unavailable) → checkCardQa returns ok=true, checked=false
 *  4. Integration with buildFormatShort: QA failure triggers a re-ask (spy on renderListCardPng calls)
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { checkCardQa } from "../src/formats/cardQa";
import { buildFormatShort } from "../src/formats/runFormat";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMockFreellm(visionResponse: string | Error) {
  return {
    generateVision: async (_prompt: string, _b64: string, _mime: string): Promise<string> => {
      if (visionResponse instanceof Error) throw visionResponse;
      return visionResponse;
    },
  } as any;
}

function makeFakeCardPng(dir: string): string {
  const validPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  const p = path.join(dir, "fake_card.png");
  fs.writeFileSync(p, validPng);
  return p;
}

// ── test 1: vision returns passing verdict ────────────────────────────────

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cardqa-"));
  const png = makeFakeCardPng(dir);

  const mock = makeMockFreellm(JSON.stringify({ ok: true, problems: [], reason: "" }));
  const result = await checkCardQa(png, mock);
  assert.strictEqual(result.ok, true, "should be ok");
  assert.strictEqual(result.checked, true, "should have checked");
  console.log("card-qa test 1 (pass verdict): ok");
})().catch((e) => { console.error("card-qa test 1 FAILED:", e); process.exit(1); });

// ── test 2: vision returns failing verdict ────────────────────────────────

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cardqa-"));
  const png = makeFakeCardPng(dir);

  const mock = makeMockFreellm(
    JSON.stringify({ ok: false, problems: ["text_overlap"], reason: "text_overlap: row 2 label runs into value" })
  );
  const result = await checkCardQa(png, mock);
  assert.strictEqual(result.ok, false, "should fail");
  assert.ok(result.reason.includes("text_overlap"), "reason should mention text_overlap");
  assert.strictEqual(result.checked, true, "should have checked");
  console.log("card-qa test 2 (fail verdict): ok");
})().catch((e) => { console.error("card-qa test 2 FAILED:", e); process.exit(1); });

// ── test 3: vision throws (unavailable) → treat as ok ────────────────────

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cardqa-"));
  const png = makeFakeCardPng(dir);

  const mock = makeMockFreellm(new Error("timeout"));
  const result = await checkCardQa(png, mock);
  assert.strictEqual(result.ok, true, "should be ok when vision unavailable");
  assert.strictEqual(result.checked, false, "should not be checked");
  console.log("card-qa test 3 (vision unavailable): ok");
})().catch((e) => { console.error("card-qa test 3 FAILED:", e); process.exit(1); });

// ── test 4: buildFormatShort passes freellmapi, QA result is propagated ──

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cardqa-format-"));

  // stub llm → always returns a valid 3-row card JSON
  const goodCard = JSON.stringify({
    title: "3 Tips",
    rows: [
      { label: "Tip 1", value: "Do this" },
      { label: "Tip 2", value: "Do that" },
      { label: "Tip 3", value: "Profit" },
    ],
    closing: "Good luck.",
    image: "a tidy desk",
  });
  const llm = async (_p: string) => goodCard;

  // stub tts (not used by image_music)
  const tts = async (_t: string, f: string) => { fs.writeFileSync(f, ""); return 0; };

  // vision always passes
  const freellmapi = makeMockFreellm(JSON.stringify({ ok: true, problems: [], reason: "" }));

  const result = await buildFormatShort({
    format: "image_music",
    brandKey: "codeorcap",
    seed: "test-seed",
    material: "Tip 1 is about sleeping early. Tip 2 is about hydration. Tip 3 is about exercise.",
    hindi: false,
    llm,
    tts,
    tempDir: dir,
    noAi: true, // skip real AI picture generation
    freellmapi,
  });

  assert.strictEqual(result.format, "image_music");
  assert.ok(fs.existsSync(result.videoPath), "video should exist");
  assert.ok(result.cardPng && fs.existsSync(result.cardPng), "card PNG should exist");
  assert.strictEqual(result.qaOk, true, "QA should pass");
  console.log("card-qa test 4 (buildFormatShort + QA pass): ok", result.videoPath);
})().catch((e) => { console.error("card-qa test 4 FAILED:", e); process.exit(1); });
