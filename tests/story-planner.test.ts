import assert from "assert";
import { sanitizeCast, sanitizeStaging } from "../src/my-video/storyPlanner";
import { visualStyleFor } from "../src/my-video/channelStyle";

// the AI's cast is clamped to what can be drawn; garbage falls back to a usable pair
assert.strictEqual(sanitizeCast(undefined).length, 2);
const cast = sanitizeCast([{ id: "raju!", name: "राजू", age: "child", outfit: "spaceship", hair: "short", skin: "bad" }, { id: "raju", age: "elder", outfit: "dhoti" }, { id: "maa", outfit: "saree", bindi: true }]);
assert.deepStrictEqual(cast.map((c) => c.id), ["raju", "maa"], "ids are cleaned and duplicates dropped");
assert.strictEqual(cast[0].outfit, "shirt", "an unknown outfit becomes a shirt");
assert.ok(/^#[0-9a-f]{6}$/i.test(cast[0].skin));

// a beat with no AI staging still gets a background from its words and the people of the previous scene
const first = sanitizeStaging({ bg: "school", time: "day", chars: [{ id: "raju", x: 30, pose: "scared", mood: "scared" }, { id: "ghost", x: 70 }] }, "टीचर ने सवाल पूछा", cast, undefined, 0);
assert.deepStrictEqual(first.chars.map((c) => c.id), ["raju"], "unknown characters are dropped");
assert.ok(first.chars[0].speaking, "someone always speaks");
const next = sanitizeStaging(undefined, "रात को राजू अपने घर में रो रहा था", cast, first, 1);
assert.strictEqual(next.bg, "room_night");
assert.strictEqual(next.time, "night");
assert.strictEqual(next.chars[0].mood, "sad");
const keep = sanitizeStaging({ bg: "nowhere" }, "और फिर कुछ हुआ", cast, first, 2);
assert.strictEqual(keep.bg, "school", "the previous place stays when nothing says otherwise");

assert.strictEqual(visualStyleFor("storiyum", {}), "story");
assert.strictEqual(visualStyleFor("codeorcap", {}), "stickman");
assert.strictEqual(visualStyleFor("storiyum", { STORY_STYLE_CHANNELS: "off" }), "stickman");
console.log("✓ storyboard planner");
