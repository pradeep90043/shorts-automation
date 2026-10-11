import assert from "assert";
import { CONTENT_THEMES } from "../src/config/themes";

// CodeOrCap (tech theme): the description must list every item the reel shows, with its use,
// because the caption and the reaction sticker hide some of them on screen.
const rules = CONTENT_THEMES.tech.descriptionRules("CodeOrCap");
assert.ok(rules.includes("EVERYTHING SHOWN IN THE REEL"), "lists the items shown in the reel");
assert.ok(/EVERY item/.test(rules) && /what it is used for/.test(rules), "every item, with its use");
assert.ok(/caption and reaction sticker hide/.test(rules), "explains why: items hidden on screen");
assert.ok(/transcript/.test(rules) && /ALL the frames/.test(rules), "items come from all frames and the transcript");

// the required parts are all still there, in order
const order = ["What the video is about", "What you'll learn", "EVERYTHING SHOWN", "Who it's for", "Fact Check Score", "Subscribe CTA to @CodeOrCap", "CONTENT SOURCE/CREDIT", "#science"];
let at = -1;
for (const part of order) {
  const i = rules.indexOf(part);
  assert.ok(i > at, `"${part}" is present and in order`);
  at = i;
}

console.log("✓ description rules");
