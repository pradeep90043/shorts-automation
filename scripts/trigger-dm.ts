import dotenv from "dotenv";
dotenv.config();

import { aiDmBrain } from "../src/instagram/dm/aiDmBrain";
import { getPersona } from "../src/instagram/dm/persona";
import { DmMessage } from "../src/instagram/dm/types";

async function main() {
  const userMessage = process.argv.slice(2).join(" ") || "Hey bro! Loved your latest reel on developer imposter syndrome! 🔥";
  const persona = getPersona("prompt_gag");

  console.log("\n=======================================================");
  console.log(`📨 Triggering message from your side (@codeorcap -> ${persona.handle})`);
  console.log("=======================================================");
  console.log(`\x1b[36mYou (@codeorcap):\x1b[0m "${userMessage}"\n`);
  console.log(`\x1b[90m[Processing through ${persona.brandName} AI Brain with your shorts knowledge...]\x1b[0m\n`);

  const history: DmMessage[] = [];
  const result = await aiDmBrain.generateInboundReply(userMessage, history, "prompt_gag");

  console.log(`\x1b[32m${persona.creatorName} (${persona.handle}):\x1b[0m`);
  console.log(`"${result.replyText}"\n`);

  if (result.referencedTopics.length > 0) {
    console.log(`\x1b[90m📚 Referenced Knowledge: ${result.referencedTopics.join(", ")}\x1b[0m`);
  }
}

main().catch(console.error);
