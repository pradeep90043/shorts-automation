import fs from "fs";
import path from "path";
import { config } from "../config";
import { pipelineLogger } from "./logger";
import { BrandingZone } from "../types";

interface CreatorZoneEntry {
  zones: BrandingZone[];
  updatedAt: string;
}

// Keyed by the source creator's @handle (lowercase, no leading @) — shared
// across both channel profiles, since the zones are stored in the same
// normalized 0–1 coordinates the branding detector already uses, relative
// to that creator's own source frame, not to whichever of our channels
// reposts them.
type CreatorZoneState = Record<string, CreatorZoneEntry>;

/**
 * Repost/meme accounts stamp their own watermark/handle/profile-picture
 * overlay in the same fixed position on every reel they post. Once AI vision
 * has found that position for a given creator, there's no need to gamble on
 * the AI finding it again on their next reel — reuse the known position
 * directly. This also protects against a future AI-vision miss (quota
 * fallback to a weaker path, a frame where the overlay is briefly occluded,
 * etc.) once a creator's layout is already known.
 */
export class CreatorZoneStore {
  private filePath: string;
  private state: CreatorZoneState = {};

  constructor() {
    const logDir = config.paths.logDir || path.resolve(__dirname, "../../logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    this.filePath = path.join(logDir, "creator_zones.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        this.state = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      }
    } catch (err) {
      pipelineLogger.warn(
        `Failed to parse creator zones file: ${err instanceof Error ? err.message : err}. Reinitializing.`,
        "CreatorZoneStore",
      );
      this.state = {};
    }
  }

  private save(): void {
    try {
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), "utf8");
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      pipelineLogger.error(
        "Failed to write creator zones file",
        err,
        "CreatorZoneStore",
      );
    }
  }

  private normalize(username: string): string {
    return username.trim().replace(/^@/, "").toLowerCase();
  }

  public getZones(username: string): BrandingZone[] | undefined {
    return this.state[this.normalize(username)]?.zones;
  }

  /** No-ops on an empty zone list — a miss should never erase a known-good position. */
  public saveZones(username: string, zones: BrandingZone[]): void {
    if (zones.length === 0) return;
    const key = this.normalize(username);
    this.state[key] = { zones, updatedAt: new Date().toISOString() };
    this.save();
    pipelineLogger.info(
      `Cached ${zones.length} branding zone(s) for creator @${key}`,
      "CreatorZoneStore",
    );
  }
}

export const creatorZoneStore = new CreatorZoneStore();
