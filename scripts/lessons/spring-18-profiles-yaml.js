// Generates the plan-only JSON for the ~20 minute ENGLISH tutorial:
// "Spring Boot Profiles and YAML: Dev vs Prod Configuration" (Spring Boot Full Course #18)
// Source: the lecture transcript (Hindi, 51 minutes). The lesson keeps its flow (code vs configuration per environment, why hard coding hurts,
// properties vs YAML, profile files and spring.profiles.active, external configuration through the command line, the Profile annotation) and
// retells it in new words; repeated typing and tangents are cut. Transcript slips are fixed (9090 for dev, 8191 for prod).
// The narration is spoken by the cloned Voicebox voice (English, turbo engine); every scene carries "ttsText" (see spring-18/lib.js).
//   node spring-18-profiles-yaml.js out.json
const fs = require("fs");
const L = require("./spring-18/lib");

for (const chapterFile of ["c01", "c02", "c03", "c04"]) require(`./spring-18/${chapterFile}`)();
const scenes = L.scenes;

for (const s of scenes) {
  const bad = s.ttsText.match(/[@{}\[\]<>()_\\/=#*~|$]/g);
  if (bad) throw new Error(`Scene ${s.i}: unspeakable characters ${[...new Set(bad)].join(" ")} in ttsText: ${s.ttsText}`);
}
scenes.forEach((sc, k) => { sc.i = k; });

const words = scenes.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0);
const spoken = scenes.reduce((n, s) => n + s.ttsText.trim().split(/\s+/).length, 0);
const chars = scenes.reduce((n, s) => n + s.ttsText.length, 0);
const longest = scenes.reduce((m, s) => Math.max(m, s.text.trim().split(/\s+/).length), 0);
const thinking = scenes.reduce((n, s) => n + (s.pauseAfter || 0), 0);
const estMin = (spoken / 3.18 + thinking) / 60;

const plan = {
  title: "Spring Boot Profiles & YAML Explained: Dev vs Prod Configuration | Spring Boot Full Course #18",
  description:
    "The same Spring Boot code must run on local, dev, staging and production, but the configuration is different in each. In this video you will see " +
    "why hard coding values hurts, how application.properties and application.yml differ, how to make one file per environment with " +
    "spring.profiles.active, how to choose a profile from the command line so the same jar runs everywhere, and how the Profile annotation " +
    "creates a different bean (dummy or real) for each environment.\n\n" +
    "Chapters: 1 Same code, different configuration | 2 Why we never hard code it | 3 YAML versus properties | 4 Profiles: one file per environment | " +
    "5 External configuration | 6 The Profile annotation | 7 Recap\n\n" +
    "Based on Spring Boot Full Course Lecture 18.\n\n#SpringBoot #SpringProfiles #YAML #Java #CodeOrCap",
  tags: ["Spring Boot", "Spring Profiles", "application.yml", "application.properties", "Profile annotation", "spring.profiles.active", "YAML", "Environment configuration", "Java", "Spring Boot Full Course", "CodeOrCap"],
  voice: "voicebox-en",
  language: "en",
  scenes,
};

const out = process.argv[2] || "spring18-plan.json";
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
console.log(`scenes=${scenes.length} words=${words} spoken words=${spoken} (longest scene ${longest} words) speech chars=${chars} => about ${estMin.toFixed(1)} min with the thinking time -> ${out}`);
