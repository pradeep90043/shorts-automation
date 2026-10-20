import assert from "assert";
import { ChannelWatcher } from "../src/instagram/channelWatcher";
const mk = (c: string, n: number) => ({ shortcode: `${c}${n}`, channel: `search:${c}` });
const pool = [mk("hack", 1), mk("hack", 2), mk("hack", 3), mk("space", 1), mk("space", 2), mk("tips", 1)];
const out = ChannelWatcher.interleaveBySearchTopic(pool).map((r: any) => r.shortcode);
assert.deepStrictEqual(out, ["hack1", "space1", "tips1", "hack2", "space2", "hack3"]);
const real = [{ channel: "someone", creatorUsername: "someone" }, mk("a", 1)];
assert.strictEqual((ChannelWatcher.interleaveBySearchTopic(real as any)[0] as any).channel, "someone");
console.log("✓ search topics are interleaved");
