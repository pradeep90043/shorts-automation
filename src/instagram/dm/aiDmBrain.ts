import { DmMessage, OutboundLead, DmReplyResult } from "./types";
import { dmKnowledgeBase } from "./knowledgeBase";
import { getPersona } from "./persona";
import { GeminiClient } from "../../ai/gemini";
import { FreeLlmApiClient } from "../../ai/freellmapi";
import { pipelineLogger } from "../../utils/logger";
import { config } from "../../config";

export class AiDmBrain {
  private geminiClient: GeminiClient;
  private freeLlmClient: FreeLlmApiClient;

  constructor() {
    this.geminiClient = new GeminiClient();
    this.freeLlmClient = new FreeLlmApiClient();
  }

  private async callAi(prompt: string): Promise<string> {
    // 1. Try Gemini first if key available
    if (this.geminiClient.enabled) {
      try {
        const reply = await this.geminiClient.generateText(prompt);
        if (reply && reply.trim()) return reply.trim();
      } catch (err: any) {
        pipelineLogger.warn(`[AiDmBrain] Gemini attempt failed: ${err.message}`, "AiDmBrain");
      }
    }

    // 2. Try FreeLLMAPI
    if (config.ai.freellmapiKey) {
      try {
        const reply = await this.freeLlmClient.generateText(prompt);
        if (reply && reply.trim()) return reply.trim();
      } catch (err: any) {
        pipelineLogger.warn(`[AiDmBrain] FreeLLMAPI attempt failed: ${err.message}`, "AiDmBrain");
      }
    }

    // 3. Simple fallback response if no AI keys respond
    return "Hey! Thanks for reaching out. Appreciate you tuning into the reels! What are you currently working on?";
  }

  /**
   * Generates a conversational reply to an inbound DM talking on behalf of the creator
   */
  public async generateInboundReply(
    incomingText: string,
    history: DmMessage[],
    profileKey: string = "codeorcap"
  ): Promise<DmReplyResult> {
    const persona = getPersona(profileKey);
    const relevantTopics = dmKnowledgeBase.search(incomingText, profileKey, 3);

    // Format chat history for context
    const recentHistory = history
      .slice(-6)
      .map((m) => `${m.isFromMe ? "Me (" + persona.creatorName + ")" : "Follower"}: ${m.text}`)
      .join("\n");

    const knowledgeContext = relevantTopics
      .map(
        (t, idx) =>
          `[Video ${idx + 1}]: "${t.title}"\nKey Context: ${t.description.slice(0, 250)}`
      )
      .join("\n\n");

    const prompt = `You are ${persona.creatorName}, the creator behind ${persona.brandName} (${persona.handle}).
You are responding directly to an Instagram Direct Message from one of your followers.
Talk directly in the first person ("I", "my channel", "in my recent video").

=== YOUR PERSONA & VOICE ===
Bio: ${persona.bio}
Tone: ${persona.voiceTone}
Offerings & Resources:
${persona.keyOfferings.map((o) => `• ${o}`).join("\n")}
${persona.resourceLinks.map((l) => `• ${l.label}: ${l.url}`).join("\n")}

=== RULES ===
${persona.communicationRules.map((r) => `• ${r}`).join("\n")}
- Keep the response short (1 to 3 sentences maximum), engaging, casual, and helpful like a real creator on Instagram.
- Do NOT use formal corporate greetings ("Dear follower", "I am an AI").
- If they ask about something covered in your videos, seamlessly weave it in.
- Do NOT spam links unless they explicitly asked for resources or code.
- Always be encouraging and keep the door open for conversation.

=== RECENT CHAT HISTORY ===
${recentHistory || "(No previous messages)"}

=== KNOWLEDGE FROM YOUR SHORTS / REELS ===
${knowledgeContext || "(No specific video match, use general creator knowledge)"}

=== LATEST INCOMING MESSAGE ===
Follower: "${incomingText}"

Write your direct message reply (only output the reply text, no extra quotes or labels):`;

    const reply = await this.callAi(prompt);
    const cleanedReply = reply.replace(/^["']|["']$/g, "").trim();

    return {
      replyText: cleanedReply,
      referencedTopics: relevantTopics.map((t) => t.title),
      confidence: relevantTopics.length > 0 ? 0.9 : 0.75,
      shouldEscalateToHuman: /collaborat|hire|sponsor|business inquiry|price|call/i.test(incomingText),
    };
  }

  /**
   * Generates a personalized outbound icebreaker/opener for outreach leads
   */
  public async generateOutboundOpener(
    lead: OutboundLead,
    profileKey: string = "codeorcap"
  ): Promise<string> {
    const persona = getPersona(profileKey);

    let contextHint = "";
    if (lead.sourceReelTitle) {
      contextHint += `They recently engaged with your video titled "${lead.sourceReelTitle}". `;
    }
    if (lead.triggerComment) {
      contextHint += `Their comment was: "${lead.triggerComment}". `;
    }
    if (lead.interestNiche) {
      contextHint += `Their area of interest is: ${lead.interestNiche}. `;
    }

    const prompt = `You are ${persona.creatorName}, the creator of ${persona.brandName} (${persona.handle}).
You are sending a friendly, personalized outbound Instagram direct message to @${lead.username}.

=== CONTEXT ABOUT THIS FOLLOWER ===
${contextHint || "They are a tech/coding enthusiast who follows content in your niche."}

=== YOUR GOAL ===
Start a genuine, natural conversation.
- Acknowledge their comment or interest without sounding like a robotic marketer.
- Ask a lightweight, engaging open question related to coding, tech, or the video topic.
- Keep it under 2 short sentences.
- Casual, friendly, peer-to-peer tone.
- NO hard selling, NO unsolicited links.

Write the outbound direct message opener (only output the message, no quotes):`;

    const opener = await this.callAi(prompt);
    return opener.replace(/^["']|["']$/g, "").trim();
  }
}

export const aiDmBrain = new AiDmBrain();
