import fs from "fs";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "./logger";
import { PipelineContext, VideoMetadata } from "../types";

export interface JobEntry {
  id: string;
  status:
    | "pending"
    | "analyzing"
    | "rendering_video"
    | "frame_review"
    | "adding_music"
    | "final_review"
    | "completed"
    | "failed";
  currentStep: string;
  source: string; // e.g. telegram chatId / messageId
  mediaType: "image" | "video";
  mediaHash?: string;
  ocrResult?: any;
  visionResult?: any;
  caption?: string;
  metadata?: VideoMetadata;
  youtubeUrl?: string;
  safeArea?: { x: number; y: number; width: number; height: number };
  error?: string;
  createdAt: string;
  updatedAt: string;
  context: PipelineContext; // Full context dump for dynamic resumption
}

export class JobDatabase {
  private dbFilePath: string;
  private jobs = new Map<string, JobEntry>();

  constructor() {
    const logDir = config.paths.logDir || path.resolve(__dirname, "../../logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.dbFilePath = path.join(logDir, "jobs_db.json");
    this.loadFromFile();
  }

  private loadFromFile(): void {
    try {
      if (fs.existsSync(this.dbFilePath)) {
        const raw = fs.readFileSync(this.dbFilePath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, JobEntry>;
        for (const [id, job] of Object.entries(parsed)) {
          this.jobs.set(id, job);
        }
        pipelineLogger.info(
          `Loaded ${this.jobs.size} active jobs from database`,
          "JobDatabase",
        );
      } else {
        this.saveToFile();
      }
    } catch (err) {
      pipelineLogger.warn(
        `Failed to parse jobs database: ${err instanceof Error ? err.message : err}. Reinitializing.`,
        "JobDatabase",
      );
    }
  }

  private saveToFile(): void {
    try {
      const records: Record<string, JobEntry> = {};
      for (const [id, job] of this.jobs.entries()) {
        records[id] = job;
      }

      // Perform an atomic write: write to temp file first, then rename.
      // This prevents database corruption if the process crashes mid-write.
      const tempPath = `${this.dbFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(records, null, 2), "utf8");
      fs.renameSync(tempPath, this.dbFilePath);
    } catch (err) {
      pipelineLogger.error(
        `Failed to write jobs database to file`,
        err,
        "JobDatabase",
      );
    }
  }

  public createJob(
    id: string,
    initialData: Omit<JobEntry, "id" | "createdAt" | "updatedAt">,
  ): JobEntry {
    const now = new Date().toISOString();
    const entry: JobEntry = {
      id,
      ...initialData,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, entry);
    this.saveToFile();
    pipelineLogger.info(`Job created in database: ${id}`, "JobDatabase");
    return entry;
  }

  public updateJob(
    id: string,
    updates: Partial<Omit<JobEntry, "id" | "createdAt">>,
  ): JobEntry | null {
    const job = this.jobs.get(id);
    if (!job) return null;

    const updatedJob: JobEntry = {
      ...job,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    // Ensure we keep context and updates in sync
    if (updates.status) {
      updatedJob.context.status = updates.status as any;
    }
    if (updates.error) {
      updatedJob.context.error = updates.error;
    }

    this.jobs.set(id, updatedJob);
    this.saveToFile();
    pipelineLogger.info(
      `Job updated in database: ${id} -> Status: ${updatedJob.status}`,
      "JobDatabase",
    );
    return updatedJob;
  }

  public getJob(id: string): JobEntry | null {
    return this.jobs.get(id) || null;
  }

  public listActiveJobs(): JobEntry[] {
    return Array.from(this.jobs.values()).filter(
      (job) => job.status !== "completed" && job.status !== "failed",
    );
  }
}
