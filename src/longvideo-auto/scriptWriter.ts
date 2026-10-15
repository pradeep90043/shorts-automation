import { parseAiJson } from "../utils/json";
import type { Ask } from "./llm";
import { FINANCE_CHANNELS, numbersIn, wordsOf } from "./guardrails";

export interface ScriptRequest {
  channelKey: string;
  brandName: string;
  /** what the video is about (the seed Short's title) */
  topic: string;
  /** what the seed reel said */
  seedText: string;
  /** fetched sources, "[n] title (date) - url\ntext" blocks; the only place figures may come from */
  research: string;
  targetWords: number;
  chapters?: number;
}

export interface ScriptPackage {
  title: string;
  description: string;
  tags: string[];
  script: string;
  chapters: { heading: string; text: string }[];
  /** sentences removed because they stated a figure the sources do not contain */
  droppedSentences: number;
}

/** The angle each channel takes on the same topic. */
export const CHANNEL_FLAVOR: Record<string, string> = {
  codeorcap: "a clear developer-focused explainer: what it is, how it works step by step, a small concrete example, common mistakes",
  storiyum: "a storyteller: tell it as a story with scenes and people, and close with the moral and one memorable punchline",
  prompt_gag: "a finance explainer: what is happening in the market and why, what different sides say, then a balanced opinion. Never advice",
  infoonspot: "an informative commentator: what happened, why it matters, and a clear personal opinion and reaction",
};

export const FINANCE_DISCLAIMER = "यह वीडियो सिर्फ जानकारी के लिए है, यह वित्तीय सलाह नहीं है। निवेश से पहले अपने सलाहकार से जरूर पूछें।";

const STYLE_RULES = [
  "Write in HINDI, DEVANAGARI script only (no Roman letters). Conversational spoken Hindi, short sentences, as if talking to a friend.",
  "English tech or finance words are spelled phonetically in Devanagari (for example: स्प्रिंग बूट, मार्केट, सेंसेक्स).",
  "Plain prose for a narrator to read aloud: no headings, no bullet points, no markdown, no emojis, no stage directions, no sound effects.",
  "Use a number or statistic ONLY if it appears in the SOURCES. If a figure is not in the sources, describe it without a figure.",
  "Do not invent quotes, people, studies, prices or dates.",
].join("\n");

const trimTo = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function outlinePrompt(r: ScriptRequest, n: number): string {
  const flavor = CHANNEL_FLAVOR[r.channelKey] ?? CHANNEL_FLAVOR.infoonspot;
  return [
    `You plan a ${Math.round(r.targetWords / 134)}-minute YouTube video for the channel "${r.brandName}".`,
    `Angle: ${flavor}.`,
    `Topic: ${r.topic}`,
    `The channel's short video on this said: ${trimTo(r.seedText, 1200)}`,
    "",
    `SOURCES:\n${trimTo(r.research, 9000) || "(none found: use only what the short said and common knowledge, with no figures)"}`,
    "",
    `Return ONLY JSON: {"title": "...", "description": "...", "tags": ["..."], "chapters": [{"heading": "...", "points": ["..."]}]}`,
    `- exactly ${n} chapters; the first is a 15-second hook, the last is a recap and a call to subscribe`,
    "- title: Hindi (Devanagari), at most 90 characters, no clickbait that the video does not deliver",
    "- description: 2-3 Hindi sentences; tags: 5-10 short tags",
    "- each chapter has 2-4 concrete points that come from the sources or the short",
  ].join("\n");
}

export function chapterPrompt(r: ScriptRequest, outline: { heading: string; points: string[] }[], i: number, words: number, prevEnd: string): string {
  const ch = outline[i];
  const flavor = CHANNEL_FLAVOR[r.channelKey] ?? CHANNEL_FLAVOR.infoonspot;
  const last = i === outline.length - 1;
  return [
    `You are writing chapter ${i + 1} of ${outline.length} of the narration of a video for "${r.brandName}" (${flavor}).`,
    `Video topic: ${r.topic}`,
    `Full outline: ${outline.map((o, k) => `${k + 1}. ${o.heading}`).join(" | ")}`,
    `This chapter: "${ch.heading}". Cover: ${ch.points.join("; ")}`,
    prevEnd ? `The previous chapter ended with: "${prevEnd}". Continue naturally from it; do not repeat it or greet again.` : "This is the opening: start with a strong hook in the first sentence.",
    last ? `This is the last chapter: a short recap, then ask the viewer to like and subscribe to ${r.brandName}.` : "",
    "",
    `SOURCES:\n${trimTo(r.research, 7000) || "(none)"}`,
    "",
    STYLE_RULES,
    `Length: about ${words} words. Output ONLY the narration text of this chapter.`,
  ].filter(Boolean).join("\n");
}

