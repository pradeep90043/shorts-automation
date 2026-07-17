import fs from "fs";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "./logger";

export interface UploadMetrics {
  views: number;
  likes: number;
  retentionRate: number; // e.g. 0.85 for 85% average retention
  comments: number;
}

export interface AnalyticsRecord {
  id: string;
  title: string;
  description: string;
  tags: string[];
  youtubeUrl?: string;
  metrics: UploadMetrics;
  createdAt: string;
}

export class ViralAnalyzer {
  private dbPath: string;

  constructor() {
    this.dbPath = path.join(config.paths.logDir, "analytics_db.json");
    this.ensureDbExists();
  }

  private ensureDbExists(): void {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.dbPath)) {
      fs.writeFileSync(this.dbPath, JSON.stringify([], null, 2), "utf8");
    }
  }

  private readDb(): AnalyticsRecord[] {
    try {
      this.ensureDbExists();
      const content = fs.readFileSync(this.dbPath, "utf8");
      return JSON.parse(content) as AnalyticsRecord[];
    } catch (err) {
      pipelineLogger.error(
        "Failed to read analytics database",
        err,
        "ViralAnalyzer",
      );
      return [];
    }
  }

  private writeDb(records: AnalyticsRecord[]): void {
    try {
      this.ensureDbExists();
      // Unique per-write temp filename — if two processes ever raced on this
      // file (as happened when duplicate bot instances were running), a
      // shared ".tmp" name let their writes interleave and corrupt the file.
      // rename() is atomic, so distinct temp files can never do that.
      const tempPath = `${this.dbPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(records, null, 2), "utf8");
      fs.renameSync(tempPath, this.dbPath);
    } catch (err) {
      pipelineLogger.error(
        "Failed to write analytics database",
        err,
        "ViralAnalyzer",
      );
    }
  }

  /**
   * Log a new upload to the analytics database with baseline metrics.
   */
  public logUpload(
    id: string,
    title: string,
    description: string,
    tags: string[],
    youtubeUrl?: string,
  ): void {
    const records = this.readDb();

    // Check if record already exists
    const existingIdx = records.findIndex((r) => r.id === id);

    const record: AnalyticsRecord = {
      id,
      title,
      description,
      tags,
      youtubeUrl,
      metrics: {
        views: 0,
        likes: 0,
        retentionRate: 0.0,
        comments: 0,
      },
      createdAt: new Date().toISOString(),
    };

    if (existingIdx >= 0) {
      records[existingIdx] = {
        ...records[existingIdx],
        ...record,
        // Preserve metrics if they exist
        metrics: records[existingIdx].metrics || record.metrics,
      };
    } else {
      records.push(record);
    }

    this.writeDb(records);
    pipelineLogger.info(
      `Upload registered in analytics database: ${id}`,
      "ViralAnalyzer",
    );
  }

  /**
   * Mock or manually update performance metrics for a video to close the feedback loop.
   */
  public updateMetrics(id: string, metrics: Partial<UploadMetrics>): void {
    const records = this.readDb();
    const record = records.find((r) => r.id === id);
    if (record) {
      record.metrics = {
        ...record.metrics,
        ...metrics,
      };
      this.writeDb(records);
      pipelineLogger.info(
        `Metrics updated in analytics database for ${id}: views=${record.metrics.views}`,
        "ViralAnalyzer",
      );
    } else {
      pipelineLogger.warn(
        `Video ${id} not found in analytics database to update metrics`,
        "ViralAnalyzer",
      );
    }
  }

  /**
   * Retrieve all records from the analytics database.
   */
  public getRecords(): AnalyticsRecord[] {
    return this.readDb();
  }

  /**
   * Extract high-performing keywords, title shapes, and hashtags to feed into LLM prompts.
   */
  public getViralPatterns(noHistoryHint?: string): string {
    const records = this.readDb();
    if (records.length === 0) {
      return (
        noHistoryHint ||
        "No historical uploads data yet. Prefer curiosity-driven programming/tech hooks with high contrast words (e.g. 'replace developers', '10x faster', 'cheat code')."
      );
    }

    // Filter to videos with more than 0 views or sort by views / retention
    const topVideos = [...records]
      .sort((a, b) => {
        // Sort by Views first, then retention rate
        const aScore = a.metrics.views + a.metrics.retentionRate * 1000;
        const bScore = b.metrics.views + b.metrics.retentionRate * 1000;
        return bScore - aScore;
      })
      .slice(0, 5);

    if (topVideos.length === 0 || topVideos[0].metrics.views === 0) {
      // If we have history but no views recorded yet, return general high-engagement patterns
      const tags = Array.from(new Set(records.flatMap((r) => r.tags)))
        .slice(0, 8)
        .join(", ");
      return `Historical uploads titles style: ${records
        .slice(-3)
        .map((r) => `"${r.title}"`)
        .join(", ")}. Keywords/Tags: ${tags}.`;
    }

    const titleExamples = topVideos
      .map(
        (v) =>
          `"${v.title}" (Views: ${v.metrics.views}, Retention: ${Math.round(v.metrics.retentionRate * 100)}%)`,
      )
      .join("\n- ");
    const commonTags = Array.from(new Set(topVideos.flatMap((v) => v.tags)))
      .slice(0, 10)
      .join(", ");

    return `INSPIRATION FROM TOP HISTORICAL VIDEOS:\n- ${titleExamples}\n\nSuccessful Tags/Keywords to reuse: ${commonTags}`;
  }
}
