import assert from "assert";
import { salvageScenes } from "../src/my-video/stickmanPlanner";

const raw = '{"title":"x","scenes":[{"i":0,"callouts":["A \\"q\\" }"]},{"i":1,"pose":"idle"},{"i":2,"po';
const r = salvageScenes(raw);
assert.strictEqual(r.length, 2, "keeps the two complete scenes, drops the truncated third");
assert.strictEqual(r[0].callouts[0], 'A "q" }');
assert.strictEqual(r[1].pose, "idle");
assert.deepStrictEqual(salvageScenes("no json here"), []);
console.log("✓ salvageScenes");
