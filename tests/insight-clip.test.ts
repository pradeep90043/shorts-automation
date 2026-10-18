import { dropUnsupportedFigures, looksEnglish } from "../src/my-video/insightClip";
import assert from "assert";
import { insightChannels, insightEnabledFor, insightFor, insightIntro, insightLang, insightRuleFor } from "../src/my-video/insightClip";
import { howItWorksLines } from "../src/my-video/howItWorksClip";

// CodeOrCap must not change: same intro line, same metadata instruction as before this module existed
assert.strictEqual(insightIntro("codeorcap", {} as any), "Let us check how is it working.");
assert.deepStrictEqual(howItWorksLines("Water cools the chips. It carries heat away."), ["Let us check how is it working.", "Water cools the chips.", "It carries heat away."]);
assert.strictEqual(
  insightFor("codeorcap").promptRule,
  "A detailed, clear, and educational explanation (approx 2-3 sentences, 30-50 words) explaining how the code snippet or trick works. " +
    "This step-by-step commentary adds original educational value to reuse of other creators' videos, so explain the logic or mechanics thoroughly and clearly.",
);

// each channel has its own kind
assert.strictEqual(insightFor("storiyum").key, "moral");
assert.strictEqual(insightFor("prompt_gag").key, "market");
assert.strictEqual(insightFor("infoonspot").key, "reaction");
assert.strictEqual(insightFor("some_new_channel").key, "how", "unknown channels get the safe default");

// the switch: all four channels by default; a list limits it; "off" removes it
assert.deepStrictEqual([...insightChannels({} as any)].sort(), ["codeorcap", "infoonspot", "prompt_gag", "storiyum"]);
assert.strictEqual(insightEnabledFor("storiyum", "v2", {} as any), true);
assert.strictEqual(insightEnabledFor("storiyum", "v2", { INSIGHT_CLIP_CHANNELS: "codeorcap" } as any), false);
assert.strictEqual(insightEnabledFor("storiyum", "v2", { INSIGHT_CLIP_CHANNELS: "codeorcap,storiyum" } as any), true);
assert.strictEqual(insightEnabledFor("codeorcap", "v2", { INSIGHT_CLIP_CHANNELS: "off" } as any), false);
assert.strictEqual(insightEnabledFor("codeorcap", "v2", { INSIGHT_CLIP_CHANNELS: "none" } as any), false);
assert.strictEqual(insightEnabledFor("storiyum", "v1", {} as any), false, "a channel set to v1 stays without the clip");
assert.strictEqual(insightEnabledFor("codeorcap", undefined, {} as any), true, "outroVersion defaults to v2 as before");

// language of the intro
assert.strictEqual(insightLang({ INSIGHT_CLIP_LANG: "hi" } as any), "hi");
// default: every channel with a Hindi voice speaks Hindi in the clip, CodeOrCap stays English; INSIGHT_CLIP_LANG overrides
assert.strictEqual(insightLang({} as any, "codeorcap"), "en");
for (const k of ["storiyum", "prompt_gag", "infoonspot"]) assert.strictEqual(insightLang({} as any, k), "hi", k);
assert.strictEqual(insightLang({ INSIGHT_CLIP_LANG: "en" } as any, "prompt_gag"), "en");
assert.strictEqual(insightIntro("codeorcap", {} as any), "Let us check how is it working.");
assert.strictEqual(insightIntro("prompt_gag", {} as any), "अभी मार्केट में क्या चल रहा है।");
assert.ok(insightRuleFor("prompt_gag", {} as any).includes("Hinglish"));
assert.ok(!insightRuleFor("codeorcap", {} as any).includes("Hinglish"));
assert.strictEqual(insightIntro("prompt_gag", { INSIGHT_CLIP_LANG: "hi" } as any), "अभी मार्केट में क्या चल रहा है।");
assert.ok(insightFor("prompt_gag").promptRule.includes("no buy/sell advice"));

// the lines the clip speaks carry the channel's intro, and the body beats are untouched
const lines = howItWorksLines("The market fell sharply today. Here is why it matters.", insightIntro("prompt_gag", { INSIGHT_CLIP_LANG: "en" } as any));
assert.strictEqual(lines[0], "Here is what is happening in the market.");
assert.strictEqual(lines.length, 3);

// Hindi explanations are split into beats at the danda, like English ones at the full stop
const hi = howItWorksLines("बाज़ार आज तेज़ी से गिरा। इसका असर आपकी बचत पर पड़ सकता है।", insightIntro("prompt_gag", { INSIGHT_CLIP_LANG: "hi" } as any));
assert.strictEqual(hi.length, 3);
assert.strictEqual(hi[1], "बाज़ार आज तेज़ी से गिरा।");

// figures must come from the reel; English is detected
const src = "RBI to raise interest rates to 5.50% in October as inflation broadens. India inflation rises to 4.82% in August.";
const kept = dropUnsupportedFigures("RBI may raise the rate to 5.50% soon. The rate could go from 6.5% to 7.0% next year. Inflation is 4.82% now.", src);
assert.strictEqual(kept.dropped, 1);
assert.ok(kept.text.includes("5.50%") && kept.text.includes("4.82%") && !kept.text.includes("7.0"));
assert.strictEqual(dropUnsupportedFigures("ब्याज दर 5.50% तक जा सकती है।", src).dropped, 0);
assert.strictEqual(dropUnsupportedFigures("Rates may rise 7.25% soon.", "no numbers here").text, "");
assert.strictEqual(looksEnglish("The RBI is expected to raise the interest rate and this will affect home loans in the country"), true);
assert.strictEqual(looksEnglish("RBI ka rate badh sakta hai aur isse aapki EMI bhi badh jayegi, ye hai sabse badi baat"), false);
assert.strictEqual(looksEnglish("आरबीआई ब्याज दर बढ़ा सकता है और ईएमआई बढ़ेगी"), false);
console.log("✓ insight clip");
