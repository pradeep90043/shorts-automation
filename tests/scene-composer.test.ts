import assert from "assert";
import fs from "fs";
import path from "path";
import { backgroundFor, matchAssets, sceneForSentence } from "../src/my-video/sceneComposer";
import { ASSET_KEYWORDS, SCENE_ASSETS } from "../src/my-video/sceneCatalog";
import { buildHowItWorksSpec } from "../src/my-video/howItWorksClip";
import { buildDirectorPrompt, sanitizeScene, sanitizeVisual } from "../src/my-video/stickmanPlanner";

const names = (text: string, max = 3) => matchAssets(text, max).map((m) => m.asset);

// the assets a sentence talks about, in the order it mentions them
assert.deepStrictEqual(names("AI data centers use liquid cooling to manage the intense heat of dense hardware."), ["server", "drop", "fire"]);
assert.deepStrictEqual(names("Water absorbs thermal energy from the chips before being evaporated."), ["drop", "fire", "chip"]);
assert.deepStrictEqual(names("This creates massive consumption at global scale."), ["globe", "chart"]);
// "data" inside "data centers" is not a second asset; "AI" alone does not steal a slot from concrete things
assert.ok(!names("AI data centers use liquid cooling").includes("database"));
assert.ok(!names("AI data centers use liquid cooling").includes("robot"));
// whole words only: "ai" must not match "air", "fan" must not match "fantastic"
assert.deepStrictEqual(names("The air is fantastic"), []);
// plural forms match, one person-family asset at most
assert.ok(names("Servers and users").includes("server"));
assert.ok(matchAssets("people are worried about the risk of failure and stress", 5).filter((m) => m.asset.startsWith("person")).length <= 1);
assert.strictEqual(backgroundFor("global scale of the world"), "sky");
assert.strictEqual(backgroundFor("nothing special here"), "paper");

// the illustration: layout by count, arrows between neighbours, labels from the sentence's own words
const three = sceneForSentence("AI data centers use liquid cooling to manage the intense heat.")!;
assert.deepStrictEqual(three.items.map((i) => i.x), [17, 50, 83]);
assert.strictEqual(three.arrows.length, 2);
assert.ok(three.arrows.every((a, i) => a.from[0] > three.items[i].x && a.to[0] < three.items[i + 1].x), "arrows run through the gaps");
assert.deepStrictEqual(three.items.map((i) => i.label), ["Data Centers", "Liquid", "Heat"]);
assert.strictEqual(sceneForSentence("Hmm well okay then.")!, null);
const one = sceneForSentence("The battery lasts longer.")!;
assert.deepStrictEqual([one.items.length, one.arrows.length, one.items[0].x], [1, 0, 50]);

// sanitizer: unknown assets dropped, numbers clamped, junk arrows removed
const clean = sanitizeScene({
  background: "volcano",
  items: [{ asset: "server", x: 140, y: -5, size: 500, label: "A very long label that will be cut off" }, { asset: "dragon", x: 10, y: 10 }, { asset: "drop", x: 60, y: 46, tint: "purple" }],
  arrows: [{ from: [10, 10], to: [90, 90] }, { from: [1], to: [2, 3] }, { from: ["a", "b"], to: [1, 2] }],
}) as any;
assert.strictEqual(clean.background, "paper");
assert.deepStrictEqual(clean.items.map((i: any) => i.asset), ["server", "drop"]);
assert.deepStrictEqual([clean.items[0].x, clean.items[0].y, clean.items[0].size], [100, 0, 90]);
assert.strictEqual(clean.items[0].label.length, 22);
assert.strictEqual(clean.items[1].tint, undefined);
assert.strictEqual(clean.arrows.length, 1);
assert.strictEqual(sanitizeScene({ items: [{ asset: "dragon" }] }), null);
assert.strictEqual(sanitizeScene(null), null);
// a scene panel survives the full visual sanitiser (and wins over a hand-drawn svg)
const visual = sanitizeVisual({ pose: "point", scene: { items: [{ asset: "city", x: 50, y: 46 }] }, svg: { shapes: [] } }, 0) as any;
assert.ok(visual.scene && !visual.svg && !visual.callouts);

// the director is told about the library
const prompt = buildDirectorPrompt(["Servers get hot."], [0], 1);
assert.ok(prompt.includes('- "scene":') && prompt.includes("Never invent an asset name") && prompt.includes('"scene"'));
assert.ok(SCENE_ASSETS.every((a) => prompt.includes(a)), "every asset is listed for the director");

// the clip uses illustrations by default and the old panels when switched off
const hiw = buildHowItWorksSpec({ explanation: "Servers use power. The grid supplies electricity.", diagramTitle: "Power" }, "hiw-x");
assert.ok(hiw.scenes.slice(1).every((s) => (s.visual as any).scene));
process.env.HOWITWORKS_SCENES = "off";
assert.ok(buildHowItWorksSpec({ explanation: "Servers use power. The grid supplies electricity.", diagramTitle: "Power" }, "hiw-y").scenes.slice(1).every((s) => !(s.visual as any).scene));
delete process.env.HOWITWORKS_SCENES;

// catalogue sync with my-video (the renderer): identical file, and the generated scenes pass its schema
const mine = path.resolve(__dirname, "../my-video/src/stickman/doodle/catalog.ts");
if (fs.existsSync(mine)) {
  assert.strictEqual(fs.readFileSync(mine, "utf8"), fs.readFileSync(path.resolve(__dirname, "../src/my-video/sceneCatalog.ts"), "utf8"), "src/my-video/sceneCatalog.ts must be a copy of my-video's doodle/catalog.ts");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { validateStickmanScenes } = require("../my-video/src/stickman/schema");
  const spec = buildHowItWorksSpec({ explanation: "AI data centers use liquid cooling to manage heat. Water absorbs thermal energy from the chips. This creates massive consumption at global scale.", diagramTitle: "Cooling" }, "hiw-z");
  assert.deepStrictEqual(validateStickmanScenes(spec.scenes), []);
  const bad = validateStickmanScenes([{ id: "x", visual: { scene: { items: [{ asset: "dragon", x: 1, y: 1 }] } } }]);
  assert.ok(bad.length > 0, "my-video rejects unknown assets");
  assert.ok(Object.keys(ASSET_KEYWORDS).length === SCENE_ASSETS.length);
} else {
  console.log("(my-video submodule without doodle assets: catalogue sync check skipped)");
}

console.log("✓ scene composer: asset matching, layout, sanitising, director prompt, catalogue sync");
