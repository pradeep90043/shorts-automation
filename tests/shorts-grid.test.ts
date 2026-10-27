import assert from "assert";
import {
  CHANNEL_ORDER, DEFAULT_GRID, allShortSlots, channelSlotIndex, gridFromEnv, hhmm, longReleaseSlots, parseHhmm, pickMinute,
  shortSlots, shortsGridActive, spreadSlots, validateGrid,
} from "../src/schedule/shortsGrid";

const N = CHANNEL_ORDER.length; // 4
validateGrid(N);

// the day: 16 distinct slots from 08:00, the last one before 21:00
const all = allShortSlots(N);
assert.strictEqual(all.length, 16);
assert.strictEqual(hhmm(all[0].minute), "08:00");
assert.strictEqual(hhmm(all[all.length - 1].minute), "20:30");
assert.strictEqual(new Set(all.map((s) => s.minute)).size, 16, "no two channels share a minute");
assert.ok(all.every((s) => s.minute >= 8 * 60 && s.minute < 21 * 60));

// each channel: 4 slots, 3 h 20 min apart, interleaved with the others
assert.deepStrictEqual(shortSlots(0, N).map(hhmm), ["08:00", "11:20", "14:40", "18:00"]);
assert.deepStrictEqual(shortSlots(1, N).map(hhmm), ["08:50", "12:10", "15:30", "18:50"]);
assert.deepStrictEqual(shortSlots(2, N).map(hhmm), ["09:40", "13:00", "16:20", "19:40"]);
assert.deepStrictEqual(shortSlots(3, N).map(hhmm), ["10:30", "13:50", "17:10", "20:30"]);

// 2 Shorts a day = one morning, one evening, a different time on every channel
const twoADay = [0, 1, 2, 3].map((c) => spreadSlots(shortSlots(c, N), 2).map(hhmm));
assert.deepStrictEqual(twoADay, [["08:00", "18:00"], ["08:50", "18:50"], ["09:40", "19:40"], ["10:30", "20:30"]]);
assert.deepStrictEqual(spreadSlots([1, 2, 3, 4], 3), [1, 3, 4]);
assert.deepStrictEqual(spreadSlots([1, 2, 3, 4], 1), [1]);
assert.deepStrictEqual(spreadSlots([1, 2], 5), [1, 2]);
assert.deepStrictEqual(spreadSlots([1, 2], 0), []);

// long videos go out between Shorts: at least 22 min from every Short slot
const rel = longReleaseSlots(4, N);
assert.deepStrictEqual(rel.map(hhmm), ["18:25", "19:15", "20:05", "20:55"]);
for (const r of rel) for (const s of all) assert.ok(Math.abs(r - s.minute) >= 22, `${hhmm(r)} too close to ${hhmm(s.minute)}`);

// reel selection happens before the first slot, 5 min apart per channel
assert.strictEqual(hhmm(pickMinute(0)), "07:00");
assert.strictEqual(hhmm(pickMinute(3)), "07:15");

// channel keys map to a stable place; an unknown channel goes after the known ones
assert.strictEqual(channelSlotIndex("CodeOrCap", 9), 0);
assert.strictEqual(channelSlotIndex("infoonspot", 0), 3);
assert.strictEqual(channelSlotIndex("newchannel", 0), 4);

// a grid that cannot fit is rejected loudly, not silently truncated
assert.throws(() => validateGrid(4, { ...DEFAULT_GRID, stepMin: 60 }), /fits \d+ of 16 slots/);
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
