import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { headlineFor, makeCover, wrapHeadline } from "../src/cover/coverImage";
import { MediaLinkRegistry } from "../src/instagram/mediaLinks";

(async () => {
  // headline: the AI hook wins; titles lose channel suffix, emoji and hashtags
  assert.strictEqual(headlineFor({ title: "Spring Boot Filters 🤯 | CodeOrCap #java", coverHeadline: "" }), "SPRING BOOT FILTERS");
  assert.strictEqual(headlineFor({ title: "x", coverHeadline: "NASA FOUND\nA PLANET" }), "NASA FOUND A PLANET");
  assert.strictEqual(headlineFor({}), "");

  // wrapping: never above maxLines, never a line over maxChars unless one word is longer
  assert.deepStrictEqual(wrapHeadline("FILTERS RUN BEFORE YOUR CONTROLLER", 20, 3), ["FILTERS RUN BEFORE", "YOUR CONTROLLER"]);
  assert.strictEqual(wrapHeadline("A B C D E F G H I J K L", 3, 2).length, 2);

  // switch off and no headline -> no cover, and no network
  process.env.COVER_IMAGES = "off";
  assert.strictEqual(await makeCover({ title: "T", brandKey: "codeorcap", aspect: "landscape" }), null);
  delete process.env.COVER_IMAGES;
  assert.strictEqual(await makeCover({ aspect: "portrait" }), null);

  // a cover gets a .jpg temporary link, a video an .mp4 one
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cover-"));
  fs.writeFileSync(path.join(tmp, "c.jpg"), "x");
  fs.writeFileSync(path.join(tmp, "v.mp4"), "x");
  const reg = new MediaLinkRegistry();
  assert.match(reg.register(path.join(tmp, "c.jpg")).path, /^\/ig-media\/[A-Za-z0-9_-]{43}\.jpg$/);
  assert.match(reg.register(path.join(tmp, "v.mp4")).path, /\.mp4$/);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("✓ cover image");
})();
