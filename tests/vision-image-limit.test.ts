import http from "http";
import assert from "assert";
import { FreeLlmApiClient } from "../src/ai/freellmapi";
import { config } from "../src/config";

// A provider with an image limit answers 400 "supports up to 3 images": the client asks again with 3 evenly spread frames
// (first, middle, last), and a pinned vision model that fails falls back to the normal routing. No network, no real key.
(async () => {
  const counts: number[] = [];
  const models: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body);
      const images = (j.messages[0].content as any[]).filter((p) => p.type === "image_url");
      counts.push(images.length);
      models.push(j.model);
      if (j.model === "pinned-vision") {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream_failed" } }));
      } else if (images.length > 3) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Groq API error 400: Too many images provided. This model supports up to 3 images" } }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: `OK with ${images.length}: ${images.map((i: any) => i.image_url.url.slice(-4)).join(",")}` } }] }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  config.ai.freellmapiUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  config.ai.freellmapiKey = "k";
  config.ai.freellmapiFallbackUrl = "";
  config.ai.freellmapiFallbackKey = "";

  const frames = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF"];
  const reply = await new FreeLlmApiClient().generateVision("describe", frames, "image/jpeg");
  assert.deepStrictEqual(counts, [6, 3], "asked with 6 frames, then again with 3");
  assert.strictEqual(reply, "OK with 3: AAAA,DDDD,FFFF", "first, a middle one and the last frame");

  // the pinned vision model fails -> the normal routing answers
  counts.length = 0; models.length = 0;
  process.env.VISION_MODEL_PIN = "pinned-vision";
  const again = await new FreeLlmApiClient().generateVision("describe", frames.slice(0, 2), "image/jpeg");
  assert.ok(again.startsWith("OK with 2"), again);
  assert.deepStrictEqual(models, ["pinned-vision", config.ai.freellmapiVisionModel]);
  server.close();
  console.log("✓ vision: image limit retry and pinned model fallback");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
