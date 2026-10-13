// Shared helpers for the lesson "Spring Boot Filters: FilterChain, Logging, Auth & Request Flow" (Spring Boot Full Course #19).
// Everything on screen is English: a scene's "text" is the caption, and the code, labels and quizzes are English too.
// The narration is HINDI: every scene carries a hand-written "ttsText" (Devanagari, with each English term spelled the way it is
// said, e.g. "फ़िल्टर", "डू फ़िल्टर"). The build fails when a Latin letter or a digit is left in a ttsText, because the Hindi voice model
// stumbles on them (see spring-19-filters.js).

const scenes = [];
let curSetting = "stage";
let chapterPending = null;
let pi = 0;
const POSES = ["present", "point", "think", "smug", "idle", "present", "point", "shrug"];

/** add(caption, hindiVoiceText, visuals) */
function add(text, ttsText, vis = {}) {
  if (typeof ttsText !== "string" || !ttsText.trim()) throw new Error(`Scene without Hindi voice text: ${text}`);
  const v = { pose: POSES[pi++ % POSES.length], mood: "neutral", accent: "gold", setting: curSetting, ...vis };
  if (chapterPending) { v.chapter = chapterPending; chapterPending = null; }
  scenes.push({ i: scenes.length, text, ttsText, ...v });
}
const chapter = (name, setting) => { chapterPending = name; curSetting = setting; };

/**
 * A "pause the video" quiz in beats: (the first time) how it works; the question with the options on screen and a thinking
 * countdown (pauseAfter); then the answer with its explanation. Captions English, voice Hindi.
 */
let quizzes = 0;
const LETTERS = ["A", "B", "C", "D"];
const HI_LETTERS = ["ए", "बी", "सी", "डी"];
function ask(question, options, answer, explanation, hi, thinkSeconds = 9.5) {
  if (quizzes++ === 0) {
    add("Here is a quick quiz. Pause the video, choose an answer, then press play to check it.",
      "ये रहा आपका पहला क्विज़। वीडियो को पॉज़ करिए, जवाब सोचिए, और फिर प्ले करके जाँच लीजिए।", { pose: "present", mood: "excited" });
  }
  const cue = options.length >= 4 ? "Is it A, B, C, or D?" : options.length === 3 ? "Is it A, B, or C?" : "Is it A or B?";
  const hiCue = options.length >= 4 ? "ए, बी, सी, या डी?" : options.length === 3 ? "ए, बी, या सी?" : "ए या बी?";
  add(`Pause the video, and think. ${question} ${cue}`, `वीडियो को पॉज़ करिए, और सोचिए। ${hi.q} ${hiCue}`,
    { pose: "point", mood: "excited", pauseAfter: thinkSeconds, quiz: { question, options, answer, revealBeforeEnd: 1.5 } });
  add(`The answer is ${LETTERS[answer]}. ${explanation}`, `जवाब है ${HI_LETTERS[answer]}। ${hi.a}`,
    { pose: "celebrate", mood: "happy", alert: { kind: "success", title: `Answer: ${LETTERS[answer]}`, detail: options[answer].slice(0, 48) } });
}

const code = (title, language, lines, o = {}) => ({ code: { title, language, lines, ...o } });
const term = (lines, title = "Run") => ({ terminal: { title, lines } });
const flow = (nodes, active, packet) => ({ flow: { nodes, active, packet } });
const steps = (items, current) => ({ steps: { items, current } });
const scene = (background, items, arrows = []) => ({ scene: { background, items, arrows } });
const alert = (kind, title, detail) => ({ alert: { kind, title, detail } });
const compare = (mode, cards) => ({ compare: { mode, cards } });
const browser = (url, kind, lines, heading) => ({ browser: { url, kind, lines, heading } });
const table = (name, columns, rows, highlightRow) => ({ table: { name, columns, rows, highlightRow } });

// Progressive code: revealFrom is the length of the common prefix with the previous snapshot of the same file.
const lastCode = {};
function snap(title, language, lines, o = {}) {
  const prev = lastCode[title] || [];
  let k = 0;
  while (k < prev.length && k < lines.length && prev[k] === lines[k]) k++;
  lastCode[title] = lines;
  return code(title, language, lines, { revealFrom: Math.min(k, lines.length - 1), animate: "type", ...o });
}

module.exports = { ask, scenes, add, chapter, code, term, flow, steps, scene, alert, compare, browser, table, snap };
