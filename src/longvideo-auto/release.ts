import { CHANNEL_ORDER, DEFAULT_GRID, GridConfig, longReleaseSlots } from "../schedule/shortsGrid";

const IST_MS = 5.5 * 60 * 60 * 1000;

/** UTC ms of `minute` after IST midnight of the IST calendar date `istDate` (YYYY-MM-DD). */
export function istMinuteToUtcMs(istDate: string, minute: number): number {
  return Date.parse(`${istDate}T00:00:00Z`) + minute * 60 * 1000 - IST_MS;
}

const addDays = (istDate: string, days: number): string =>
  new Date(Date.parse(`${istDate}T00:00:00Z`) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

export interface ReleaseAssignment {
  istDate: string;
  minute: number;
  atMs: number;
}

/**
 * Picks the public release time for a finished long video.
 * Each channel has its own evening slot (CODEOR... order = slot order), so the four never release together and none lands on
 * a Short. If today's slot has already passed (the video finished late, or the box was down), the next free slot is
 * used, today if any is left, otherwise tomorrow's first: a video is never released instantly "to catch up".
 *
 * @param taken slots already given to another video: `${istDate}:${minute}`
 */
export function assignRelease(
  channelKey: string,
  nowMs: number,
  istDateToday: string,
  taken: Set<string> = new Set(),
  channelCount = CHANNEL_ORDER.length,
  cfg: GridConfig = DEFAULT_GRID,
  minLeadMin = 10,
): ReleaseAssignment {
  const slots = longReleaseSlots(channelCount, channelCount, 18 * 60, 21 * 60 + 30, cfg);
  if (!slots.length) throw new Error("No long-video release slots fit between the Shorts");
  const own = (CHANNEL_ORDER as readonly string[]).indexOf(channelKey.toLowerCase());
  const preferred = own >= 0 && own < slots.length ? own : 0;
  // today: the channel's own slot first, then the later ones; tomorrow: the same order
  const order = [...slots.slice(preferred), ...slots.slice(0, preferred)];
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const date = addDays(istDateToday, dayOffset);
    for (const minute of order) {
      const atMs = istMinuteToUtcMs(date, minute);
      if (atMs < nowMs + minLeadMin * 60 * 1000) continue;
      if (taken.has(`${date}:${minute}`)) continue;
      return { istDate: date, minute, atMs };
    }
  }
  throw new Error("No free release slot in the next 3 days");
}
