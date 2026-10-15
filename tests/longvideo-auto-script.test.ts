import assert from "assert";
import { checkScript, wordsOf } from "../src/longvideo-auto/guardrails";
import { cleanNarration, dropUnsupportedFigures, FINANCE_DISCLAIMER, writeLongScript } from "../src/longvideo-auto/scriptWriter";

// cleaning: what a narrator must not read is removed
assert.strictEqual(cleanNarration("## अध्याय १\n**यह** एक *परीक्षण* है 🔥\n- पहला बिंदु"), "यह एक परीक्षण है पहला बिंदु");
// figures: kept only when the sources have them
const d = dropUnsupportedFigures("सेंसेक्स 81,200 पर बंद हुआ। निफ्टी 99,999 पर पहुँचा। बाज़ार मज़बूत रहा।", "Sensex 81,200 points");
assert.strictEqual(d.dropped, 1);
assert.ok(d.text.includes("81,200") && !d.text.includes("99,999") && d.text.includes("मज़बूत"));

const sentence = "यह एक सरल वाक्य है जो विषय को आसान भाषा में समझाता है।";
const chapterText = (k: number) => Array(k).fill(sentence).join(" ");
let calls = 0;
const fakeAsk = (opts: { words: number; badNumber?: boolean; failChapter?: number }) => async (prompt: string): Promise<string> => {
  calls++;
  if (prompt.startsWith("You plan")) {
    return JSON.stringify({
      title: "आज का बाज़ार: क्या हुआ और क्यों",
      description: "बाज़ार की पूरी कहानी।",
      tags: ["#market", "sensex", "finance"],
      chapters: Array.from({ length: 8 }, (_, i) => ({ heading: `भाग ${i + 1}`, points: ["बिंदु एक", "बिंदु दो"] })),
    });
  }
  const m = /chapter (\d+) of 8/.exec(prompt);
  if (m && Number(m[1]) === opts.failChapter) return "English only text with no devanagari at all in this answer";
  const perSentence = wordsOf(sentence);
  const t = chapterText(Math.round(opts.words / perSentence));
  return opts.badNumber && m && m[1] === "3" ? `${t} कीमत 77,777 रुपये थी।` : t;
};

(async () => {
  const base = { channelKey: "prompt_gag", brandName: "PromptGag", topic: "शेयर बाज़ार आज", seedText: "सेंसेक्स आज बढ़ा", research: "[1] Market (2026-10-15) - https://x.y\nSensex 81,200.", targetWords: 1340 };

  // a normal run: 8 chapters, length near target, finance disclaimer spoken twice, tags cleaned
  const pkg = await writeLongScript(base, fakeAsk({ words: 168 }));
  assert.strictEqual(pkg.chapters.length, 8);
  const w = wordsOf(pkg.script);
  assert.ok(w >= 1340 * 0.88 && w <= 1340 * 1.12, `length ${w}`);
  assert.strictEqual(pkg.script.split(FINANCE_DISCLAIMER).length - 1, 2, "disclaimer opens and closes the video");
  assert.deepStrictEqual(pkg.tags, ["market", "sensex", "finance"]);
  assert.ok(pkg.description.includes("वित्तीय सलाह नहीं"));
  const guard = checkScript({ channelKey: "prompt_gag", script: pkg.script, title: pkg.title, description: pkg.description, sourceText: base.research, targetWords: 1340, tolerance: 0.12 });
  assert.ok(guard.ok, guard.problems.join("; "));

  // an invented figure never survives, and the run still completes
  const inv = await writeLongScript(base, fakeAsk({ words: 168, badNumber: true }));
  assert.ok(inv.droppedSentences >= 1);
  assert.ok(!inv.script.includes("77,777"));

  // too long -> trimmed from the middle chapters, opening and recap untouched
  const long = await writeLongScript({ ...base, channelKey: "codeorcap" }, fakeAsk({ words: 300 }));
  assert.ok(wordsOf(long.script) <= 1340 * 1.07, `trimmed to ${wordsOf(long.script)}`);
  assert.ok(wordsOf(long.chapters[0].text) >= 280 && wordsOf(long.chapters[7].text) >= 280);

  // a chapter the model answers in the wrong script is retried, then the run fails loudly (the queue retries it later)
  calls = 0;
  await assert.rejects(writeLongScript(base, fakeAsk({ words: 168, failChapter: 4 })), /chapter 4/);

  // a broken outline falls back to a generic one; chapters are still written
  const noOutline = async (p: string) => (p.startsWith("You plan") ? "not json" : chapterText(21));
  const fb = await writeLongScript({ ...base, channelKey: "storiyum" }, noOutline);
  assert.strictEqual(fb.chapters.length, 8);
  assert.strictEqual(fb.title, base.topic);
  console.log("✓ longvideo-auto script writer");
})().catch((e) => { console.error(e); process.exit(1); });
