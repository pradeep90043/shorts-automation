// tests/niche-pick.test.ts — reels are picked by niche (hashtag), never by engagement.
import { interleaveByTag } from "../src/instagram/nicheSearcher";

const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    console.error(`✗ ${msg}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
};

eq(interleaveByTag([["a1", "a2", "a3"], ["b1"], ["c1", "c2"]]), ["a1", "b1", "c1", "a2", "c2", "a3"], "round-robin across hashtags");
eq(interleaveByTag([[], ["b1", "b2"]]), ["b1", "b2"], "empty tag lists are skipped");
eq(interleaveByTag([]), [], "no lists gives no reels");
