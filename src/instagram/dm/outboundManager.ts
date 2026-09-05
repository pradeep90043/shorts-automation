import { dmStore } from "./dmStore";
import { aiDmBrain } from "./aiDmBrain";
import { instagramDmService } from "./instagramDmService";
import { OutboundLead, DmMessage } from "./types";
import { pipelineLogger } from "../../utils/logger";

export class OutboundDmManager {
  private isProcessing = false;

  /**
   * Queue a lead for outbound outreach
   */
  public addLead(params: {
    username: string;
    instagramId?: string;
    profileKey?: string;
    sourceReelUrl?: string;
    sourceReelTitle?: string;
    triggerComment?: string;
    interestNiche?: string;
  }): OutboundLead {
    const id = `lead-${Date.now()}-${params.username.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    const lead: OutboundLead = {
      id,
      username: params.username.replace("@", ""),
      instagramId: params.instagramId,
      profileKey: params.profileKey || "codeorcap",
      sourceReelUrl: params.sourceReelUrl,
      sourceReelTitle: params.sourceReelTitle,
      triggerComment: params.triggerComment,
      interestNiche: params.interestNiche,
      status: "pending",
      createdAt: Date.now(),
    };

    dmStore.upsertLead(lead);
    pipelineLogger.info(
      `[OutboundDmManager] Added new lead @${lead.username} for ${lead.profileKey}`,
      "OutboundDmManager"
    );
    return lead;
  }

  /**
   * Generates a preview of the outbound opener for a lead without sending
   */
  public async previewOpener(leadId: string): Promise<string | null> {
    const lead = dmStore.getLead(leadId);
    if (!lead) return null;
    return await aiDmBrain.generateOutboundOpener(lead, lead.profileKey);
  }

  /**
   * Sends an outbound opener to a single lead
   */
  public async sendToLead(leadId: string): Promise<{ success: boolean; error?: string; openerText?: string }> {
    const lead = dmStore.getLead(leadId);
    if (!lead) return { success: false, error: "Lead not found" };

    if (!lead.instagramId) {
      return {
        success: false,
        error: "Instagram Scoped User ID (IGSID) is required by Meta Graph API to initiate DMs. If only username is available, lead must first interact or be messaged directly.",
      };
    }

    try {
      const opener = await aiDmBrain.generateOutboundOpener(lead, lead.profileKey);
      const sendRes = await instagramDmService.sendDirectMessage(
        lead.instagramId,
        opener,
        lead.profileKey
      );

      if (sendRes.success) {
        dmStore.updateLeadStatus(leadId, "opener_sent", {
          openerText: opener,
          lastContactedAt: Date.now(),
        });

        // Add to conversation store
        const msg: DmMessage = {
          id: sendRes.messageId || `outbound-${Date.now()}`,
          senderId: lead.profileKey,
          recipientId: lead.instagramId,
          text: opener,
          timestamp: Date.now(),
          isFromMe: true,
        };
        dmStore.addMessage(lead.instagramId, lead.instagramId, msg, lead.profileKey);

        pipelineLogger.info(
          `[OutboundDmManager] Sent opener to @${lead.username}: "${opener}"`,
          "OutboundDmManager"
        );
        return { success: true, openerText: opener };
      } else {
        dmStore.updateLeadStatus(leadId, "failed", { notes: sendRes.error });
        return { success: false, error: sendRes.error };
      }
    } catch (err: any) {
      dmStore.updateLeadStatus(leadId, "failed", { notes: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * Batch process pending leads with pacing / delays
   */
  public async processBatch(
    profileKey: string = "codeorcap",
    maxCount: number = 5,
    delayBetweenMs: number = 10000
  ): Promise<{ sent: number; failed: number; skipped: number }> {
    if (this.isProcessing) {
      pipelineLogger.warn("[OutboundDmManager] Batch already running.", "OutboundDmManager");
      return { sent: 0, failed: 0, skipped: 0 };
    }

    this.isProcessing = true;
    const pending = dmStore.getPendingLeads(profileKey).slice(0, maxCount);
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    pipelineLogger.info(
      `[OutboundDmManager] Starting outbound batch of ${pending.length} leads for ${profileKey}`,
      "OutboundDmManager"
    );

    for (const lead of pending) {
      if (!lead.instagramId) {
        skipped++;
        continue;
      }

      const res = await this.sendToLead(lead.id);
      if (res.success) {
        sent++;
      } else {
        failed++;
      }

      // Wait between sends to avoid rate triggers
      await new Promise((resolve) => setTimeout(resolve, delayBetweenMs));
    }

    this.isProcessing = false;
    return { sent, failed, skipped };
  }
}

export const outboundDmManager = new OutboundDmManager();
