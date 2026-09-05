export interface DmMessage {
  id: string;
  senderId: string;
  senderUsername?: string;
  recipientId: string;
  text: string;
  timestamp: number;
  isFromMe: boolean;
}

export interface DmConversation {
  id: string; // conversation thread ID
  participantId: string; // the other user's Instagram scoped ID
  participantUsername?: string;
  profileKey: string; // e.g. "codeorcap", "storiyum"
  lastMessageAt: number;
  messages: DmMessage[];
  unreadCount: number;
  status: "active" | "archived" | "requires_human";
}

export interface OutboundLead {
  id: string;
  username: string;
  instagramId?: string;
  profileKey: string;
  sourceReelUrl?: string;
  sourceReelTitle?: string;
  triggerComment?: string;
  interestNiche?: string;
  status: "pending" | "opener_sent" | "replied" | "converted" | "opted_out" | "failed";
  openerText?: string;
  lastContactedAt?: number;
  notes?: string;
  createdAt: number;
}

export interface KnowledgeTopic {
  id: string;
  profileKey: string;
  brandName: string;
  title: string;
  description: string;
  tags: string[];
  sourceUrl?: string;
  mediaType: string;
  summaryText: string;
  createdAt: number;
}

export interface PersonaConfig {
  creatorName: string;
  handle: string;
  brandName: string;
  profileKey: string;
  bio: string;
  voiceTone: string;
  keyOfferings: string[];
  resourceLinks: { label: string; url: string }[];
  communicationRules: string[];
}

export interface DmReplyResult {
  replyText: string;
  referencedTopics: string[];
  confidence: number;
  shouldEscalateToHuman: boolean;
}
