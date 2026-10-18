/**
 * Checks that run before a generated 10-minute video is allowed to go public. Pure and strict: a failure leaves the
 * video private and raises an alert; nothing here "fixes" content silently except removing unsupported numbers upstream.
 */
export interface GuardInput {
  channelKey: string;
  script: string;
  title: string;
  description?: string;
  /** the fetched source text the script was written from: every figure in the script must be found in it */
  sourceText: string;
  targetWords: number;
  /** allowed deviation from the target, default 0.08 */
  tolerance?: number;
}

export interface GuardResult {
  ok: boolean;
  problems: string[];
  words: number;
  unsupportedNumbers: string[];
}

/** Channels whose content is about money: they need the disclaimer and the stricter phrase list. */
export const FINANCE_CHANNELS = new Set(["prompt_gag"]);

const DEVANAGARI_DIGITS = "०१२३४५६७८९";
const toAscii = (s: string): string => s.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));

export const wordsOf = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** Numbers as they would be heard: 1,234.5 -> "1234.5"; Devanagari digits normalised; single digits ignored. */
export function numbersIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of toAscii(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, "");
    if (n.length >= 2 || n.includes(".")) out.add(n);
  }
  return [...out];
}

const PLACEHOLDER = /\[[^\]]{0,40}\]|\bTODO\b|\bTBD\b|lorem ipsum|\{\{[^}]*\}\}|<[^>]+>/i;

/** Advice and promises a finance channel must never make. Hindi (Devanagari and Roman) and English. */
const FINANCE_BANNED: RegExp[] = [
  /\bbuy (this|these|it now)\b/i, /\bsell (this|these|it now)\b/i, /\bguaranteed (returns?|profit)\b/i,
  /\bdouble your money\b/i, /\brisk[- ]?free\b/i, /\bsure[- ]?shot\b/i, /\bnext multibagger\b/i,
  /खरीद\s*लो/, /बेच\s*दो/, /गारंटीड\s*(रिटर्न|मुनाफ़?ा)/, /पक्का\s*मुनाफ़?ा/, /पैसा\s*दोगुना/, /बिना\s*रिस्क/, /शर्तिया/,
  /\bpakka (profit|munafa)\b/i, /\bkharid lo\b/i, /\bbech do\b/i,
];

const DISCLAIMER = /(वित्तीय\s*सलाह\s*नहीं|निवेश\s*सलाह\s*नहीं|सिर्फ\s*जानकारी\s*के\s*लिए|not\s+(a\s+)?financial\s+advice|educational\s+purposes?)/i;

/**
 * Harmless markup a model leaves in a spoken script: citation marks like [1], stage directions like [संगीत] / [pause], and
 * line-break tags. These are removed instead of failing a whole script. Anything that LOOKS like a template slot
 * ("[channel name]", "[यहाँ नाम]", "<insert ...>") is kept, so checkScript still rejects it.
 */
const SLOT_WORDS = /\b(name|insert|here|your|channel|topic|title|xx+|placeholder|todo|tbd)\b|यहाँ|यहां|नाम|डालें|डालिए/i;
export function cleanScriptMarkers(text: string): string {
  return text
    .replace(/\[[^\]]{0,40}\]/g, (m) => (SLOT_WORDS.test(m) ? m : ""))
    .replace(/<\/?(?:br|p|b|i|u|em|strong|span)\s*\/?>/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.!?।])/g, "$1");
}

export function checkScript(input: GuardInput): GuardResult {
  const problems: string[] = [];
  const words = wordsOf(input.script);
  const tol = input.tolerance ?? 0.08;
  const lo = Math.round(input.targetWords * (1 - tol));
  const hi = Math.round(input.targetWords * (1 + tol));
  if (words < lo || words > hi) problems.push(`length ${words} words is outside ${lo}-${hi}`);

  if (!input.title.trim()) problems.push("empty title");
  else if (input.title.length > 100) problems.push(`title is ${input.title.length} characters (max 100)`);

  const slot = PLACEHOLDER.exec(input.script) || PLACEHOLDER.exec(input.title);
  if (slot) problems.push(`unfilled placeholder in the script or title: "${slot[0].slice(0, 40)}"`);

  const source = new Set(numbersIn(input.sourceText));
  const unsupportedNumbers = numbersIn(input.script).filter((n) => !source.has(n));
  if (unsupportedNumbers.length) problems.push(`figures not found in the sources: ${unsupportedNumbers.slice(0, 8).join(", ")}`);

  if (FINANCE_CHANNELS.has(input.channelKey.toLowerCase())) {
    for (const re of FINANCE_BANNED) {
      const m = re.exec(input.script) || re.exec(input.title) || re.exec(input.description ?? "");
      if (m) problems.push(`finance: forbidden phrase "${m[0]}"`);
    }
    if (!DISCLAIMER.test(input.script)) problems.push("finance: the spoken disclaimer is missing");
    if (input.description && !DISCLAIMER.test(input.description)) problems.push("finance: the description lacks the disclaimer");
  }
  return { ok: problems.length === 0, problems, words, unsupportedNumbers };
}
