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
  console.log("✓ planner is strict and self-repairing");
  proto.generateText = real;
})().catch((e) => { console.error(e); process.exit(1); });
