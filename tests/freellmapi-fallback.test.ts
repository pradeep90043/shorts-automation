import { FreeLlmApiClient } from '../src/ai/freellmapi';
import { config } from '../src/config';

async function testFallback() {
  console.log("Testing FreeLLMAPI fallback mechanism...");

  // Intentionally set an unreachable primary URL to simulate prod failure
  config.ai.freellmapiUrl = "http://127.0.0.1:59999"; // dead port
  config.ai.freellmapiKey = "invalid-primary-key";

  // Configure dev instance as fallback
  config.ai.freellmapiFallbackUrl = "http://92.4.82.192:20128";
  config.ai.freellmapiFallbackKey = "freellmapi-98c9da4ce2b9a5149e83d5345b05bacabc2a4aab75a569bc";
  config.ai.freellmapiFallbackModel = "auto";

  const client = new FreeLlmApiClient();
  const prompt = "Reply with exactly: FALLBACK_SUCCESS";

  const reply = await client.generateText(prompt);
  console.log("Response received:", reply);

  if (reply && reply.length > 0) {
    console.log("✅ Fallback successfully activated and returned response!");
  } else {
    throw new Error("❌ Response was empty");
  }
}

testFallback().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
