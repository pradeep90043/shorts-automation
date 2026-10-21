import assert from "assert";
import { salvageScenes } from "../src/my-video/stickmanPlanner";

// a stray extra "}" after a scene ("...}}}]}") used to hide every later scene (the director then "gave 1/8 usable scenes")
const raw = '{"scenes":[{"i":1,"steps":{"items":["a"],"current":1}}},{"i":2,"callouts":["x"]},{"i":3,"callouts":["y"]}]}';
assert.deepStrictEqual(salvageScenes(raw).map((x: any) => x?.i), [1, 2, 3]);
console.log("✓ salvageScenes tolerates a stray closing brace");