/** Removes what a narrator must not read: markdown, bullets, headings, emojis, "Chapter 3:" labels, quotes around the text. */
export function cleanNarration(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*#{1,6}\s.*$/gm, " ")
    .replace(/^\s*(chapter|अध्याय|भाग)\s*\d+\s*[:.\-–]?.*$/gim, " ")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/[\p{Extended_Pictographic}️‍]/gu, "")
    .replace(/^["“”']+|["“”']+$/g, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export const splitSentences = (text: string): string[] =>
  text.split(/(?<=[।.!?])\s+/).map((s) => s.trim()).filter(Boolean);

/** Drops sentences that state a figure the sources do not contain. Returns the cleaned text and how many were dropped. */
export function dropUnsupportedFigures(text: string, sourceText: string): { text: string; dropped: number } {
  const allowed = new Set(numbersIn(sourceText));
  let dropped = 0;
  const kept = splitSentences(text).filter((s) => {
    const bad = numbersIn(s).some((n) => !allowed.has(n));
    if (bad) dropped++;
    return !bad;
  });
  return { text: kept.join(" "), dropped };
}

const isDevanagariHeavy = (s: string): boolean => {
  const letters = s.replace(/[^\p{L}]/gu, "");
  if (!letters) return false;
  const dev = (letters.match(/[ऀ-ॿ]/g) || []).length;
  return dev / letters.length > 0.6;
};

export async function writeLongScript(r: ScriptRequest, ask: Ask): Promise<ScriptPackage> {
  const n = r.chapters ?? 8;
  const perChapter = Math.round(r.targetWords / n);

  // 1) outline (a bad answer falls back to a generic outline: the chapters still follow the sources)
  let outline: { heading: string; points: string[] }[] = [];
  let title = r.topic, description = "", tags: string[] = [];
  try {
    const parsed = parseAiJson(await ask(outlinePrompt(r, n))) as any;
    if (Array.isArray(parsed?.chapters)) {
      outline = parsed.chapters
        .map((c: any) => ({ heading: String(c?.heading ?? "").trim(), points: (Array.isArray(c?.points) ? c.points : []).map(String) }))
        .filter((c: any) => c.heading);
    }
    if (typeof parsed?.title === "string" && parsed.title.trim()) title = parsed.title.trim();
    if (typeof parsed?.description === "string") description = parsed.description.trim();
    if (Array.isArray(parsed?.tags)) tags = parsed.tags.map((t: any) => String(t).replace(/^#/, "").trim()).filter(Boolean).slice(0, 12);
  } catch { /* fall through to the generic outline */ }
  if (outline.length < 3) {
    const generic = ["शुरुआत", "असली मुद्दा क्या है", "पीछे की कहानी", "कैसे काम करता है", "एक उदाहरण", "आम गलतियाँ", "अलग-अलग राय", "निष्कर्ष और आगे क्या"];
    outline = generic.slice(0, n).map((h) => ({ heading: h, points: [r.topic] }));
  }
  outline = outline.slice(0, n);

  // 2) one call per chapter, each given the end of the previous one so the video reads as one piece
  const chapters: { heading: string; text: string }[] = [];
  let prevEnd = "";
  for (let i = 0; i < outline.length; i++) {
    let text = "";
    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      const raw = await ask(chapterPrompt(r, outline, i, perChapter, prevEnd));
      const c = cleanNarration(raw);
      if (c && wordsOf(c) >= Math.round(perChapter * 0.3) && isDevanagariHeavy(c)) text = c;
    }
    if (!text) throw new Error(`chapter ${i + 1} ("${outline[i].heading}") could not be written in Devanagari`);
    chapters.push({ heading: outline[i].heading, text });
    prevEnd = splitSentences(text).slice(-1)[0] ?? "";
  }

  // 3) figures the sources do not contain are removed, never kept "because the model sounded sure"
  let dropped = 0;
  for (const c of chapters) {
    const d = dropUnsupportedFigures(c.text, r.research + "\n" + r.seedText);
    c.text = d.text;
    dropped += d.dropped;
  }

  // 4) finance: the spoken disclaimer after the opening and at the very end (deterministic, not left to the model)
  if (FINANCE_CHANNELS.has(r.channelKey)) {
    chapters[0].text = `${chapters[0].text} ${FINANCE_DISCLAIMER}`;
    chapters[chapters.length - 1].text = `${chapters[chapters.length - 1].text} ${FINANCE_DISCLAIMER}`;
  }

  // 5) length: trim from the middle chapters' tails when long; one expansion call per short chapter when short
  const total = () => chapters.reduce((a, c) => a + wordsOf(c.text), 0);
  const hi = Math.round(r.targetWords * 1.06);
  const lo = Math.round(r.targetWords * 0.94);
  for (let guard = 0; guard < 400 && total() > hi; guard++) {
    const idx = chapters.map((c, i) => ({ i, w: wordsOf(c.text) })).filter((x) => x.i > 0 && x.i < chapters.length - 1).sort((a, b) => b.w - a.w)[0];
    if (!idx) break;
    const sents = splitSentences(chapters[idx.i].text);
    if (sents.length <= 2) break;
    sents.pop();
    chapters[idx.i].text = sents.join(" ");
  }
  for (let pass = 0; pass < 2 && total() < lo; pass++) {
    const shortest = chapters.map((c, i) => ({ i, w: wordsOf(c.text) })).filter((x) => x.i > 0 && x.i < chapters.length - 1).sort((a, b) => a.w - b.w)[0];
    if (!shortest) break;
    const need = Math.min(perChapter, lo - total() + 40);
    const more = cleanNarration(await ask(
      `${chapterPrompt(r, outline, shortest.i, wordsOf(chapters[shortest.i].text) + need, "")}\n\nThe chapter so far is below. Rewrite it fuller, keeping every fact, to about ${wordsOf(chapters[shortest.i].text) + need} words:\n${chapters[shortest.i].text}`,
    ));
    if (more && isDevanagariHeavy(more)) {
      const d = dropUnsupportedFigures(more, r.research + "\n" + r.seedText);
      dropped += d.dropped;
      chapters[shortest.i].text = d.text || chapters[shortest.i].text;
    }
  }

  const script = chapters.map((c) => c.text).join("\n\n");
  const finance = FINANCE_CHANNELS.has(r.channelKey);
  return {
    title: trimTo(title, 100),
    description: [description, finance ? FINANCE_DISCLAIMER : ""].filter(Boolean).join("\n\n"),
    tags,
    script,
    chapters,
    droppedSentences: dropped,
  };
}
