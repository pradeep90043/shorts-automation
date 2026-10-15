import assert from "assert";
import {
  CHANNEL_ORDER, DEFAULT_GRID, allShortSlots, channelSlotIndex, gridFromEnv, hhmm, longReleaseSlots, parseHhmm, pickMinute,
  shortSlots, shortsGridActive, validateGrid,
} from "../src/schedule/shortsGrid";

const N = CHANNEL_ORDER.length; // 4
validateGrid(N);

// the day: 20 distinct slots from 07:00, the last one before 22:00
const all = allShortSlots(N);
assert.strictEqual(all.length, 20);
assert.strictEqual(hhmm(all[0].minute), "07:00");
assert.strictEqual(hhmm(all[all.length - 1].minute), "21:15");
assert.strictEqual(new Set(all.map((s) => s.minute)).size, 20, "no two channels share a minute");
assert.ok(all.every((s) => s.minute >= 7 * 60 && s.minute < 22 * 60));

// each channel: 5 Shorts, 3 hours apart, interleaved with the others
assert.deepStrictEqual(shortSlots(0, N).map(hhmm), ["07:00", "10:00", "13:00", "16:00", "19:00"]);
assert.deepStrictEqual(shortSlots(1, N).map(hhmm), ["07:45", "10:45", "13:45", "16:45", "19:45"]);
assert.deepStrictEqual(shortSlots(2, N).map(hhmm), ["08:30", "11:30", "14:30", "17:30", "20:30"]);
assert.deepStrictEqual(shortSlots(3, N).map(hhmm), ["09:15", "12:15", "15:15", "18:15", "21:15"]);

// long videos go out between Shorts: at least 22 min from every Short slot
const rel = longReleaseSlots(4, N);
assert.deepStrictEqual(rel.map(hhmm), ["18:37", "19:22", "20:07", "20:52"]);
for (const r of rel) for (const s of all) assert.ok(Math.abs(r - s.minute) >= 22, `${hhmm(r)} too close to ${hhmm(s.minute)}`);

// reel selection happens before the first slot, 5 min apart per channel
assert.strictEqual(hhmm(pickMinute(0)), "06:00");
assert.strictEqual(hhmm(pickMinute(3)), "06:15");

// channel keys map to a stable place; an unknown channel goes after the known ones
assert.strictEqual(channelSlotIndex("CodeOrCap", 9), 0);
assert.strictEqual(channelSlotIndex("infoonspot", 0), 3);
assert.strictEqual(channelSlotIndex("newchannel", 0), 4);

// a grid that cannot fit is rejected loudly, not silently truncated
assert.throws(() => validateGrid(4, { ...DEFAULT_GRID, stepMin: 60 }), /fits \d+ of 20 slots/);
assert.strictEqual(parseHhmm("07:05"), 425);
assert.throws(() => parseHhmm("7pm"));

// env overrides; the grid is on unless switched off
assert.strictEqual(gridFromEnv({ SHORTS_GRID_START: "08:00", SHORTS_GRID_STEP_MIN: "30" } as any).stepMin, 30);
assert.strictEqual(shortsGridActive({} as any), true, "on by default");
assert.strictEqual(shortsGridActive({ SHORTS_GRID: "on" } as any), true);
assert.strictEqual(shortsGridActive({ SHORTS_GRID: "off" } as any), false);
assert.strictEqual(shortsGridActive({ SHORTS_GRID: "0" } as any), false);
assert.strictEqual(shortsGridActive({ SHORTS_GRID: " False " } as any), false);

console.log("✓ shorts grid");
