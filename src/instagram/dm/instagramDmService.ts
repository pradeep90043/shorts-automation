import { config, InstagramAccount } from "../../config";
import { pipelineLogger } from "../../utils/logger";
import { DmMessage } from "./types";

export class InstagramDmService {
  private apiVersion = "v21.0";
  private hourlySentCount = 0;
  private lastHourReset = Date.now();
  private MAX_PER_HOUR = 25; // safety limit to protect the Instagram account

  /**
   * Helper to resolve the Instagram account credentials and associated Facebook Page ID
   */
  public getAccount(profileKey: string = "codeorcap"): (InstagramAccount & { pageId?: string }) | null {
    const norm = profileKey.toLowerCase();
    const profile = config.profiles.find((p) => p.key.toLowerCase() === norm);
    if (profile && profile.instagram?.accounts?.[0]) {
      return {
        ...profile.instagram.accounts[0],
        pageId: profile.facebook?.pageId,
      };
    }
    if (config.instagram.accounts?.[0]) {
      return {
        ...config.instagram.accounts[0],
        pageId: config.profiles[0]?.facebook?.pageId,
      };
    }
    return null;
  }

  /**
   * Fetch active conversation threads via Instagram Graph API
   */
  public async fetchConversations(profileKey: string = "codeorcap"): Promise<any[]> {
    const account = this.getAccount(profileKey);
    if (!account || !account.accessToken || !account.igUserId) {
      pipelineLogger.warn(
        `[InstagramDmService] Missing Instagram credentials for ${profileKey}`,
        "InstagramDmService"
      );
      return [];
    }

    try {
      const targetId = account.pageId || account.igUserId;
      const url = `https://graph.facebook.com/${this.apiVersion}/${targetId}/conversations?platform=instagram&access_token=${account.accessToken}`;
      const res = await fetch(url);
      const data = (await res.json()) as any;

      if (!res.ok || data.error) {
        pipelineLogger.warn(
          `[InstagramDmService] Failed to fetch conversations: ${JSON.stringify(data.error || data)}`,
          "InstagramDmService"
        );
        return [];
      }

      return data.data || [];
    } catch (err: any) {
      pipelineLogger.error(
        `[InstagramDmService] Network error fetching conversations: ${err.message}`,
        err,
        "InstagramDmService"
      );
      return [];
    }
  }

  /**
   * Fetch messages in a thread
   */
  public async fetchMessagesInThread(
    threadId: string,
    profileKey: string = "codeorcap"
  ): Promise<DmMessage[]> {
    const account = this.getAccount(profileKey);
    if (!account || !account.accessToken) return [];

    try {
      const url = `https://graph.facebook.com/${this.apiVersion}/${threadId}?fields=messages{id,created_time,from,to,message}&access_token=${account.accessToken}`;
      const res = await fetch(url);
      const data = (await res.json()) as any;

      if (!res.ok || !data.messages?.data) {
        return [];
      }

      const list: DmMessage[] = [];
      for (const m of data.messages.data) {
        const isFromMe = m.from?.id === account.igUserId;
        list.push({
          id: m.id,
          senderId: m.from?.id || "unknown",
          senderUsername: m.from?.username,
          recipientId: m.to?.data?.[0]?.id || "",
          text: m.message || "",
          timestamp: m.created_time ? new Date(m.created_time).getTime() : Date.now(),
          isFromMe,
        });
      }

      return list.sort((a, b) => a.timestamp - b.timestamp);
    } catch (err: any) {
      pipelineLogger.error(
        `[InstagramDmService] Error fetching thread messages: ${err.message}`,
        err,
        "InstagramDmService"
      );
      return [];
    }
  }

  /**
   * Send a direct message to a user
   */
  public async sendDirectMessage(
    recipientId: string,
    text: string,
    profileKey: string = "codeorcap"
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const account = this.getAccount(profileKey);
    if (!account || !account.accessToken || !account.igUserId) {
      return { success: false, error: "Missing Instagram credentials" };
    }

    // Safety Rate Limiter
    const now = Date.now();
    if (now - this.lastHourReset > 3600 * 1000) {
      this.hourlySentCount = 0;
      this.lastHourReset = now;
    }

    if (this.hourlySentCount >= this.MAX_PER_HOUR) {
      pipelineLogger.warn(
        `[InstagramDmService] Hourly DM rate limit (${this.MAX_PER_HOUR}) reached. Throttling.`,
        "InstagramDmService"
      );
      return { success: false, error: "Hourly limit reached" };
    }

    try {
      const targetId = account.pageId || account.igUserId;
      const url = `https://graph.facebook.com/${this.apiVersion}/${targetId}/messages?access_token=${account.accessToken}`;
      const payload = {
        recipient: {
          id: recipientId,
        },
        message: {
          text,
        },
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = (await res.json()) as any;

      if (!res.ok || json.error) {
        const msg = json.error?.message || JSON.stringify(json);
        pipelineLogger.error(
          `[InstagramDmService] Send DM failed: ${msg}`,
          new Error(msg),
          "InstagramDmService"
        );
        return { success: false, error: msg };
      }

      this.hourlySentCount++;
      pipelineLogger.info(
        `[InstagramDmService] DM successfully sent to ${recipientId}: "${text.slice(0, 40)}..."`,
        "InstagramDmService"
      );

      return { success: true, messageId: json.message_id };
    } catch (err: any) {
      pipelineLogger.error(
        `[InstagramDmService] Send DM network error: ${err.message}`,
        err,
        "InstagramDmService"
      );
      return { success: false, error: err.message };
    }
  }
}

export const instagramDmService = new InstagramDmService();
