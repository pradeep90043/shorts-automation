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
assert.strictEqual(visualStyleFor("prompt_gag", {}), "finance");
assert.strictEqual(visualStyleFor("infoonspot", {}), "news");
assert.strictEqual(visualStyleFor("codeorcap", {}), "stickman");
assert.strictEqual(visualStyleFor("storiyum", { CHANNEL_STYLES: "off" }), "stickman");
assert.strictEqual(visualStyleFor("codeorcap", { CHANNEL_STYLES: "codeorcap:finance" }), "finance");

// niche frames: finance gets a headline and the figure named in the beat; news keeps its place; backgrounds stay inside the niche
const fcast = sanitizeCast(undefined, "finance");
assert.strictEqual(fcast[0].id, "advisor");
const f = sanitizeStaging(undefined, "रेपो रेट 5.50% हो गई और ईएमआई बढ़ेगी", fcast, undefined, 0, "finance");
assert.strictEqual(f.bg, "bank");
assert.strictEqual(f.stat?.value, "5.50%");
assert.ok(f.headline && f.headline.split(" ").length <= 7);
const n = sanitizeStaging({ bg: "palace", place: "दिल्ली", headline: "संसद में हंगामा" }, "संसद में हंगामा हुआ", sanitizeCast(undefined, "news"), undefined, 0, "news");
assert.strictEqual(n.bg, "govt", "a bad background becomes the one the words point to");
assert.strictEqual(n.place, "दिल्ली");
// no AI at all: places, layouts and speakers keep changing instead of one bank for 70 scenes
{
  const c = sanitizeCast(undefined, "finance");
  let prev: ReturnType<typeof sanitizeStaging> | undefined;
  const seen = { bg: new Set<string>(), layout: new Set<string>(), headlines: 0 };
  for (let i = 0; i < 40; i++) {
    const st = sanitizeStaging(undefined, "बैंक की बात चल रही है", c, prev, i, "finance");
    seen.bg.add(st.bg); seen.layout.add(st.chars.map((x) => `${x.id}@${x.x}`).join("|"));
    if (st.headline) seen.headlines++;
    prev = st;
  }
  assert.ok(seen.bg.size >= 3, "backgrounds rotate: " + [...seen.bg]);
  assert.ok(seen.layout.size >= 4, "layouts vary: " + seen.layout.size);
  assert.ok(seen.headlines > 0 && seen.headlines < 20, "headline strip only on some beats: " + seen.headlines);
}
// continuity: inside a shot the same people stay where they stand and only the speaker changes; a new place starts a new shot
{
  const c = sanitizeCast(undefined, "story");
  const a = sanitizeStaging({ bg: "village", time: "day" }, "गाँव में सुबह थी", c, undefined, 0, "story");
  const b = sanitizeStaging({ bg: "village", time: "day" }, "लोग खेत जा रहे थे", c, a, 1, "story");
  const d = sanitizeStaging({ bg: "village", time: "day" }, "बच्चे खेल रहे थे", c, b, 2, "story");
  assert.ok(b.cont && d.cont, "same place and time = the shot goes on");
  assert.deepStrictEqual(b.chars.map((x) => [x.id, x.x]), a.chars.map((x) => [x.id, x.x]), "nobody moves between beats of a shot");
  assert.notStrictEqual(b.chars.find((x) => x.speaking)?.id, d.chars.find((x) => x.speaking)?.id, "the speaker alternates");
  const e = sanitizeStaging({ bg: "school", time: "day" }, "स्कूल में घंटी बजी", c, d, 3, "story");
  assert.ok(!e.cont && e.shot === d.shot! + 1, "a new place is a new shot");
}
// the picture shows what the narration says: objects, animals, weather and what people do
{
  const c = sanitizeCast(undefined, "story");
  const gift = sanitizeStaging(undefined, "राजू ने माँ को तोहफ़ा दिया", c, undefined, 0, "story");
  assert.ok(gift.chars.some((x) => x.pose === "give" && x.holds === "gift"), "giving a gift: the give pose with the gift in hand");
  assert.ok(!gift.props!.some((p) => p.type === "gift"), "a held object does not also stand on the floor");
  const rain = sanitizeStaging(undefined, "बारिश में कुत्ता उसके पीछे भागा", c, undefined, 0, "story");
  assert.strictEqual(rain.fx, "rain");
  assert.ok(rain.props!.some((p) => p.type === "dog"), "the dog is on screen");
  assert.ok(rain.chars.some((x) => x.pose === "run"));
  const hug = sanitizeStaging(undefined, "दादाजी रोने लगे और सबने उन्हें गले लगाया", c, undefined, 0, "story");
  assert.ok(["hug", "cry"].includes(hug.chars[0].pose));
  const ai = sanitizeStaging({ props: [{ type: "spaceship" }, { type: "bus", x: 70 }], fx: "snow" }, "वे बस से गए", c, undefined, 0, "story");
  assert.deepStrictEqual(ai.props!.map((p) => p.type), ["bus"], "unknown objects are dropped");
  assert.strictEqual(ai.fx, "snow");
}
// animals: the AI's animal characters stay animals (fur, no hair, species checked); unknown species are dropped
{
  const c = sanitizeCast([{ id: "wolf", name: "भेड़िया", species: "wolf", outfit: "kurta", age: "child" }, { id: "x", species: "dragon", outfit: "suit" }], "story");
  assert.strictEqual(c[0].species, "wolf");
  assert.strictEqual(c[0].age, "adult");
  assert.strictEqual(c[0].hair, "bald");
  assert.ok(/^#[0-9a-f]{6}$/i.test(c[0].skin), "an animal has a fur colour");
  assert.strictEqual(c[1].species, undefined, "an unknown species is a person");
}
console.log("✓ storyboard planner");
