import { getDb } from "./mongoClient";
import { pipelineLogger } from "./logger";

export interface ReelRecord {
  channel: string;
  pickedAt: string;
  publishedAt?: string;
  youtubeUrl?: string;
  instagramUrl?: string;
  failed?: boolean;
  failedReason?: string;
}

interface ReelDoc extends ReelRecord {
  shortcode: string;
  profileKey: string;
}

const COLLECTION = "reel_history";

/**
 * Permanent, append-only store for every reel the channel-watcher has ever
 * picked. Backed by MongoDB Atlas so history survives across any number of
 * server restarts, fresh clones, or re-deployments.
 *
 * Reads are served from an in-memory Map (fast, sync) populated once at
 * startup via load(). All writes persist immediately to MongoDB.
 */
export class ReelHistoryStore {
  private profileKey: string;
  private records = new Map<string, ReelRecord>();

  constructor(dbKey?: string) {
    this.profileKey = dbKey ?? "default";
  }

  public async load(): Promise<void> {
    const db = await getDb();
    const docs = await db
      .collection<ReelDoc>(COLLECTION)
      .find({ profileKey: this.profileKey })
      .toArray();
    for (const doc of docs) {
      const { shortcode, profileKey: _pk, ...record } = doc as ReelDoc & { _id: unknown };
      this.records.set(shortcode, record as ReelRecord);
    }
    pipelineLogger.info(
      `Loaded ${this.records.size} reel history record(s) [${this.profileKey}]`,
      "ReelHistoryStore",
    );
  }

  /** True if this shortcode has ever been picked (regardless of publish outcome). */
  public has(shortcode: string): boolean {
    return this.records.has(shortcode);
  }

  /** Record a newly-picked reel before it enters the publish queue. */
  public async add(shortcode: string, channel: string): Promise<void> {
    if (this.records.has(shortcode)) return;
    const record: ReelRecord = { channel, pickedAt: new Date().toISOString() };
    this.records.set(shortcode, record);
    const db = await getDb();
    await db.collection<ReelDoc>(COLLECTION).updateOne(
      { shortcode, profileKey: this.profileKey },
      { $setOnInsert: { shortcode, profileKey: this.profileKey, ...record } },
      { upsert: true },
    );
  }

  public async markPublished(
    shortcode: string,
    youtubeUrl?: string,
    instagramUrl?: string,
  ): Promise<void> {
    const rec = this.records.get(shortcode);
    if (!rec) return;
    rec.publishedAt = new Date().toISOString();
    rec.failed = false;
    rec.failedReason = undefined;
    if (youtubeUrl) rec.youtubeUrl = youtubeUrl;
    if (instagramUrl) rec.instagramUrl = instagramUrl;
    const db = await getDb();
    await db.collection<ReelDoc>(COLLECTION).updateOne(
      { shortcode, profileKey: this.profileKey },
      { $set: { publishedAt: rec.publishedAt, failed: false, failedReason: undefined, youtubeUrl, instagramUrl } },
    );
  }

  public async markFailed(shortcode: string, reason?: string): Promise<void> {
    const rec = this.records.get(shortcode);
    if (!rec) return;
    rec.failed = true;
    rec.failedReason = reason;
    const db = await getDb();
    await db.collection<ReelDoc>(COLLECTION).updateOne(
      { shortcode, profileKey: this.profileKey },
      { $set: { failed: true, failedReason: reason ?? "Unknown error" } },
    );
  }

  public size(): number {
    return this.records.size;
  }

  /**
   * One-time migration: import legacy processedShortcodes from old
   * watch_state.json (array of strings, no metadata). Safe to call every
   * startup — entries that already exist are skipped.
   */
  public async migrate(shortcodes: string[]): Promise<void> {
    const db = await getDb();
    let added = 0;
    for (const s of shortcodes) {
      if (this.records.has(s)) continue;
      const record: ReelRecord = { channel: "unknown", pickedAt: new Date(0).toISOString() };
      this.records.set(s, record);
      await db.collection<ReelDoc>(COLLECTION).updateOne(
        { shortcode: s, profileKey: this.profileKey },
        { $setOnInsert: { shortcode: s, profileKey: this.profileKey, ...record } },
        { upsert: true },
      );
      added++;
    }
    if (added > 0) {
      pipelineLogger.info(
        `Migrated ${added} legacy shortcode(s) into reel history [${this.profileKey}]`,
        "ReelHistoryStore",
      );
    }
  }
}
