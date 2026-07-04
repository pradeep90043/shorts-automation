import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "../config";
import { pipelineLogger } from "./logger";
import { OcrResult, BrandingDetectionResult, VideoMetadata, ImageAnalysisResult } from "../types";

export interface CacheEntry {
  hash: string;
  analysis?: ImageAnalysisResult;
  metadata?: VideoMetadata;
  brandingDetection?: BrandingDetectionResult;
  ocr?: OcrResult;
  rephrasedCaption?: string;
  safeArea?: { x: number; y: number; width: number; height: number };
  safeAreaCandidates?: any;
  existingBanner?: boolean;
  bannerBounds?: any;
  protectedRegions?: any;
  recommendedPlacement?: string;
  qualityScore?: any;
  captionVariants?: { A: string; B: string; C: string };
  createdAt: string;
}

export function getFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      reject(new Error(`File not found for hashing: ${filePath}`));
      return;
    }
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

export class CacheManager {
  private cacheFilePath: string;
  private memoryCache = new Map<string, CacheEntry>();

  constructor() {
    // Save cache in output or temp directory config
    const logDir = config.paths.logDir || path.resolve(__dirname, "../../logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.cacheFilePath = path.join(logDir, "ai_cache.json");
    this.loadCacheFromFile();
  }

  private loadCacheFromFile(): void {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const rawData = fs.readFileSync(this.cacheFilePath, "utf8");
        const parsed = JSON.parse(rawData) as Record<string, CacheEntry>;
        for (const [key, value] of Object.entries(parsed)) {
          this.memoryCache.set(key, value);
        }
        pipelineLogger.info(
          `Loaded ${this.memoryCache.size} entries from AI cache file`,
          "CacheManager",
        );
      } else {
        this.saveCacheToFile();
      }
    } catch (err) {
      pipelineLogger.warn(
        `Failed to load AI cache file: ${err instanceof Error ? err.message : err}. Starting fresh.`,
        "CacheManager",
      );
    }
  }

  private saveCacheToFile(): void {
    try {
      const records: Record<string, CacheEntry> = {};
      for (const [key, value] of this.memoryCache.entries()) {
        records[key] = value;
      }
      fs.writeFileSync(
        this.cacheFilePath,
        JSON.stringify(records, null, 2),
        "utf8",
      );
    } catch (err) {
      pipelineLogger.error(
        `Failed to save AI cache file to disk`,
        err,
        "CacheManager",
      );
    }
  }

  public get(hash: string): CacheEntry | null {
    const entry = this.memoryCache.get(hash);
    return entry || null;
  }

  public set(
    hash: string,
    entry: Omit<CacheEntry, "hash" | "createdAt">,
  ): void {
    const fullEntry: CacheEntry = {
      hash,
      ...entry,
      createdAt: new Date().toISOString(),
    };
    this.memoryCache.set(hash, fullEntry);
    this.saveCacheToFile();
    pipelineLogger.info(
      `Saved entry in AI cache for hash ${hash}`,
      "CacheManager",
    );
  }

  public delete(hash: string): void {
    if (this.memoryCache.has(hash)) {
      this.memoryCache.delete(hash);
      this.saveCacheToFile();
      pipelineLogger.info(
        `Deleted entry from AI cache for hash ${hash}`,
        "CacheManager",
      );
    }
  }

  public clear(): void {
    this.memoryCache.clear();
    this.saveCacheToFile();
    pipelineLogger.info("Cleared all entries from AI cache", "CacheManager");
  }
}
