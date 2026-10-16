import assert from "assert";
import { buildCaption } from "../src/instagram/publisher";
const c = buildCaption({ title: "T", description: "word ".repeat(1000), tags: Array.from({length:40},(_,i)=>"tag"+i) } as any);
assert.ok(c.length <= 2200); assert.ok(c.includes("#tag29") && !c.includes("#tag30")); assert.ok(c.includes("…"));
assert.strictEqual(buildCaption({ title: "T", description: "D", tags: ["ab","c d"] } as any), "T\n\nD\n\n#ab #cd");
console.log("✓ instagram caption");
