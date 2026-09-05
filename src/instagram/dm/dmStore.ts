import fs from "fs";
import path from "path";
import { DmConversation, DmMessage, OutboundLead } from "./types";
import { config } from "../../config";
import { pipelineLogger } from "../../utils/logger";

export class DmStore {
  private conversationsPath: string;
  private leadsPath: string;
  private conversations: Map<string, DmConversation> = new Map();
  private leads: Map<string, OutboundLead> = new Map();
  private processedMessageIds: Set<string> = new Set();

  constructor() {
    const logsDir = config.paths.logDir || path.resolve(__dirname, "../../../logs");
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    this.conversationsPath = path.join(logsDir, "dm_conversations.json");
    this.leadsPath = path.join(logsDir, "dm_leads.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.conversationsPath)) {
        const raw = fs.readFileSync(this.conversationsPath, "utf8");
        const parsed = JSON.parse(raw);
        for (const [id, conv] of Object.entries(parsed)) {
          const c = conv as DmConversation;
          this.conversations.set(id, c);
          if (Array.isArray(c.messages)) {
            for (const m of c.messages) {
              if (m.id) this.processedMessageIds.add(m.id);
            }
          }
        }
      }

      if (fs.existsSync(this.leadsPath)) {
        const raw = fs.readFileSync(this.leadsPath, "utf8");
        const parsed = JSON.parse(raw);
        for (const [id, lead] of Object.entries(parsed)) {
          this.leads.set(id, lead as OutboundLead);
        }
      }
    } catch (err: any) {
      pipelineLogger.error(`[DmStore] Error loading store: ${err.message}`, err, "DmStore");
    }
  }

  private save(): void {
    try {
      const convObj: Record<string, DmConversation> = {};
      for (const [id, conv] of this.conversations.entries()) {
        convObj[id] = conv;
      }
      fs.writeFileSync(this.conversationsPath, JSON.stringify(convObj, null, 2), "utf8");

      const leadObj: Record<string, OutboundLead> = {};
      for (const [id, lead] of this.leads.entries()) {
        leadObj[id] = lead;
      }
      fs.writeFileSync(this.leadsPath, JSON.stringify(leadObj, null, 2), "utf8");
    } catch (err: any) {
      pipelineLogger.error(`[DmStore] Error saving store: ${err.message}`, err, "DmStore");
    }
  }

  public isMessageProcessed(messageId: string): boolean {
    return this.processedMessageIds.has(messageId);
  }

  public markMessageProcessed(messageId: string): void {
    this.processedMessageIds.add(messageId);
  }

  public getConversation(id: string): DmConversation | undefined {
    return this.conversations.get(id);
  }

  public getAllConversations(): DmConversation[] {
    return Array.from(this.conversations.values()).sort(
      (a, b) => b.lastMessageAt - a.lastMessageAt
    );
  }

  public saveConversation(conv: DmConversation): void {
    this.conversations.set(conv.id, conv);
    if (conv.messages) {
      for (const m of conv.messages) {
        if (m.id) this.processedMessageIds.add(m.id);
      }
    }
    this.save();
  }

  public addMessage(
    conversationId: string,
    participantId: string,
    message: DmMessage,
    profileKey: string = "codeorcap"
  ): DmConversation {
    let conv = this.conversations.get(conversationId);
    if (!conv) {
      conv = {
        id: conversationId,
        participantId,
        participantUsername: message.senderUsername,
        profileKey,
        lastMessageAt: message.timestamp,
        messages: [],
        unreadCount: message.isFromMe ? 0 : 1,
        status: "active",
      };
    }

    this.processedMessageIds.add(message.id);
    conv.messages.push(message);
    conv.lastMessageAt = Math.max(conv.lastMessageAt, message.timestamp);
    if (!message.isFromMe) {
      conv.unreadCount += 1;
    }

    this.conversations.set(conversationId, conv);
    this.save();
    return conv;
  }

  // Leads Management
  public getLead(id: string): OutboundLead | undefined {
    return this.leads.get(id);
  }

  public getAllLeads(): OutboundLead[] {
    return Array.from(this.leads.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  public getPendingLeads(profileKey?: string): OutboundLead[] {
    return this.getAllLeads().filter((l) => {
      const matchProfile = profileKey ? l.profileKey === profileKey : true;
      return matchProfile && l.status === "pending";
    });
  }

  public upsertLead(lead: OutboundLead): void {
    this.leads.set(lead.id, lead);
    this.save();
  }

  public updateLeadStatus(
    id: string,
    status: OutboundLead["status"],
    extra?: Partial<OutboundLead>
  ): void {
    const lead = this.leads.get(id);
    if (lead) {
      lead.status = status;
      if (extra) Object.assign(lead, extra);
      this.leads.set(id, lead);
      this.save();
    }
  }
}

export const dmStore = new DmStore();
