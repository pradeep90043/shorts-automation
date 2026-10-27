/**
 * Makes one mythology Short end to end (LLM script, AI paintings, cloned voice, render) WITHOUT uploading it.
 *   npx ts-node scripts/mythology-sample.ts [topic-id] [out-dir]
 * Used by .github/workflows/mythology-sample.yml to test the real providers away from the dev session.
 */
import fs from "fs";
import path from "path";
import { makeAsk } from "../src/longvideo-auto/llm";
import { makeMythShort } from "../src/mythology";
import { MYTH_TOPICS, pickTopic } from "../src/mythology/topics";

async function main() {
  const [id, outDir = "mythology-out"] = process.argv.slice(2);
  const topic = MYTH_TOPICS.find((t) => t.id === id) ?? pickTopic([]);
  console.log(`Topic: ${topic.id} (${topic.source})`);
  const made = await makeMythShort("prompt_gag", topic, { ask: makeAsk(), handle: () => "@promptgag1" }, path.resolve(outDir, "work"));
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(made.video, path.join(outDir, `${topic.id}.mp4`));
  fs.writeFileSync(path.join(outDir, `${topic.id}.json`), JSON.stringify({ topic, metadata: made.metadata, script: made.script }, null, 2));
  console.log(`Title: ${made.metadata.title}`);
  made.script.scenes.forEach((s, i) => console.log(`${i + 1}. ${s.narration}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
