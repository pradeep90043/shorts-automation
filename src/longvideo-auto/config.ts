import { CandidateStore } from "./candidateStore";

/** Same channel order as the Shorts grid: the long videos are made one after another in this order. */
export const AUTO_LONG_DEFAULT_CHANNELS = ["codeorcap", "storiyum", "prompt_gag", "infoonspot"];

const on = (v?: string): boolean => /^(1|true|on|yes)$/i.test((v ?? "").trim());

/** Master switch: the daily 10-minute video is made only when this is set (candidates are recorded either way). */
export const autoLongEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => on(env.AUTO_LONG_VIDEO_ENABLED);

export function autoLongChannels(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.AUTO_LONG_CHANNELS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return raw.length ? raw : AUTO_LONG_DEFAULT_CHANNELS;
}

let store: CandidateStore | null = null;
/** One store per process: every ChannelWatcher records into the same file. */
export function candidateStore(): CandidateStore {
  return (store ??= new CandidateStore());
}
