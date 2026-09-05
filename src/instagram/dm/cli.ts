import readline from "readline";
import { aiDmBrain } from "./aiDmBrain";
import { dmKnowledgeBase } from "./knowledgeBase";
import { inboundDmManager } from "./inboundManager";
import { outboundDmManager } from "./outboundManager";
import { getPersona } from "./persona";
import { DmMessage } from "./types";

async function runInteractiveChat(profileKey: string = "codeorcap") {
  const persona = getPersona(profileKey);
  console.log("\n=======================================================");
  console.log(`🤖 AI DM Simulator — Talking on behalf of: ${persona.creatorName} (${persona.brandName} ${persona.handle})`);
  console.log("=======================================================");
  console.log(`Tone: ${persona.voiceTone}`);
  console.log(`Knowledge Base: ${dmKnowledgeBase.getAllTopics(profileKey).length} shorts/reels indexed`);
  console.log("Type any message as an Instagram follower (or 'exit' to quit):\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history: DmMessage[] = [];

  const promptUser = () => {
    rl.question("\x1b[36mFollower DM > \x1b[0m", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        promptUser();
        return;
      }
      if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
        rl.close();
        return;
      }

      console.log("\x1b[90m[Searching shorts knowledge & generating persona response...]\x1b[0m");
      const result = await aiDmBrain.generateInboundReply(trimmed, history, profileKey);

      console.log(`\n\x1b[32m${persona.creatorName} (${persona.handle}):\x1b[0m`);
      console.log(`"${result.replyText}"\n`);

      if (result.referencedTopics.length > 0) {
        console.log(`\x1b[90m📚 Referenced Shorts: ${result.referencedTopics.join(" | ")}\x1b[0m`);
      }
      if (result.shouldEscalateToHuman) {
        console.log(`\x1b[33m⚡ Flagged: Detected business/collaboration inquiry (Notify Creator)\x1b[0m`);
      }
      console.log("-------------------------------------------------------");

      history.push({
        id: `user-${Date.now()}`,
        senderId: "follower_123",
        recipientId: profileKey,
        text: trimmed,
        timestamp: Date.now(),
        isFromMe: false,
      });

      history.push({
        id: `ai-${Date.now()}`,
        senderId: profileKey,
        recipientId: "follower_123",
        text: result.replyText,
        timestamp: Date.now(),
        isFromMe: true,
      });

      promptUser();
    });
  };

  promptUser();
}

async function showKnowledge(profileKey: string = "codeorcap") {
  console.log("\n=======================================================");
  console.log(`📚 Shorts Automation Knowledge Base (${profileKey})`);
  console.log("=======================================================");
  const topics = dmKnowledgeBase.getAllTopics(profileKey);
  console.log(`Total topics indexed: ${topics.length}\n`);

  topics.slice(0, 10).forEach((t, idx) => {
    console.log(`${idx + 1}. [${t.brandName}] ${t.title}`);
    console.log(`   ${t.description.slice(0, 100)}...`);
    if (t.tags.length > 0) console.log(`   Tags: ${t.tags.slice(0, 5).join(", ")}`);
    console.log("");
  });
}

async function runOutboundTest(profileKey: string = "codeorcap") {
  console.log("\n=======================================================");
  console.log(`🚀 Outbound Outreach Preview`);
  console.log("=======================================================");

  const sampleLead = outboundDmManager.addLead({
    username: "alex_codes",
    profileKey,
    sourceReelTitle: "Imposter Syndrome, Coded.",
    triggerComment: "Man this is so relatable, literally facing this right now at my new job",
    interestNiche: "Software Engineering & Developer Mindset",
  });

  console.log(`Generated lead for @${sampleLead.username}`);
  console.log(`Trigger: Commented on "${sampleLead.sourceReelTitle}"`);
  console.log(`Generating AI personalized opener...\n`);

  const opener = await outboundDmManager.previewOpener(sampleLead.id);
  console.log(`\x1b[32mPersonalized Opener:\x1b[0m\n"${opener}"\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "chat";
  const profileKey = args[1] || "codeorcap";

  switch (cmd) {
    case "chat":
      await runInteractiveChat(profileKey);
      break;
    case "knowledge":
      await showKnowledge(profileKey);
      break;
    case "outbound":
      await runOutboundTest(profileKey);
      break;
    case "daemon":
      console.log(`Starting Inbound DM Daemon for profile: ${profileKey}... (Press Ctrl+C to stop)`);
      inboundDmManager.startDaemon(profileKey, 30000);
      break;
    default:
      console.log(`Unknown command: ${cmd}. Available: chat, knowledge, outbound, daemon`);
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("CLI Error:", err);
    process.exit(1);
  });
}
