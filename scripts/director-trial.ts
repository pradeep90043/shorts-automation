/**
 * Trial run of the director step on a script, with the app's real LLM settings: beats -> cast -> shots, written to a JSON plan
 * that my-video's scripts/film/plan-to-project.ts turns into a renderable project (no voice).
 *
 *   DOTENV_CONFIG_PATH=../shorts-automation/.env npx ts-node -r dotenv/config scripts/director-trial.ts story.txt plan.json
 */
import fs from "fs";
import { addDirectorShots } from "../src/my-video/directorShots";
import { askLlm, cleanScript, splitScriptIntoBeats, type StickmanPlan } from "../src/my-video/stickmanPlanner";

(async () => {
  const [scriptPath, outPath] = process.argv.slice(2);
  const beats = splitScriptIntoBeats(cleanScript(fs.readFileSync(scriptPath, "utf8")));
  const plan: StickmanPlan = { title: "trial", description: "", tags: [], aiVisuals: true, scenes: beats.map((text, i) => ({ id: `s${i}`, text, visual: { pose: "idle" } as any })) };
  const t0 = Date.now();
  const r = await addDirectorShots(plan, askLlm, (m) => console.log(m));
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${JSON.stringify(r)}`);
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
