import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plan-resume-"));
process.env.FREELLMAPI_KEY = process.env.FREELLMAPI_KEY || "test";
process.env.DIRECTOR_COMPOSED_FALLBACK = "off";
process.env.PLAN_BUDGET_MIN = "0.001"; // stop after round 1 so the first attempt ends incomplete

const script = Array.from({ length: 24 }, (_, i) => `Sentence number ${i} explains one Kubernetes idea in plain words.`).join("\n\n");

(async () => {
  const { FreeLlmApiClient } = await import("../src/ai/freellmapi");
  const { planStickmanVideo } = await import("../src/my-video/stickmanPlanner");
  const proto = FreeLlmApiClient.prototype as any;
  const answer = (prompt: string, only?: (i: number) => boolean) => {
    const idxs = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])).filter((i) => !only || only(i));
    return JSON.stringify({ title: "T", description: "D", tags: ["a"], scenes: idxs.map((i) => ({ i, pose: "present", mood: "happy", accent: "blue", camera: "none", setting: "server", callouts: ["K8S"] })) });
  };

  // attempt 1: the provider only ever answers for beats 0-11 -> the plan fails, but those 12 are checkpointed
  proto.generateText = async (prompt: string) => answer(prompt, (i) => i < 12);
  await assert.rejects(() => planStickmanVideo(script), /could not direct/);
  assert.strictEqual(fs.readdirSync(path.join(process.env.DATA_DIR!, "plan-checkpoints")).length, 1);

  // attempt 2: the provider is back -> only beats 12-23 may be asked
  const asked = new Set<number>();
  proto.generateText = async (prompt: string) => { for (const m of prompt.matchAll(/^(\d+)\. /gm)) asked.add(Number(m[1])); return answer(prompt); };
  const plan = await planStickmanVideo(script);
  assert.strictEqual(plan.scenes.length, 24);
  assert.ok([...asked].every((i) => i >= 12), "resumed beats were not asked again: " + [...asked].join(","));
  assert.strictEqual(fs.readdirSync(path.join(process.env.DATA_DIR!, "plan-checkpoints")).length, 0, "checkpoint removed after success");
  console.log("✓ planner resumes from its checkpoint");
})().catch((e) => { console.error(e); process.exit(1); });
