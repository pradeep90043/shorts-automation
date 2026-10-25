import { switchOn } from "../utils/switches";

/**
 * Short-format experiment: every format runs every day and rotates over the day's slots, so each format sees each slot equally
 * (a Latin square) and day-of-week or time-of-day effects do not decide the winner. Pure, so it is testable without clocks.
 *
 *   image_music  one static image + synthesised music (5-10 s), automated
 *   image_voice  several images + our voiceover (30-45 s), automated
 *   stickman     the existing stickman / emotion Short, automated (the control)
 *   manual       the image is posted by hand in the YouTube app with a library song: the pipeline only prepares the candidate
 *
 * The last slot of the day is the flex slot: it repeats the current leader (FORMAT_TEST_LEADER, default image_music).
 */
export const SHORT_FORMATS = ["image_music", "image_voice", "stickman", "manual"] as const;
export type ShortFormat = (typeof SHORT_FORMATS)[number];

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole IST days since the epoch: the same value for every slot of one IST day. */
export const istDayIndex = (nowMs: number): number => Math.floor((nowMs + IST_OFFSET_MS) / DAY_MS);

/** Off by default: until the generators for the image formats are in place nothing may change how Shorts are made. */
export const formatTestActive = (env: NodeJS.ProcessEnv = process.env): boolean => switchOn("FORMAT_TEST", env, false);

export function leaderFormat(env: NodeJS.ProcessEnv = process.env): ShortFormat {
  const raw = (env.FORMAT_TEST_LEADER ?? "").trim().toLowerCase();
  return (SHORT_FORMATS as readonly string[]).includes(raw) ? (raw as ShortFormat) : "image_music";
}

/**
 * The format of a channel's `slotIndex`-th Short (0-based, in time order) on IST day `dayIndex`.
 * Slots 0-3 rotate one step per day (over 4 days every format appears once in every slot); slots 4+ are flex slots.
 */
export function formatForSlot(slotIndex: number, dayIndex: number, env: NodeJS.ProcessEnv = process.env): ShortFormat {
  if (!Number.isInteger(slotIndex) || slotIndex < 0) throw new Error(`Bad slot index: ${slotIndex}`);
  if (slotIndex >= SHORT_FORMATS.length) return leaderFormat(env);
  const n = SHORT_FORMATS.length;
  return SHORT_FORMATS[(((slotIndex + dayIndex) % n) + n) % n];
}
