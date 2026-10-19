import http from "http";
import assert from "assert";
import { FreeLlmApiClient } from "../src/ai/freellmapi";
import { config } from "../src/config";

// Fail-over without any network or real key: the primary is a dead port, the fallback is a local fake OpenAI-style server.
async function testFallback() {
  const seen: Array<{ auth?: string; model?: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = body ? JSON.parse(body) : {};
      seen.push({ auth: req.headers.authorization, model: j.model });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "FALLBACK_SUCCESS" } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  config.ai.freellmapiUrl = "http://127.0.0.1:59999"; // dead port: the primary is down
  config.ai.freellmapiKey = "primary-key";
  config.ai.freellmapiFallbackUrl = `http://127.0.0.1:${port}`;
  config.ai.freellmapiFallbackKey = "fallback-key";
  config.ai.freellmapiFallbackModel = "auto";

  const reply = await new FreeLlmApiClient().generateText("Reply with exactly: FALLBACK_SUCCESS");
  assert.strictEqual(reply, "FALLBACK_SUCCESS");
  assert.strictEqual(seen.length, 1, "the fallback was asked once");
  assert.strictEqual(seen[0].auth, "Bearer fallback-key", "with the fallback's own key");

  // with no fallback configured the primary's error is what the caller sees
  config.ai.freellmapiFallbackUrl = "";
  await assert.rejects(new FreeLlmApiClient().generateText("x"), /fetch failed|ECONNREFUSED/);

  server.close();
  console.log("✅ Fallback successfully activated and returned response!");
  process.exit(0);
}

testFallback().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
