import { switchOn } from "../utils/switches";

/**
 * The daily publishing grid shared by the four channels.
 *
 * 4 slots per channel between 08:00 and 21:00 IST, no two channels at the same minute: slots run every STEP minutes,
 * channel k takes slots k, k+N, k+2N... (N = number of channels), so each channel's slots are N*STEP apart (3 h 20 min for 4
 * channels at 50 min). A channel that publishes fewer Shorts than it has slots spreads them over the day (spreadSlots): 2 a day
 * = its first (morning) and last (evening) slot. Long videos are released in the gaps of that grid, never on a Short slot.
 *
 * Everything here is pure (minutes after IST midnight) so it can be tested without clocks or the watcher.
 */

/** Stable order: a channel's place in the grid must not change when channels are added, so new ones go at the end. */
export const CHANNEL_ORDER = ["codeorcap", "storiyum", "prompt_gag", "infoonspot"] as const;

export interface GridConfig {
  /** first Short slot of the day, minutes after IST midnight */
  startMin: number;
  /** minutes between consecutive slots of the whole grid (all channels) */
  stepMin: number;
  /** Shorts per channel per day */
  perDay: number;
  /** no Short may be scheduled at or after this minute */
  endMin: number;
  /** how many minutes before the first slot a channel picks its reels (scraping needs time) */
  pickLeadMin: number;
}

export const DEFAULT_GRID: GridConfig = { startMin: 8 * 60, stepMin: 50, perDay: 4, endMin: 21 * 60, pickLeadMin: 60 };

export const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export const parseHhmm = (s: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Not a HH:MM time: "${s}"`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Position of a channel in the grid; unknown channels follow the known ones in the order they were given to the watcher. */
export function channelSlotIndex(channelKey: string, fallbackIndex: number): number {
  const i = (CHANNEL_ORDER as readonly string[]).indexOf(channelKey.toLowerCase());
  return i >= 0 ? i : CHANNEL_ORDER.length + Math.max(0, fallbackIndex);
}

/** Minutes after IST midnight of a channel's Shorts for the day. */
export function shortSlots(channelIndex: number, channelCount: number, cfg: GridConfig = DEFAULT_GRID): number[] {
  const n = Math.max(1, channelCount);
  const out: number[] = [];
  for (let i = 0; i < cfg.perDay; i++) {
    const m = cfg.startMin + (channelIndex + i * n) * cfg.stepMin;
    if (m >= cfg.endMin) break;
    out.push(m);
  }
  return out;
}

/**
 * `count` of a channel's slots spread over the day instead of the first `count`: always the first and the last, the rest evenly
 * between (2 = morning + evening, 3 = morning, afternoon, evening). All of them when count >= the slots.
 */
export function spreadSlots(slots: number[], count: number): number[] {
  const want = Math.max(0, Math.floor(count));
  if (want >= slots.length) return [...slots];
  if (want === 0) return [];
  if (want === 1) return [slots[0]];
  return Array.from({ length: want }, (_, i) => slots[Math.round((i * (slots.length - 1)) / (want - 1))]);
}

/** Every Short slot of the day for `channelCount` channels, sorted. */
export function allShortSlots(channelCount: number, cfg: GridConfig = DEFAULT_GRID): { channelIndex: number; minute: number }[] {
  const all: { channelIndex: number; minute: number }[] = [];
  for (let c = 0; c < channelCount; c++) for (const minute of shortSlots(c, channelCount, cfg)) all.push({ channelIndex: c, minute });
  return all.sort((a, b) => a.minute - b.minute || a.channelIndex - b.channelIndex);
}

/** When a channel should run its daily reel selection: shortly before its first slot, staggered by 5 min per channel. */
export function pickMinute(channelIndex: number, cfg: GridConfig = DEFAULT_GRID): number {
  return Math.max(0, cfg.startMin - cfg.pickLeadMin + channelIndex * 5);
}

/**
 * Release minutes for long videos: the middle of the gap between consecutive Short slots inside [windowStart, windowEnd],
 * so each release is at least half a step (22 min) away from every Short. Returns up to `count` of them, in time order.
 */
export function longReleaseSlots(
  count: number,
  channelCount: number,
  windowStartMin = 18 * 60,
  windowEndMin = 21 * 60 + 30,
  cfg: GridConfig = DEFAULT_GRID,
): number[] {
  const slots = allShortSlots(channelCount, cfg).map((s) => s.minute);
  // the gap after the day's last Short counts too (one step on), so a grid that ends early still gives every channel its slot
  if (slots.length) slots.push(slots[slots.length - 1] + cfg.stepMin);
  const out: number[] = [];
  for (let i = 0; i + 1 < slots.length && out.length < count; i++) {
    const mid = Math.floor((slots[i] + slots[i + 1]) / 2);
    if (mid >= windowStartMin && mid <= windowEndMin) out.push(mid);
  }
  return out;
}

/** Throws a readable error when a config cannot produce a valid grid (used at startup and in tests). */
export function validateGrid(channelCount: number, cfg: GridConfig = DEFAULT_GRID): void {
  const all = allShortSlots(channelCount, cfg);
  const expected = channelCount * cfg.perDay;
  if (all.length !== expected) {
    throw new Error(`Shorts grid fits ${all.length} of ${expected} slots before ${hhmm(cfg.endMin)}: reduce the step or the count.`);
  }
  const seen = new Set<number>();
  for (const s of all) {
    if (seen.has(s.minute)) throw new Error(`Two channels share ${hhmm(s.minute)}`);
    seen.add(s.minute);
  }
}

/** Reads SHORTS_GRID_* env vars over the defaults. */
export function gridFromEnv(env: NodeJS.ProcessEnv = process.env): GridConfig {
  return {
    startMin: env.SHORTS_GRID_START ? parseHhmm(env.SHORTS_GRID_START) : DEFAULT_GRID.startMin,
    stepMin: Number(env.SHORTS_GRID_STEP_MIN) || DEFAULT_GRID.stepMin,
    perDay: Number(env.SHORTS_PER_DAY) || DEFAULT_GRID.perDay,
    endMin: env.SHORTS_GRID_END ? parseHhmm(env.SHORTS_GRID_END) : DEFAULT_GRID.endMin,
    pickLeadMin: Number(env.SHORTS_GRID_PICK_LEAD_MIN) || DEFAULT_GRID.pickLeadMin,
  };
}

/** On by default. SHORTS_GRID=off keeps the legacy scheduleTime + 5 min stagger (the planned grid is still logged). */
export const shortsGridActive = (env: NodeJS.ProcessEnv = process.env): boolean => switchOn("SHORTS_GRID", env, true);
