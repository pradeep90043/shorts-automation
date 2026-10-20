import fs from "fs";
import path from "path";
import { pipelineLogger } from "../utils/logger";
import { generateVoiceboxNarration, type VoiceboxLine } from "../my-video/voiceboxNarration";
import { voiceInputsFor } from "../my-video/voiceProfiles";
import { makeAsk } from "../longvideo-auto/llm";

/**
 * One cloned English voice for a whole CodeOrCap Short: the claim narration, the "how it works" lines and (from fixed assets)
 * the verdict. The variable lines are spoken on GitHub Actions (voicebox-scenes.yml, one runner, ~6-9 minutes including its
 * start-up) in ONE batch per Short, started as soon as the metadata exists so it runs while the reel is rendered.
 * Anything that goes wrong (no token, run failed, too slow) resolves to null and the caller keeps the Edge voice and the
 * recorded verdict audio, so a Short is never blocked by the cloud.
 */
export interface ClonedLineSet {
  dir: string;
  /** the mp3 of a line, or undefined when it is missing */
  file(name: string): string | undefined;
  /** the text of a line exactly as it was spoken (Devanagari on the Hindi channels), for captions */
  spokenText(name: string): string | undefined;
}

const off = (v: string | undefined): boolean => /^(off|false|0|no)$/i.test((v ?? "").trim());

/**
 * A long line is spoken in pieces: one runner speaking ~1,000 characters takes ~14 minutes on a CPU runner, right at the 15-minute
 * limit of a single speak call (it failed by a hair on a slower runner). The speaking is the slow part (400-960 s per 250-char piece
 * measured against ~130-240 s of fixed set-up), so pieces are ~150 characters: more runners, each much shorter. Whole sentences, packed up to `max` characters; a
 * sentence longer than that is cut at a comma, then a space. The pieces run on separate runners and are joined again.
 */
export function splitForVoice(text: string, max = Number(process.env.VOICE_PIECE_CHARS) || 150): string[] {
  const sentences = text.split(/(?<=[.!?।॥])\s+/).map((x) => x.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= max) { pieces.push(sentence); continue; }
    let cur = "";
    for (const part of sentence.split(/(?<=[,;:])\s+|\s+/)) {
      if (cur && cur.length + 1 + part.length > max) { pieces.push(cur); cur = part; } else cur = cur ? cur + " " + part : part;
    }
    if (cur) pieces.push(cur);
  }
  const out: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur && cur.length + 1 + piece.length > max) { out.push(cur); cur = piece; } else cur = cur ? cur + " " + piece : piece;
  }
  if (cur) out.push(cur);
  // a tiny last piece is merged into the one before it
  if (out.length > 1 && out[out.length - 1].length < 40) { const last = out.pop()!; out[out.length - 1] += " " + last; }
  return out;
}

/** Text as the voice should read it: no emoji, links, hashtags, mentions or markdown marks, one line. */
export function spokenText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@]\w+/g, " ")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, " ")
    .replace(/[*_`~>|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function clonedVoiceEnabled(profileKey: string): boolean {
  if (off(process.env.CLONED_VOICE)) return false;
  if (Object.keys(voiceInputsFor(profileKey)).length === 0) return false; // the channel has no cloned voice (see voiceProfiles.ts)
  return Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
}

/**
 * The Hindi voice reads Devanagari: the Shorts scripts of the other channels are Hinglish in the English alphabet, which it would spell
 * out letter by letter. One LLM call writes every line as it is spoken (English terms stay recognisable, in Devanagari). null = could not.
 */
const hasDevanagari = (t: string): boolean => /[\u0900-\u097F]/.test(t);

/** More than 65% of the letters are Devanagari: Hindi text, not an English sentence that happens to quote one Hindi word. */
export function isMostlyDevanagari(t: string): boolean {
  const letters = t.replace(/[^\p{L}\p{M}]/gu, "");
  if (!letters) return false;
  const dev = (letters.match(/[\u0900-\u097F]/g) ?? []).length;
  return dev / letters.length > 0.65;
}

/**
 * One line to Devanagari, as plain text. Free models truncate a long JSON answer (Devanagari costs many tokens) or answer in
 * chain-of-thought prose; a short one-line answer survives both: only the lines that contain Devanagari are kept.
 */
/** The answer's Devanagari: judged sentence by sentence first, and when that finds nothing the original rule (any line that has Devanagari) minus lines quoting the instruction. */
export function devanagariFromAnswer(raw: string, minWords = 3): string {
  // The prompt asks for the final text between <<< and >>>. A reasoning model writes its analysis first (and may draft the text in it),
  // so the LAST marked block is the final answer.
  const marked = [...raw.matchAll(/<<<([\s\S]*?)>>>/g)].map((m) => m[1].trim()).filter((m) => hasDevanagari(m));
  if (marked.length) {
    const fromMarked = strictDevanagari(marked[marked.length - 1], 1);
    if (fromMarked) return fromMarked;
  }
  const strict = strictDevanagari(raw, minWords);
  if (strict) return strict;
  return raw
    .split(/\n+/)
    .map((l) => l.replace(/^[\s"'`*\-•\d.)]+|["'`\s]+$/g, "").trim())
    .filter((l) => hasDevanagari(l) && !/->|e\.g\.|Devanagari|Keep the meaning|text-to-speech|Return ONLY/i.test(l)) // never the instruction itself
    .filter((l, i, all) => all.indexOf(l) === i)
    .join(" ")
    .trim();
}

