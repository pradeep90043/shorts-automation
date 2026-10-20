import assert from "assert";
import { classifyEmotions, ruleEmotion, tagEmotions } from "../src/audio/emotion";

(async () => {
  assert.strictEqual(ruleEmotion("But then something shocking happened."), "surprise");
  assert.strictEqual(ruleEmotion("अचानक उसने सब कुछ खो दिया"), "sad"); // loss beats the sudden
  assert.strictEqual(ruleEmotion("उसे यकीन नहीं हुआ, लेकिन तभी फोन बजा!"), "surprise");
  assert.strictEqual(ruleEmotion("Big news! A new record!"), "energetic");
  assert.strictEqual(ruleEmotion("Beware of this scam."), "serious");
  assert.strictEqual(ruleEmotion("A function returns a value."), "neutral");

  // LLM answer is used; a bad/missing entry keeps the rule's answer
  const out = await classifyEmotions(["Hello there.", "Beware of this scam.", "Wow, unbelievable!"], async () => '["warm", "nonsense"]');
  assert.deepStrictEqual(out, ["warm", "serious", "surprise"]);
  // LLM failure -> rules
  const fb = await classifyEmotions(["Wow, unbelievable!"], async () => { throw new Error("down"); });
  assert.deepStrictEqual(fb, ["surprise"]);

  // trailing prose after the array must not break the answer
  const tail = await classifyEmotions(["Hello", "Beware of this scam."], async () => 'Sure! ["warm","serious"] — note: [none]');
  assert.deepStrictEqual(tail, ["warm", "serious"]);

  process.env.VOICE_EMOTION = "off";
  const lines = [{ name: "a", text: "Wow" }];
  assert.deepStrictEqual(await tagEmotions(lines), lines);
  console.log("✓ voice emotion: rules, LLM tagging, off switch");
})().catch((e) => { console.error(e); process.exit(1); });
