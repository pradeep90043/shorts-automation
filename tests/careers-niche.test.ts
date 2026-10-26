import assert from "assert";
import { CONTENT_THEMES } from "../src/config/themes";
import { resolveTheme } from "../src/config";
import { buildHashtagsForNiche } from "../src/instagram/nicheSearcher";

// CodeOrCap's niche since 2026-10-26: money and careers for Indian techies, no memes
const t = CONTENT_THEMES.careers;
assert.ok(t, "careers theme exists");
assert.strictEqual(resolveTheme("careers", "CodeOrCap").niche, "careers");
assert.strictEqual(t.requiredHashtag, "career");
assert.ok(/meme/i.test(t.analysisRules), "the analysis rules call memes off-niche");

const tags = buildHashtagsForNiche(t);
assert.ok(tags.includes("salary") && tags.includes("businessideas"), "career and business hashtags");
assert.ok(!tags.some((x) => /meme|humor|joke/i.test(x)), "no meme hashtags");
// the funny mood falls back to the default list: careers has no meme list
assert.deepStrictEqual(buildHashtagsForNiche(t, "funny"), tags);

console.log("✓ careers niche");
