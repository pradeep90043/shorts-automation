import { switchOn } from "../utils/switches";
import { CandidateStore } from "./candidateStore";

/** Same channel order as the Shorts grid: the long videos are made one after another in this order. */
export const AUTO_LONG_DEFAULT_CHANNELS = ["codeorcap", "storiyum", "prompt_gag", "infoonspot"];

/**
 * Master switch of the daily 10-minute video: ON by default, DAILY_LONG_VIDEO=off stops it (candidates are still recorded).
 * NOT AUTO_LONG_VIDEO_ENABLED: that name belongs to the older 5-minute "companion" video in direct-uploader.ts, which is
 * heavy, off by default and unrelated to this system.
 */
export const dailyLongEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => switchOn("DAILY_LONG_VIDEO", env, true);

export function autoLongChannels(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.DAILY_LONG_CHANNELS ?? env.AUTO_LONG_CHANNELS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return raw.length ? raw : AUTO_LONG_DEFAULT_CHANNELS;
}

let store: CandidateStore | null = null;
/** One store per process: every ChannelWatcher records into the same file. */
export function candidateStore(): CandidateStore {
  return (store ??= new CandidateStore());
}
