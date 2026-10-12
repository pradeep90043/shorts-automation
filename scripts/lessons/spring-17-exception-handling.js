// Generates the plan-only JSON for the ~20 minute ENGLISH tutorial:
// "Exception Handling in Spring Boot: Make Your APIs Professional" (Spring Boot Full Course #17)
// Source: the lecture transcript (Hindi, 87 minutes). The lecture's flow is kept (response anatomy and status codes, why the controller
// should not handle exceptions, Spring Boot's default handling, GlobalExceptionHandler, custom exceptions, one error DTO, validation
// errors); the transcript's recognition slips are fixed (400 "not found" is 404, "49" is 409, "2001" is 201), and long repeated
// stretches of coding are condensed so the lesson lands on about 20 minutes.
// The narration is spoken by the cloned Voicebox voice (English, turbo engine, 1.0x, no denoise); every scene carries "ttsText": the
// caption with CamelCase names split into words and symbols spelled out (see spring-17/lib.js).
//   node spring-17-exception-handling.js out.json
const fs = require("fs");
const L = require("./spring-17/lib");

for (const chapterFile of ["c01", "c02", "c03", "c04", "c05"]) require(`./spring-17/${chapterFile}`)();
const scenes = L.scenes;

// the voice must never be handed characters it would stumble on
for (const s of scenes) {
  const bad = s.ttsText.match(/[@{}\[\]<>()_\\/=#*~|]/g);
  if (bad) throw new Error(`Scene ${s.i}: unspeakable characters ${[...new Set(bad)].join(" ")} in ttsText: ${s.ttsText}`);
}

// Scenes cut to land on about 20 minutes (the full script is ~30 minutes of speech: the lecture is 87). A cut scene's chapter title moves to
// the next one. spring-17/drop.json lists the first 40 characters of each cut scene (the points a neighbouring scene already makes).
const DROP = require("./spring-17/drop.json");
for (let k = scenes.length - 1; k >= 0; k--) {
  if (!DROP.some((d) => scenes[k].text.startsWith(d))) continue;
  if (scenes[k].chapter && scenes[k + 1] && !scenes[k + 1].chapter) scenes[k + 1].chapter = scenes[k].chapter;
  scenes.splice(k, 1);
}
scenes.forEach((sc, k) => { sc.i = k; });

const words = scenes.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0);
const spoken = scenes.reduce((n, s) => n + s.ttsText.trim().split(/\s+/).length, 0);
const chars = scenes.reduce((n, s) => n + s.ttsText.length, 0);
const longest = scenes.reduce((m, s) => Math.max(m, s.text.trim().split(/\s+/).length), 0);
// The cloned English voice speaks 3.18 words a second at natural speed (measured on 12 scenes); every quiz adds its thinking time (pauseAfter).
const thinking = scenes.reduce((n, s) => n + (s.pauseAfter || 0), 0);
const estMin = (spoken / 3.18 + thinking) / 60;

const plan = {
  title: "Exception Handling in Spring Boot: Make Your APIs Professional | Spring Boot Full Course #17",
  description:
    "Why a professional API never answers 200 for everything, and how exception handling in Spring Boot fixes it. In this video you will see what an API " +
    "response is made of (status code, headers, body), the HTTP status code families, why the controller should not handle exceptions, what Spring Boot does by default " +
    "with an unhandled exception, and then build a GlobalExceptionHandler with RestControllerAdvice and ExceptionHandler, custom exceptions " +
    "(ResourceNotFoundException for 404, DuplicateResourceException for 409), one error response DTO, and validation errors that list every field.\n\n" +
    "Chapters: 1 Why exception handling | 2 Our app and cleaner endpoints | 3 The controller does too much | 4 HTTP status codes | " +
    "5 The Global Exception Handler | 6 Our own exceptions | 7 Cleaning the controller and service | 8 One error response for everyone | " +
    "9 Validation errors | 10 Recap\n\n" +
    "Based on Spring Boot Full Course Lecture 17.\n\n#SpringBoot #ExceptionHandling #Java #RestAPI #CodeOrCap",
  tags: ["Spring Boot", "Exception Handling", "RestControllerAdvice", "ExceptionHandler", "Global Exception Handler", "Custom exception", "HTTP status codes", "REST API", "Java", "Spring Boot Full Course", "CodeOrCap"],
  voice: "voicebox-en",
  language: "en",
  scenes,
};

const out = process.argv[2] || "spring17-plan.json";
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
console.log(`scenes=${scenes.length} words=${words} spoken words=${spoken} (longest scene ${longest} words) speech chars=${chars} => about ${estMin.toFixed(1)} min with the thinking time -> ${out}`);
