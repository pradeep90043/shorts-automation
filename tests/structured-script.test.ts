import assert from "assert";
import { cleanScript, parseStructuredScript, sceneNotesForBeats, splitScriptIntoBeats } from "../src/my-video/stickmanPlanner";

const raw = `# Spring XML-Based Configuration

## SCENE 01 — HOOK
### Duration: 0:00–0:40

### Voiceover

Have you ever opened an old Spring project?

It was full of XML.

### Stickman

Stickman opens an old laptop.

A huge XML file appears.

### Remotion Visual

Show:

\`\`\`text
OLD SPRING PROJECT
beans.xml
\`\`\`

---

# SCENE 02 — ANNOTATION VS XML

### Duration: 0:40–1:30

### Voiceover

Before XML configuration, we used annotations.

### Stickman

Show two doors.
`;
const parsed = parseStructuredScript(raw)!;
assert.ok(parsed, "detects a structured script");
assert.strictEqual(parsed.length, 2);
const narration = cleanScript(raw);
assert.ok(!/stickman|remotion|beans\.xml|duration/i.test(narration), "directions are never narrated: " + narration);
assert.ok(/old Spring project/.test(narration) && /annotations/.test(narration));
const beats = splitScriptIntoBeats(narration);
const n = sceneNotesForBeats(raw, beats)!;
assert.strictEqual(n.beatScene[0], 0);
assert.strictEqual(n.beatScene[n.beatScene.length - 1], 1);
assert.ok(/laptop/.test(n.notes[0]) && /two doors/.test(n.notes[1]));
// plain scripts are untouched
assert.strictEqual(parseStructuredScript("Hello there.\n\nThis is plain."), null);
assert.strictEqual(cleanScript("Hello there.\n\nThis is plain."), "Hello there.\n\nThis is plain.");
console.log("✓ structured scripts: only the voiceover is narrated, directions steer the visuals");