function strictDevanagari(raw: string, minWords: number): string {
  // Judged SENTENCE by sentence, not line by line: a model often puts the real rewrite and an echoed instruction on the same line, and the
  // Hindi may carry Latin acronyms ("EMI", "RBI"). A sentence is kept when most of its letters are Devanagari: that keeps Hindi with an
  // acronym and drops English prose, an echoed instruction ('... e.g. "video" -> "वीडियो"') and chain-of-thought.
  const sentences = raw.split(/\n+/).flatMap((line) => line.split(/(?<=[।.?!;])\s+/));
  return sentences
    .map((s) =>
      s
        .replace(/^[\s"'`*\-•]+|["'`\s]+$/g, "")
        .replace(/^\d+[.)]\s+/, "") // "1." numbering, but a figure like "25 बेसिस पॉइंट" stays
        .replace(/^[A-Za-z][A-Za-z\s:,'"()\-]*?(?=[ऀ-ॿ\d₹])/, "") // a Latin preface in the same sentence ("Hindi: ...", "Here it is: ...")
        .trim(),
    )
    .filter((s) => isMostlyDevanagari(s) && s.split(/\s+/).length >= minWords)
    .filter((s, i, all) => all.indexOf(s) === i) // a model stuck in a loop repeats the same sentence
    .join(" ")
    .split(/(?<=[।.?!])\s+/)
    .filter((sent, i, all) => {
      // a looping answer repeats a sentence, the last copy cut off: keep a sentence only once (also when it is the start of an earlier one)
      const norm = (x: string) => x.replace(/[\s।.?!,'"]+/g, "");
      const n = norm(sent);
      return n.length > 0 && !all.slice(0, i).some((p) => norm(p).startsWith(n));
    })
    .join(" ")
    .trim();
}

/**
 * A looping answer starts with the correct rewrite and then repeats or rambles (a 121-character line came back as ~10,000 characters on three
 * attempts in a row). Keep its beginning: at most ~1.4x the source (a real rewrite is 1-1.3x; at 2x the line took 296 s to speak instead of 68 s), cut at the last sentence end or space. "" when nothing usable is left.
 */
export function clampRunaway(out: string, source: string): string {
  const limit = Math.max(60, Math.round(source.length * 1.4));
  if (out.length <= limit) return out;
  const head = out.slice(0, limit);
  const cut = Math.max(head.lastIndexOf("।"), head.lastIndexOf("."), head.lastIndexOf("?"), head.lastIndexOf("!"), head.lastIndexOf(" "));
  return head.slice(0, cut > limit / 2 ? cut + 1 : limit).trim();
}

/** A Devanagari rewrite is about as long as its source; one much longer is chain-of-thought or a runaway answer (10,000+ characters once). */
export const devanagariTooLong = (out: string, source: string): boolean => out.length > Math.max(80, source.length * 1.8);

/**
 * Is `out` a believable Devanagari rewrite of `source`? A reasoning model's notes pass every "has Devanagari" test: a Short was narrated
 * with `आपके" or "आपक़े"?`, `क्रूड -> क्रूड, तेल -> तेल` and `पुट or डाल.` (word-choice alternatives from its thinking). A real rewrite
 * is mostly Devanagari, about as long as the source, and has no arrows, no "x" or "y" alternatives and no stray English "or".
 */
export function plausibleRewrite(out: string, source: string): boolean {
  if (!out || !isMostlyDevanagari(out)) return false;
  if (/->|=>|\s(or|as|and)\s*["“”]|["“”]\s*(or|as|and)\s|\sor\s/i.test(out)) return false; // alternatives / glosses, never speech
  if (/["“”][^"“”]{0,40}["“”]\s*\?/.test(out)) return false; // a quoted word followed by a question mark: the model asking itself
  const ratio = out.length / Math.max(1, source.length);
  const words = out.trim().split(/\s+/).length / Math.max(1, source.trim().split(/\s+/).length);
  return ratio >= 0.5 && ratio <= 1.7 && words >= 0.5 && words <= 1.8;
}

async function lineToDevanagari(text: string, ask: (p: string, o?: { maxTokens?: number; model?: string }) => Promise<string>): Promise<string | null> {
  if (hasDevanagari(text) || !/[A-Za-z]/.test(text)) return text; // already Devanagari, or a bare figure
  const prompt =
    `Rewrite this Hinglish text (Hindi written in the English alphabet) in Devanagari exactly as it is spoken, for a text-to-speech voice. ` +
    `Keep the meaning and every word; write English words in Devanagari too; keep numbers and punctuation. ` +
    `Do not analyse or explain. Put ONLY the final Devanagari text between <<< and >>>.\n\nText: ${text}\n/no_think`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // The first attempt can pin a model that does not think out loud (HINDI_CONVERT_MODEL: the dev router picked a reasoning model that
      // wrote "Here's a thinking process: ..." and drafted alternatives); later attempts use the normal routing.
      const model = attempt === 1 ? process.env.HINDI_CONVERT_MODEL || undefined : undefined;
      // Room for a reasoning model's analysis AND the answer, still far below the 4,096 default that let a loop run to 10,000 characters.
      const answer = await ask(prompt, { maxTokens: Math.max(1200, text.length * 8), model });
      let out = devanagariFromAnswer(answer, text.trim().split(/\s+/).length < 4 ? 1 : 3);
      if (devanagariTooLong(out, text)) out = clampRunaway(out, text); // a looping answer's clean beginning
      if (plausibleRewrite(out, text)) return out;
      pipelineLogger.warn(
        `Hindi text for one line, attempt ${attempt}/3: answer rejected (${answer.length} chars${model ? `, model ${model}` : ""}) starts: ${JSON.stringify(answer.slice(0, 120))}`,
        "ClonedVoice",
      );
    } catch (err) {
      pipelineLogger.warn(`Hindi text for one line, attempt ${attempt}/3: ${err instanceof Error ? err.message : err}`, "ClonedVoice");
    }
  }
  return null; // better the normal voice than a narration made of word lists
}

/**
 * The Hindi voice reads Devanagari: the Shorts scripts of the other channels are Hinglish in the English alphabet, which it would spell
 * out letter by letter. Each line is converted in its own small call (in parallel). null = a line could not be converted.
 */
export async function toDevanagari(lines: VoiceboxLine[], ask = makeAsk({ timeoutMs: 75_000, hedgeMs: 15_000 })): Promise<VoiceboxLine[] | null> {
  const needs = lines.map((l) => !hasDevanagari(l.text) && /[A-Za-z]/.test(l.text));
  const todo = lines.map((_, i) => i).filter((i) => needs[i]);
  const out: (string | null)[] = lines.map((l) => l.text);
  // ONE call for the whole script first (groups of 10): 13 separate calls queued behind the AI request gate for up to 98 s and
  // overran a rate-limited free key; the per-line call below is the fallback for any line the batch got wrong.
  for (let g = 0; g < todo.length; g += 10) {
    const group = todo.slice(g, g + 10);
    const batch = await convertBatch(group.map((i) => lines[i].text), ask);
    group.forEach((i, k) => { out[i] = batch?.[k] ?? null; });
  }
  await Promise.all(todo.filter((i) => out[i] === null).map(async (i) => { out[i] = await lineToDevanagari(lines[i].text, ask); }));
  if (out.some((t) => t === null)) return null;
  return lines.map((l, i) => ({ name: l.name, text: out[i] as string }));
}

/** The N rewrites of a batch answer ("1. <<<...>>>"), each only when it is a plausible rewrite of its line; undefined/null entries are redone one by one. */
export function parseBatchAnswer(answer: string, sources: string[]): (string | null)[] {
  return sources.map((src, k) => {
    // candidates for line k+1: "<<<...>>>" blocks and plain "k+1. text" lines (models often drop the markers), judged last to first
    const marked = [...answer.matchAll(new RegExp(`(?:^|\\n)\\s*${k + 1}[.)]\\s*<<<([\\s\\S]*?)>>>`, "g"))].map((m) => m[1].trim());
    const plain = [...answer.matchAll(new RegExp(`(?:^|\\n)\\s*${k + 1}[.)]\\s+([^\\n]+)`, "g"))].map((m) => m[1].replace(/<<<|>>>/g, "").trim());
    for (const cand of [...marked, ...plain].reverse()) {
      const out = devanagariFromAnswer(cand, src.trim().split(/\s+/).length < 4 ? 1 : 3);
      if (plausibleRewrite(out, src)) return out;
    }
    return null;
  });
}

async function convertBatch(sources: string[], ask: (p: string, o?: { maxTokens?: number; model?: string }) => Promise<string>): Promise<(string | null)[] | null> {
  if (!sources.length) return [];
  const prompt =
    `Rewrite each numbered Hinglish line (Hindi written in the English alphabet) in Devanagari exactly as it is spoken, for a text-to-speech voice. ` +
    `Keep the meaning and every word; write English words in Devanagari too; keep numbers and punctuation. ` +
    `Do not analyse or explain. Answer with one line per number, in this exact format, nothing else:\n1. <<<Devanagari text>>>\n2. <<<Devanagari text>>>\n\n` +
    `${sources.map((s, k) => `${k + 1}. ${s}`).join("\n")}\n/no_think`;
  const total = sources.reduce((n, s) => n + s.length, 0);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const model = process.env.HINDI_CONVERT_MODEL || undefined;
      const answer = await ask(prompt, { maxTokens: Math.min(6000, Math.max(1500, total * 8)), model });
      const parsed = parseBatchAnswer(answer, sources);
      const good = parsed.filter(Boolean).length;
      pipelineLogger.info(`Hindi text: batch of ${sources.length} lines -> ${good} usable${model ? ` (model ${model})` : ""}`, "ClonedVoice");
      if (good > 0) return parsed;
      pipelineLogger.warn(`Hindi text: batch attempt ${attempt}/2 unusable (${answer.length} chars) starts: ${JSON.stringify(answer.slice(0, 120))}`, "ClonedVoice");
    } catch (err) {
      pipelineLogger.warn(`Hindi text: batch attempt ${attempt}/2: ${err instanceof Error ? err.message.slice(0, 160) : err}`, "ClonedVoice");
    }
    await new Promise((r) => setTimeout(r, Number(process.env.HINDI_BATCH_WAIT_MS ?? 4000))); // a rate-limited free key needs a moment
  }
  return null;
}

/**
 * Never rejects: null = use the normal voice. CodeOrCap speaks English; every other channel with a cloned voice speaks Hindi.
 */
export function startClonedLines(slug: string, lines: VoiceboxLine[], profileKey = "codeorcap"): Promise<ClonedLineSet | null> {
  const timeoutMin = Number(process.env.CLONED_VOICE_TIMEOUT_MIN) || 20;
  const started = Date.now();
  const english = profileKey.toLowerCase() === "codeorcap";
  pipelineLogger.info(`Cloned voice (${profileKey}): ${lines.length} line(s) -> GitHub Actions (give up after ${timeoutMin} min)`, "ClonedVoice");
  // English: no denoise (the user compared 4 variants against their own voice and the undenoised one (turbo, 1.0x) sounded closest)
  let spokenLines: VoiceboxLine[] = lines;
  const run = async () => {
    const spoken = english ? lines : await toDevanagari(lines);
    if (!spoken) throw new Error("the Hindi text could not be prepared");
    spokenLines = spoken;
    const attemptOnce = (budgetMs: number, suffix: string) =>
      generateVoiceboxNarration({
        slug: slug + suffix,
        lines: spoken,
        language: english ? "en" : "hi",
        speed: "1.0",
        inputs: { ...voiceInputsFor(profileKey), shard_chars: process.env.VOICE_SHARD_CHARS || "60", ...(english ? { denoise: "false" } : {}) },
        giveUpMs: budgetMs,
      });
    try {
      return await attemptOnce(timeoutMin * 60_000, "");
    } catch (err) {
      // a run that FAILED (a runner error) is tried once more while there is time; one that timed out is not (it would take as long again)
      const left = timeoutMin * 60_000 - (Date.now() - started);
      const msg = err instanceof Error ? err.message : String(err);
      if (/took longer than/i.test(msg) || left < 8 * 60_000) throw err;
      pipelineLogger.warn(`Cloned voice run failed (${msg.slice(0, 160)}): trying once more (${Math.round(left / 60000)} min left)`, "ClonedVoice");
      return attemptOnce(left, "-r2");
    }
  };
  return run()
    .then((r) => {
      pipelineLogger.info(`Cloned voice ready in ${Math.round((Date.now() - started) / 1000)}s`, "ClonedVoice");
      return {
        dir: r.dir,
        file: (name: string) => {
          const f = path.join(r.dir, `${name}.mp3`);
          return fs.existsSync(f) ? f : undefined;
        },
        spokenText: (name: string) => {
          const exact = spokenLines.find((l) => l.name === name);
          if (exact) return exact.text;
          const parts = spokenLines.filter((l) => l.name.startsWith(name + "_")).sort((x, y) => Number(x.name.split("_").pop()) - Number(y.name.split("_").pop()));
          return parts.length ? parts.map((l) => l.text).join(" ") : undefined;
        },
      } as ClonedLineSet;
    })
    .catch((err) => {
      pipelineLogger.warn(`Cloned voice unavailable (${err instanceof Error ? err.message : err}) -> the normal voice is used`, "ClonedVoice");
      return null;
    });
}
