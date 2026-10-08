import assert from "assert";
import { FreeLlmApiClient } from "../src/ai/freellmapi";
import { planStickmanVideo } from "../src/my-video/stickmanPlanner";

process.env.FREELLMAPI_KEY = process.env.FREELLMAPI_KEY || "test";
const script = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i} about Spring Boot and Java learning paths.`).join("\n\n");
const proto = FreeLlmApiClient.prototype as any;
const real = proto.generateText;

(async () => {
  // 1) LLM keeps returning garbage -> the plan must throw (no plain-stickman video)
  proto.generateText = async () => "not json at all";
  await assert.rejects(() => planStickmanVideo(script), /could not direct/);

  // 2) LLM answers with one scene missing per call and sloppy order -> repair rounds fill the gaps
  proto.generateText = async (prompt: string) => {
    const idxs = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    const used = (idxs.length > 1 ? idxs.slice(0, -1) : idxs).reverse(); // drop the last beat (unless alone), reverse the order
    return JSON.stringify({
      title: "T", description: "D", tags: ["a"],
      scenes: used.map((i) => ({ i, pose: "present", mood: "happy", accent: "blue", camera: "none", setting: i % 2 ? "server" : "office", callouts: ["SPRING BOOT BASICS"] })),
    });
  };
  const plan = await planStickmanVideo(script);
  assert.strictEqual(plan.scenes.length, 30);
  assert.ok(plan.scenes.every((s) => (s.visual as any).setting && (s.visual as any).setting !== "none"));
  // 3) the model numbers scenes 0..n-1 inside every batch (relative "i"): order must be trusted, nothing may be lost
  let calls = 0;
  proto.generateText = async (prompt: string) => {
    calls++;
    const idxs = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    return JSON.stringify({ title: "T", description: "D", tags: ["a"], scenes: idxs.map((_, k) => ({ i: k, pose: "present", mood: "happy", accent: "blue", camera: "none", setting: "server", callouts: ["X Y Z"] })) });
  };
  const rel = await planStickmanVideo(script);
  assert.strictEqual(rel.scenes.length, 30);
  assert.ok(calls <= Math.ceil(30 / 12), "all beats accepted in round 1 (calls=" + calls + ")");
  console.log("✓ planner is strict and self-repairing");
  proto.generateText = real;
})().catch((e) => { console.error(e); process.exit(1); });
