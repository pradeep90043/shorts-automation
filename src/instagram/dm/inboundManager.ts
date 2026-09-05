import { dmStore } from "./dmStore";
import { aiDmBrain } from "./aiDmBrain";
import { instagramDmService } from "./instagramDmService";
import { pipelineLogger } from "../../utils/logger";
import { DmMessage } from "./types";

export class InboundDmManager {
  private isRunning = false;
  private pollIntervalMs = 60000; // poll every 60s
  private timer: NodeJS.Timeout | null = null;

  /**
   * Process a single incoming DM event (e.g. from webhook or polling)
   */
  public async handleIncomingMessage(
    senderId: string,
    messageId: string,
    text: string,
    profileKey: string = "codeorcap",
    senderUsername?: string
  ): Promise<boolean> {
    if (dmStore.isMessageProcessed(messageId)) {
      return false;
    }

    pipelineLogger.info(
      `[InboundDmManager] Processing incoming DM from ${senderUsername || senderId}: "${text}"`,
      "InboundDmManager"
    );

    const message: DmMessage = {
      id: messageId,
      senderId,
      senderUsername,
      recipientId: profileKey,
      text,
      timestamp: Date.now(),
      isFromMe: false,
    };

    // Get previous conversation history if available
    const existingConv = dmStore.getConversation(senderId);
    const history = existingConv ? existingConv.messages : [];

    // Save message first
    dmStore.addMessage(senderId, senderId, message, profileKey);

    // Generate AI response talking on behalf of creator
    const result = await aiDmBrain.generateInboundReply(text, history, profileKey);

    pipelineLogger.info(
      `[InboundDmManager] Generated reply: "${result.replyText}" (Confidence: ${result.confidence})`,
      "InboundDmManager"
    );

    // Send reply via Instagram Graph API
    const sendResult = await instagramDmService.sendDirectMessage(
      senderId,
      result.replyText,
      profileKey
    );

    if (sendResult.success) {
      const myReplyMessage: DmMessage = {
        id: sendResult.messageId || `reply-${Date.now()}`,
        senderId: profileKey,
        recipientId: senderId,
        text: result.replyText,
        timestamp: Date.now(),
        isFromMe: true,
      };
      dmStore.addMessage(senderId, senderId, myReplyMessage, profileKey);
      return true;
    } else {
      pipelineLogger.error(
        `[InboundDmManager] Failed to deliver reply to ${senderId}: ${sendResult.error}`,
        new Error(sendResult.error || "Send failed"),
        "InboundDmManager"
      );
      return false;
    }
  }

  /**
   * Polls active conversations on Instagram to detect and reply to new inbound DMs
   */
  public async pollOnce(profileKey: string = "codeorcap"): Promise<number> {
    pipelineLogger.info(
      `[InboundDmManager] Polling Instagram conversations for ${profileKey}...`,
      "InboundDmManager"
    );

    const conversations = await instagramDmService.fetchConversations(profileKey);
    let handledCount = 0;

    for (const conv of conversations) {
      if (!conv.id) continue;
      const messages = await instagramDmService.fetchMessagesInThread(conv.id, profileKey);
      if (messages.length === 0) continue;

      const latest = messages[messages.length - 1];
      // If the latest message is from the follower and has not been processed yet
      if (!latest.isFromMe && !dmStore.isMessageProcessed(latest.id)) {
        const handled = await this.handleIncomingMessage(
          latest.senderId,
          latest.id,
          latest.text,
          profileKey,
          latest.senderUsername
        );
        if (handled) handledCount++;
      }
    }

    return handledCount;
  }

  /**
   * Starts background polling loop
   */
  public startDaemon(profileKey: string = "codeorcap", intervalMs: number = 60000): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.pollIntervalMs = intervalMs;

    pipelineLogger.info(
      `[InboundDmManager] Starting Inbound DM daemon (interval: ${intervalMs / 1000}s)`,
      "InboundDmManager"
    );

    const run = async () => {
      try {
        await this.pollOnce(profileKey);
      } catch (err: any) {
        pipelineLogger.error(`[InboundDmManager] Poll error: ${err.message}`, err, "InboundDmManager");
      }
      if (this.isRunning) {
        this.timer = setTimeout(run, this.pollIntervalMs);
      }
    };

    run();
  }

  public stopDaemon(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export const inboundDmManager = new InboundDmManager();
