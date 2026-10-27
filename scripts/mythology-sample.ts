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

/**
 * A fresh runner has no FreeLLMAPI (the dev session starts its own, seeded with the Groq key): ask Groq directly when its key is
 * set, else the server's usual providers.
 */
function sampleAsk() {
  const key = process.env.GROQ_API_KEY;
  if (!key) return makeAsk();
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  // Groq retires models often: take the biggest general model the key can see right now
  let model: Promise<string> | undefined;
  const pickModel = async (): Promise<string> => {
    if (process.env.GROQ_MODEL) return process.env.GROQ_MODEL;
    const res = await fetch("https://api.groq.com/openai/v1/models", { headers });
    const ids: string[] = res.ok ? (((await res.json()) as any).data ?? []).map((m: any) => String(m.id)) : [];
    const prefer = [/gpt-oss-120b/, /kimi-k2/, /llama-4-maverick/, /qwen3-32b/, /llama-3\.3-70b/, /70b/, /llama-4-scout/];
    const usable = ids.filter((id) => !/whisper|guard|tts|embed|playai|compound/i.test(id));
    const chosen = prefer.map((re) => usable.find((id) => re.test(id))).find(Boolean) ?? usable[0];
    if (!chosen) throw new Error(`Groq has no usable model (${ids.join(", ") || "model list failed"})`);
    console.log(`Groq model: ${chosen}`);
    return chosen;
  };
  return async (prompt: string, opts?: { maxTokens?: number }) => {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: await (model ??= pickModel()), messages: [{ role: "user", content: prompt }], max_tokens: opts?.maxTokens ?? 3000, temperature: 0.8 }),
    });
    if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as any).choices?.[0]?.message?.content ?? "";
  };
}

async function main() {
  const [id, outDir = "mythology-out"] = process.argv.slice(2);
  const topic = MYTH_TOPICS.find((t) => t.id === id) ?? pickTopic([]);
  console.log(`Topic: ${topic.id} (${topic.source})`);
  const made = await makeMythShort("prompt_gag", topic, { ask: sampleAsk(), handle: () => "@promptgag1" }, path.resolve(outDir, "work"));
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
