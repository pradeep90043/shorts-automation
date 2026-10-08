import assert from "assert";
import { FreeLlmApiClient } from "../src/ai/freellmapi";
import {
  assertImportablePlan, buildImportPrompts, checkImportedPlan, importStickmanPlan, parsePlanText, PlanImportError, splitScriptIntoBeats,
} from "../src/my-video/stickmanPlanner";

process.env.FREELLMAPI_KEY = process.env.FREELLMAPI_KEY || "test";
const script = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i} about Spring Boot and Java learning paths.`).join("\n\n");
const beats = splitScriptIntoBeats(script);
const scene = (i: number, extra: object = {}) => ({ i, text: beats[i], pose: "present", mood: "happy", accent: "blue", camera: "none", setting: "office", callouts: ["SPRING BOOT BASICS"], ...extra });
const plan = (idxs: number[]) => ({ title: "My title", description: "D", tags: ["a"], scenes: idxs.map((i) => scene(i)) });
const all = beats.map((_, i) => i);

(async () => {
  // 1) prompts: chunked, numbered, ask for the beat text back
  const { beatCount, prompts } = buildImportPrompts(script, 5);
  assert.strictEqual(beatCount, beats.length);
  assert.strictEqual(prompts.length, Math.ceil(beats.length / 5));
  assert.ok(prompts[0].prompt.includes('"text":"the beat copied EXACTLY') && prompts[0].prompt.includes(`0. ${beats[0]}`));
  assert.ok(prompts[0].prompt.includes('"title":"catchy YouTube title') && !prompts[1].prompt.includes('"title":"catchy YouTube title'));

  // 2) parsing: fences + prose, several answers pasted back to back, bare array, truncated answer
  const fenced = "Sure! Here you go:\n```json\n" + JSON.stringify(plan([0, 1])) + "\n```\nHope it helps [1]";
  assert.strictEqual(parsePlanText(fenced).scenes.length, 2);
  const twoAnswers = JSON.stringify(plan(all.slice(0, 6))) + "\n\n" + JSON.stringify({ scenes: all.slice(6).map((i) => scene(i)) });
  const merged = checkImportedPlan(script, twoAnswers);
  assert.deepStrictEqual([merged.missing.length, merged.errors.length, merged.meta.title], [0, 0, "My title"]);
  assert.strictEqual(parsePlanText(JSON.stringify([scene(0), scene(1)])).scenes.length, 2);
  const truncated = JSON.stringify(plan(all)).slice(0, 700);
  const cut = checkImportedPlan(script, truncated);
  assert.ok(cut.byIndex.size >= 1 && cut.missing.length > 0 && cut.errors.length === 0);
  assert.throws(() => parsePlanText("sorry, I cannot do that"), PlanImportError);

  // 3) mismatches are rejected: reworded text, out-of-range, duplicate
  const reworded = checkImportedPlan(script, { scenes: [scene(0, { text: "Something else entirely" }), scene(1)] });
  assert.strictEqual(reworded.errors.length, 1);
  assert.ok(/Beat 0 text does not match/.test(reworded.errors[0]));
  assert.ok(/does not exist/.test(checkImportedPlan(script, { scenes: [scene(99, { text: undefined })] }).errors[0]));
  assert.ok(/more than once/.test(checkImportedPlan(script, { scenes: [scene(2), scene(2)] }).errors[0]));
  // punctuation / case differences in the echoed text are fine
  assert.strictEqual(checkImportedPlan(script, { scenes: [scene(0, { text: beats[0].toUpperCase().replace(/\./g, "") })] }).errors.length, 0);
  // no "i": positional only when the count matches exactly
  assert.strictEqual(checkImportedPlan(script, { scenes: all.map((i) => scene(i, { i: undefined })) }).errors.length, 0);
  assert.strictEqual(checkImportedPlan(script, { scenes: [scene(0, { i: undefined })] }).errors.length, 1);

  // 4) missing beats: rejected unless repair is on
  assert.throws(() => assertImportablePlan(script, plan(all.slice(0, 9)), false), (e: any) => e instanceof PlanImportError && e.missing.length === 3);
  assert.throws(() => assertImportablePlan(script, { scenes: [scene(0, { text: "nope" })] }, true), PlanImportError);
  assert.doesNotThrow(() => assertImportablePlan(script, plan(all.slice(0, 9)), true));

  // 5) a complete plan builds without touching the AI
  const proto = FreeLlmApiClient.prototype as any;
  const real = proto.generateText;
  let calls = 0;
  proto.generateText = async () => { calls++; return ""; };
  const full = await importStickmanPlan(script, plan(all), {});
  assert.strictEqual(full.scenes.length, beats.length);
  assert.strictEqual(full.title, "My title");
  assert.strictEqual(full.scenes[3].text, beats[3]);
  assert.strictEqual(calls, 0);

  // 6) repair: the AI is asked only for the missing beats; imported scenes are kept untouched
  const asked: number[] = [];
  proto.generateText = async (prompt: string) => {
    const idxs = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    asked.push(...idxs);
    return JSON.stringify({ scenes: idxs.map((i) => ({ i, pose: "think", mood: "neutral", accent: "gold", camera: "none", setting: "server", callouts: ["FILLED BY AI"] })) });
  };
  const repaired = await importStickmanPlan(script, { scenes: all.slice(0, 8).map((i) => scene(i, { callouts: [] , props: [] })) }, { repair: true });
  assert.strictEqual(repaired.scenes.length, beats.length);
  assert.deepStrictEqual([...new Set(asked)].sort((a, b) => a - b), [8, 9, 10, 11]);
  assert.ok(repaired.scenes.slice(0, 8).every((s) => !(s.visual as any).callouts?.length)); // imported bare scenes were not re-asked
  assert.deepStrictEqual((repaired.scenes[9].visual as any).callouts, ["FILLED BY AI"]);
  proto.generateText = real;

  console.log("✓ plan import: prompts, parsing, strict matching, repair");
})().catch((e) => { console.error(e); process.exit(1); });
