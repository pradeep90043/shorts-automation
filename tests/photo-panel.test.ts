import assert from "assert";
import { sanitizeVisual, attachPhotos, type StickmanPlan } from "../src/my-video/stickmanPlanner";

(async () => {
  const v = sanitizeVisual({ setting: "city", photo: { query: "Reserve Bank of India Mumbai", caption: "RBI" }, callouts: ["x"] }, 0) as any;
  assert.strictEqual(v.photo.query, "Reserve Bank of India Mumbai");
  assert.ok(!sanitizeVisual({ photo: { query: "" } }, 0).photo, "empty query is dropped");

  // unresolved photo + PHOTOS=off keeps the plan as is
  process.env.PHOTOS = "off";
  const plan: StickmanPlan = { title: "t", description: "d", tags: [], aiVisuals: true, scenes: [{ id: "s01", text: "RBI", visual: { photoQuery: { query: "x" } } } as any] };
  assert.strictEqual((await attachPhotos(plan)).description, "d");
  console.log("✓ photo panel: sanitiser and attach");
})().catch((e) => { console.error(e); process.exit(1); });
