// Generates the plan-only JSON for the ~20 minute ENGLISH tutorial:
// "DTOs & Validations in Spring Boot: Make Your REST API Professional" (Spring Boot Full Course #16)
// Source: the lecture transcript (Hindi). Names, code, flows and outputs come from it; what it never says (ModelMapper, record DTOs,
// ControllerAdvice, MethodArgumentNotValidException, Lombok) is left out, and the lesson ends where the lecture does: the validation
// works, but its custom messages need exception handling, which is the next video.
// The narration is spoken by the cloned Voicebox voice (English, turbo engine); every scene carries "ttsText": the caption with
// CamelCase names split into words and symbols spelled out (see spring-16/lib.js).
//   node spring-16-dto-validation.js out.json
const fs = require("fs");
const L = require("./spring-16/lib");

for (const chapterFile of ["c01", "c02", "c03", "c04", "c05"]) require(`./spring-16/${chapterFile}`)();
const scenes = L.scenes;

// the voice must never be handed characters it would stumble on
for (const s of scenes) {
  const bad = s.ttsText.match(/[@{}\[\]<>()_\\/=#*~|]/g);
  if (bad) throw new Error(`Scene ${s.i}: unspeakable characters ${[...new Set(bad)].join(" ")} in ttsText: ${s.ttsText}`);
}

// Scenes cut to land on about 20 minutes (they repeat a point made by a neighbouring scene). A cut scene's chapter title moves to the next one.
const DROP = [
  "First, why DTOs exist, by looking", "Then we build them, one request at a time", "The request then moves to the service, where", "In a tiny project, this works fine",
  "Then we generate the getters and setters", "That avoids a mismatch between starters", "Valid tells Spring to apply every rule", "Until we customize how errors are handled",
  "Later, we will also see the Builder pattern", "The three most common are easy to mix up", "If streams are new to you", "Delete and soft delete need no DTO",
  "Quick check. Why is using the entity as the request body risky?", "Quick check. Which one rejects null", "One last question. Why does Postman", "One question to check. Why does the update DTO",
];
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
// English is spoken at about 2.5 words per second by the cloned voice (measured: 683 characters in 55 s for Hindi; English is a little faster)
const estMin = spoken / 2.5 / 60;

const plan = {
  title: "DTOs & Validations in Spring Boot: Make Your REST API Professional | Spring Boot Full Course #16",
  description:
    "Why you should never use your entity as the request and the response, and how DTOs and validations fix it. In this video you will see the three " +
    "real problems of using an entity everywhere (the client can send fields like deleted and createdAt, the response leaks internal data, and your API " +
    "is tightly coupled to your database), then build a request DTO, a response DTO and separate create and update DTOs in a Spring Boot REST API, map " +
    "them in the service layer, and add validations with the validation starter: NotBlank, NotNull, NotEmpty, Email, Min, Size and Valid. " +
    "The video ends where the lecture does: the validation works, but custom error messages need exception handling, which comes next.\n\n" +
    "Chapters: 1 Your API works, is it safe? | 2 One class, too many jobs | 3 Before DTOs | 4 The client sends too much | 5 The response leaks | " +
    "6 Tight coupling | 7 What is a DTO | 8 The request DTO | 9 Mapping and the response DTO | 10 The demo | 11 Decoupling | 12 Create and update DTOs | " +
    "13 Why validations | 14 The validation starter | 15 Annotations and Valid | 16 The demo | 17 Recap\n\n" +
    "Based on Spring Boot Full Course Lecture 16. Next video: exception handling.\n\n#SpringBoot #DTO #Validation #Java #CodeOrCap",
  tags: ["Spring Boot", "DTO", "Data Transfer Object", "Spring Boot validation", "NotBlank", "Valid", "REST API", "Java", "Spring Boot Full Course", "CodeOrCap"],
  voice: "voicebox-en",
  language: "en",
  scenes,
};

const out = process.argv[2] || "spring16-plan.json";
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
console.log(`scenes=${scenes.length} words=${words} spoken words=${spoken} (longest scene ${longest} words) speech chars=${chars} => about ${estMin.toFixed(1)} min of speech -> ${out}`);
