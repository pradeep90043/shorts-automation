import fs from "fs";
import path from "path";
import { KnowledgeTopic } from "./types";
import { config } from "../../config";
import { pipelineLogger } from "../../utils/logger";

export class DmKnowledgeBase {
  private topics: KnowledgeTopic[] = [];
  private isLoaded = false;

  constructor() {
    this.loadFromDatabases();
  }

  /**
   * Reads all available jobs_db files from logs/ and extracts high-value knowledge items
   */
  public loadFromDatabases(): void {
    const logsDir = config.paths.logDir || path.resolve(__dirname, "../../../logs");
    const dbFiles = [
      { file: "jobs_db.json", profileKey: "codeorcap", brandName: "CodeOrCap" },
      { file: "jobs_db_storiyum.json", profileKey: "storiyum", brandName: "Storiyum" },
      { file: "jobs_db_prompt_gag.json", profileKey: "prompt_gag", brandName: "PromptGag" },
    ];

    this.topics = [];

    for (const entry of dbFiles) {
      const fullPath = path.join(logsDir, entry.file);
      if (!fs.existsSync(fullPath)) continue;

      try {
        const raw = fs.readFileSync(fullPath, "utf8");
        const json = JSON.parse(raw);
        const jobs = Object.values(json) as any[];

        for (const job of jobs) {
          if (!job || job.status !== "completed") continue;
          const meta = job.context?.captionMetadata || job.metadata;
          if (!meta || !meta.title) continue;

          const title = (meta.title || "").trim();
          const description = (meta.description || "").trim();
          const tags: string[] = Array.isArray(meta.tags)
            ? meta.tags
            : (description.match(/#[a-zA-Z0-9_]+/g) || []).map((t: string) => t.replace("#", ""));

          const sourceUrl = job.context?.telegramMeta?.fileId?.startsWith("http")
            ? job.context.telegramMeta.fileId
            : undefined;

          const topic: KnowledgeTopic = {
            id: job.id || `topic-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            profileKey: entry.profileKey,
            brandName: entry.brandName,
            title,
            description,
            tags,
            sourceUrl,
            mediaType: job.mediaType || "video",
            summaryText: `${title}: ${description}`.slice(0, 400),
            createdAt: job.createdAt ? new Date(job.createdAt).getTime() : Date.now(),
          };

          this.topics.push(topic);
        }
      } catch (err: any) {
        pipelineLogger.warn(
          `[DmKnowledgeBase] Failed to load from ${entry.file}: ${err.message}`,
          "DmKnowledgeBase"
        );
      }
    }

    this.isLoaded = true;
    pipelineLogger.info(
      `[DmKnowledgeBase] Loaded ${this.topics.length} knowledge topics across profiles.`,
      "DmKnowledgeBase"
    );
  }

  public getAllTopics(profileKey?: string): KnowledgeTopic[] {
    if (!this.isLoaded) this.loadFromDatabases();
    if (profileKey) {
      return this.topics.filter((t) => t.profileKey.toLowerCase() === profileKey.toLowerCase());
    }
    return this.topics;
  }

  /**
   * Search for relevant knowledge topics given an incoming DM query
   */
  public search(query: string, profileKey?: string, limit: number = 3): KnowledgeTopic[] {
    if (!this.isLoaded) this.loadFromDatabases();
    if (!query || query.trim().length === 0) {
      return this.getAllTopics(profileKey).slice(0, limit);
    }

    const cleanedQuery = query.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    const searchTerms = cleanedQuery.split(/\s+/).filter((w) => w.length > 2);

    const candidates = profileKey
      ? this.topics.filter((t) => t.profileKey.toLowerCase() === profileKey.toLowerCase())
      : this.topics;

    const scored = candidates.map((topic) => {
      let score = 0;
      const fullText = `${topic.title} ${topic.description} ${topic.tags.join(" ")}`.toLowerCase();

      for (const term of searchTerms) {
        if (topic.title.toLowerCase().includes(term)) score += 5;
        if (topic.tags.some((tag) => tag.toLowerCase().includes(term))) score += 4;
        if (fullText.includes(term)) score += 2;
      }

      return { topic, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.topic);
  }

  /**
   * Returns a concise summary of the creator's top niches and themes
   */
  public getKnowledgeSummary(profileKey?: string): string {
    const list = this.getAllTopics(profileKey);
    if (list.length === 0) return "No published shorts data found.";

    const sampleTitles = list.slice(0, 8).map((t) => `• "${t.title}"`);
    return `Total shorts/reels documented: ${list.length}\nRecent & top topics:\n${sampleTitles.join("\n")}`;
  }
}

export const dmKnowledgeBase = new DmKnowledgeBase();
