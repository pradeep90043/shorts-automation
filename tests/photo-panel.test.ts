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

import { addNamedPhotoRequests } from "../src/my-video/stickmanPlanner";
{
  const sc: any[] = [
    { id: "a", text: "सुप्रीम कोर्ट ने फैसला सुनाया", visual: {} },
    { id: "b", text: "आरबीआई ने दर बदली", visual: {} },
    { id: "c", text: "कुछ और बात", visual: {} },
  ];
  assert.strictEqual(addNamedPhotoRequests(sc), 1, "only one of two neighbouring beats");
  assert.strictEqual(sc[0].visual.photoQuery.query, "Supreme Court of India");
  console.log("✓ named photo requests");
}
