// Generates the plan-only JSON for the ~20 minute tutorial (English on screen, HINDI voice):
// "Spring Boot Filters: FilterChain, Logging, Auth & Request Flow" (Spring Boot Full Course #19)
// Source: the lecture transcript (66 minutes). Kept: why the work does not belong in the controller, where a filter sits, what it can do,
// the Filter interface and FilterChain, a LoggingFilter (method, URI, status, request ID, timing, try/finally), an AuthenticationFilter
// (token, X-API-KEY, 401 and an error body), and ordering with @Order. Left out: nothing the lecture never said is added.
// Captions, code and quizzes are English; every scene's "ttsText" is Hindi in Devanagari for the cloned Voicebox voice.
//   node spring-19-filters.js out.json
const fs = require("fs");
const L = require("./spring-19/lib");

for (const chapterFile of ["c01", "c02", "c03", "c04", "c05"]) require(`./spring-19/${chapterFile}`)();
const scenes = L.scenes;

// the Hindi voice model must never be handed Latin letters or digits
for (const s of scenes) {
  const left = s.ttsText.match(/[A-Za-z0-9@_/\\=#*~|{}<>]+/g);
  if (left) throw new Error(`Scene ${s.i}: unspeakable text in ttsText (${[...new Set(left)].join(", ")}): ${s.ttsText}`);
  const words = s.text.trim().split(/\s+/).length;
  if (words > 38) throw new Error(`Scene ${s.i}: caption is ${words} words (max 40): ${s.text}`);
  for (const k of ["code", "terminal", "browser"]) {
    for (const line of s[k]?.lines || []) if (line.length > 56) throw new Error(`Scene ${s.i}: ${k} line over 56 characters: ${line}`);
    if ((s[k]?.lines || []).length > 14) throw new Error(`Scene ${s.i}: ${k} panel has more than 14 lines`);
  }
}

// Scenes cut to land on about 20 minutes (each repeats a point a neighbouring scene already makes). A cut scene's chapter title moves to the next one.
const DROP = [
  "So let us understand this topic properly", "That is the whole architecture we know so far", "We already moved validation to exception handling",
  "A third party integration does exactly this", "A filter can read headers, cookies", "Nothing else changes. We just add one new layer",
  "Ninety percent of the time", "Init and destroy are default methods", "FilterChain is an interface too", "That is our simple authentication filter",
  "We could put it in one separate class", "In a real app we would write this to a log file", "The ID is unique for this one API call",
  "For now, a simple rule", "That is all we had to do",
];
for (let k = scenes.length - 1; k >= 0; k--) {
  if (!DROP.some((d) => scenes[k].text.startsWith(d))) continue;
  if (scenes[k].chapter && scenes[k + 1] && !scenes[k + 1].chapter) scenes[k + 1].chapter = scenes[k].chapter;
  scenes.splice(k, 1);
}
scenes.forEach((sc, k) => { sc.i = k; });

// A beat that goes on explaining the previous beat's example keeps that panel on screen (up to 3 beats), so the viewer is never left
// with an empty screen while an example is being talked about. Intro, outro and a new chapter start clean; quiz / alert panels are one-beat moments.
const PANELS = ["code", "terminal", "browser", "table", "steps", "flow", "compare", "container", "scene", "alert", "quiz"];
const CARRY = ["code", "terminal", "browser", "table", "steps", "flow", "compare", "container", "scene"];
let run = 0, carried = 0;
for (let k = 1; k < scenes.length - 2; k++) {
  const prev = scenes[k - 1], cur = scenes[k];
  if (PANELS.some((x) => cur[x])) { run = 0; continue; }
  const key = CARRY.find((x) => prev[x]);
  if (!key || cur.chapter || run >= 3 || cur.text.startsWith("Here is a quick quiz")) { run = 0; continue; }
  const panel = JSON.parse(JSON.stringify(prev[key]));
  if (key === "code") { delete panel.revealFrom; panel.animate = "lines"; }
  cur[key] = panel;
  delete cur.props;
  run++;
  carried++;
}

const words = scenes.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0);
const chars = scenes.reduce((n, s) => n + s.ttsText.length, 0);
const longest = scenes.reduce((m, s) => Math.max(m, s.text.trim().split(/\s+/).length), 0);
const thinking = scenes.reduce((n, s) => n + (s.pauseAfter || 0), 0);
const estMin = (chars / 13 + thinking) / 60; // about 13 characters of Hindi are spoken per second (measured on the cloned voice)

const plan = {
  title: "Spring Boot Filters: FilterChain, Logging, Auth & Request Flow | Spring Boot Full Course #19",
  description:
    "Where should logging, authentication and a request ID live in a Spring Boot app? Not in every controller. In this video you will see what a filter is, " +
    "where it sits before the DispatcherServlet, how the Filter interface (init, doFilter, destroy) and the FilterChain work, and then build a LoggingFilter " +
    "(method, URI, status, request ID header, response time, try and finally) and an AuthenticationFilter (token, X-API-KEY, 401 with an error body). " +
    "Finally we chain both filters in order with @Order.\n\n" +
    "Chapters: 1 The problem before the controller | 2 What is a filter? | 3 Our first filter | 4 The FilterChain | 5 A real LoggingFilter | " +
    "6 Authentication in a filter | 7 Chaining filters with @Order | 8 Recap\n\n" +
    "Narration in Hindi, on-screen text in English. Based on Spring Boot Full Course Lecture 19.\n\n#SpringBoot #Filters #FilterChain #Java #CodeOrCap",
  tags: ["Spring Boot", "Filters", "FilterChain", "Servlet Filter", "LoggingFilter", "Authentication filter", "Order annotation", "Spring Boot Hindi", "Java", "Spring Boot Full Course", "CodeOrCap"],
  voice: "voicebox",
  language: "hi",
  scenes,
};

const out = process.argv[2] || "spring19-plan.json";
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
console.log(`carried a panel onto ${carried} beats`);
console.log(`scenes=${scenes.length} caption words=${words} (longest scene ${longest}) speech chars=${chars} thinking=${thinking}s => about ${estMin.toFixed(1)} min -> ${out}`);
