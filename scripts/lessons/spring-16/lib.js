// Shared helpers for the English lesson "DTOs & Validations in Spring Boot" (Spring Boot Full Course #16).
// A scene's "text" is the caption (simple English with the real class and annotation names); "ttsText" is what the cloned voice
// speaks: the same sentence with CamelCase names split into words, symbols and acronyms spelled out, so an English voice reads
// "CreateStudentRequestDTO" as "Create Student Request D T O" instead of one garbled word.

const scenes = [];
let curSetting = "stage";
let chapterPending = null;
let pi = 0;
const POSES = ["present", "point", "think", "smug", "idle", "present", "point", "shrug"];

// whole words said letter by letter, or with a spoken form
const SAY = {
  DTO: "D T O", DTOs: "D T Os", API: "A P I", APIs: "A P Is", JSON: "Jason", HTTP: "H T T P", URL: "U R L", SQL: "sequel", JPA: "J P A",
  Jpa: "J P A", Id: "I D", MySQL: "My S Q L", DB: "D B", IDE: "I D E", IntelliJ: "Intelli J", POJO: "pojo", JSP: "J S P", CRUD: "crud", REST: "rest", ID: "I D", id: "I D",
  UI: "U I", XML: "X M L", HTML: "H T M L", MVC: "M V C", OK: "okay", GET: "get", POST: "post", PUT: "put", DELETE: "delete", PATCH: "patch",
  "@": "", "~": "", "->": "to", "=": "equals", "==": "equals", "&": "and", "+": "plus", "#": "number",
};
// status codes read the way people say them
const CODES = { 200: "two hundred", 201: "two oh one", 400: "four hundred", 404: "four oh four", 500: "five hundred" };

/** Caption text -> what the voice says. */
function speak(text) {
  let out = text
    .replace(/\//g, " slash ")
    .replace(/\\/g, " ")
    .replace(/["“”`]/g, "")
    .replace(/[{}[\]<>()]/g, " ")
    .replace(/_/g, " ")
    .replace(/(?<=[A-Za-z])-(?=[A-Za-z])/g, " ") // spring-boot-starter-validation -> spring boot starter validation
    .replace(/=/g, " equals ")
    .replace(/\.(?=[A-Za-z])/g, " dot ") // application.properties -> application dot properties
    .replace(/@(?=[A-Za-z])/g, "");
  out = out.replace(/\b[A-Za-z][A-Za-z0-9]*\b/g, (w) => {
    if (SAY[w] !== undefined) return SAY[w];
    // CamelCase -> words; a trailing acronym keeps its letters (CreateStudentRequestDTO -> Create Student Request D T O)
    const parts = w.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" ");
    return parts.map((p) => (SAY[p] !== undefined ? SAY[p] : p)).join(" ");
  });
  out = out.replace(/\b(200|201|400|404|500)\b/g, (n) => CODES[n]);
  out = out.replace(/\s+([,.;:!?])/g, "$1").replace(/\s+/g, " ").trim();
  return out;
}

function add(text, vis = {}) {
  const v = { pose: POSES[pi++ % POSES.length], mood: "neutral", accent: "gold", setting: curSetting, ...vis };
  if (chapterPending) { v.chapter = chapterPending; chapterPending = null; }
  const ttsText = vis.ttsText ? vis.ttsText : speak(text);
  delete v.ttsText;
  scenes.push({ i: scenes.length, text, ttsText, ...v });
}
const chapter = (name, setting) => { chapterPending = name; curSetting = setting; };

const code = (title, language, lines, o = {}) => ({ code: { title, language, lines, ...o } });
const term = (lines, title = "Run") => ({ terminal: { title, lines } });
const flow = (nodes, active, packet) => ({ flow: { nodes, active, packet } });
const steps = (items, current) => ({ steps: { items, current } });
const scene = (background, items, arrows = []) => ({ scene: { background, items, arrows } });
const quiz = (question, options, answer, revealAt = 0.65) => ({ quiz: { question, options, answer, revealAt } });
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

module.exports = { scenes, add, chapter, code, term, flow, steps, scene, quiz, alert, compare, browser, table, snap, speak };
