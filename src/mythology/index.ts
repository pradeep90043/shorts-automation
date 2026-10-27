import fs from "fs";
import path from "path";
import { EdgeTTS } from "node-edge-tts";
import { startClonedLines } from "../audio/clonedVoice";
import { config } from "../config";
import { askUntil } from "../formats/runFormat";
import type { Ask } from "../longvideo-auto/llm";
import { CHANNEL_ORDER, channelSlotIndex, gridFromEnv, hhmm, shortSlots } from "../schedule/shortsGrid";
import type { VideoMetadata } from "../types";
import { pipelineLogger } from "../utils/logger";
import { renderMythShort } from "./render";
import { mythDescription, mythPrompt, parseMythScript, type MythScript } from "./script";
import { pickTopic, TopicHistory, type MythTopic } from "./topics";

/**
 * Mythology Shorts: a channel in MYTHOLOGY_CHANNELS (default prompt_gag; "off" = none) stops picking source reels and instead
 * publishes MYTHOLOGY_PER_DAY (default 2) original Shorts a day on its grid slots: a story from the topic bank, written by the
 * LLM, painted scene by scene, narrated by the channel's cloned voice. Each one is made MYTHOLOGY_LEAD_MIN (default 50)
 * minutes before its slot and uploaded at the slot.
 */
export function mythologyChannels(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.MYTHOLOGY_CHANNELS ?? "prompt_gag").trim().toLowerCase();
  if (["", "off", "none", "0", "false", "no"].includes(raw)) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
export const isMythologyChannel = (key: string, env: NodeJS.ProcessEnv = process.env): boolean => mythologyChannels(env).includes(key.toLowerCase());

/** The channel's slots (minutes after IST midnight) it publishes on: spread over the day, so 2 a day = its first and last slot. */
export function mythSlots(channelKey: string, env: NodeJS.ProcessEnv = process.env): number[] {
  const all = shortSlots(channelSlotIndex(channelKey, 0), CHANNEL_ORDER.length, gridFromEnv(env));
  const want = Math.max(1, Math.min(all.length, Number(env.MYTHOLOGY_PER_DAY) || 2));
  if (want >= all.length) return all;
  if (want === 1) return [all[all.length - 1]];
  return Array.from({ length: want }, (_, i) => all[Math.round((i * (all.length - 1)) / (want - 1))]);
}

const IST_MS = 5.5 * 3600_000;
export const istDate = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 10);
export const istMinute = (ms: number): number => Math.floor(((ms + IST_MS) % 86_400_000) / 60_000);

/** The slot to work on now: due within the lead time, not done today, and not more than 2 h overdue. null = nothing to do. */
export function dueSlot(slots: number[], done: number[], nowMs: number, leadMin: number): number | null {
  const now = istMinute(nowMs);
  return slots.find((m) => !done.includes(m) && now >= m - leadMin && now <= m + 120) ?? null;
}

interface DayState {
  date: string;
  done: number[];
}

export interface MythDeps {
  ask: Ask;
  upload(channelKey: string, videoPath: string, md: VideoMetadata): Promise<string | null>;
  handle(channelKey: string): string;
  now(): number;
  /** another Short is being processed: wait, the server has little memory */
  busy(): boolean;
}

/** Each scene's line from the cloned voice; any line it could not make comes from the Edge male Hindi voice. */
async function voiceLines(script: MythScript, channelKey: string, dir: string): Promise<string[]> {
  const lines = script.scenes.map((s, i) => ({ name: `m${i}`, text: s.narration }));
  const cloned = await startClonedLines(`myth-${Date.now()}`, lines, channelKey);
  const out: string[] = [];
  for (const l of lines) {
    const f = cloned?.file(l.name);
    if (f) {
      out.push(f);
      continue;
    }
    const edge = path.join(dir, `${l.name}.mp3`);
    await new EdgeTTS({ voice: "hi-IN-MadhurNeural", lang: "hi-IN", outputFormat: "audio-24khz-48kbitrate-mono-mp3", rate: "-8%" }).ttsPromise(l.text, edge);
    out.push(edge);
  }
  if (!cloned) pipelineLogger.warn("Mythology: cloned voice unavailable, narrated with the Edge voice", "Mythology");
  return out;
}

/** One finished Short on disk with its metadata. Throws when the story or the render fails. */
export async function makeMythShort(channelKey: string, topic: MythTopic, deps: Pick<MythDeps, "ask" | "handle">, workDir: string) {
  const script = await askUntil((p) => deps.ask(p, { maxTokens: 3000 }), mythPrompt(topic), parseMythScript);
  if (!script) throw new Error(`no usable script for "${topic.id}"`);
  fs.mkdirSync(workDir, { recursive: true });
  const voices = await voiceLines(script, channelKey, workDir);
  const out = path.join(workDir, "myth_short.mp4");
  await renderMythShort(script, { tempDir: path.join(workDir, "r"), out, voices, handle: deps.handle(channelKey) });
  const md: VideoMetadata = {
    title: script.title,
    description: mythDescription(script, topic),
    tags: [...script.tags, "mythology", "hindi kahani", "shorts"],
    thumbnailText: script.hook,
    mood: "serious",
  };
  return { video: out, metadata: md, script };
}

export function startMythology(deps: MythDeps): void {
  const channels = mythologyChannels();
  if (!channels.length) {
    pipelineLogger.info("Mythology Shorts: off (MYTHOLOGY_CHANNELS=off)", "Mythology");
    return;
  }
  const lead = Number(process.env.MYTHOLOGY_LEAD_MIN) || 50;
  const dir = path.join(config.paths.logDir || "logs", "mythology");
  const stateFile = (key: string) => path.join(dir, `${key}_day.json`);
  const readState = (key: string, date: string): DayState => {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile(key), "utf8")) as DayState;
      return s.date === date ? s : { date, done: [] };
    } catch {
      return { date, done: [] };
    }
  };
  const writeState = (key: string, s: DayState) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFile(key), JSON.stringify(s));
  };
  for (const key of channels) {
    pipelineLogger.info(`Mythology Shorts ACTIVE for ${key}: ${mythSlots(key).map(hhmm).join(", ")} IST (made ${lead} min ahead)`, "Mythology");
  }

  let working = false;
  const tick = async () => {
    if (working || deps.busy()) return;
    for (const key of channels) {
      const now = deps.now();
      const state = readState(key, istDate(now));
      const slot = dueSlot(mythSlots(key), state.done, now, lead);
      if (slot === null) continue;
      working = true;
      const history = new TopicHistory(path.join(dir, `${key}_topics.json`));
      const tried: string[] = [];
      try {
        for (let attempt = 1; attempt <= 2; attempt++) {
          const topic = pickTopic(history.used(), tried);
          tried.push(topic.id);
          try {
            pipelineLogger.info(`Mythology (${key}) ${hhmm(slot)} slot: "${topic.id}" (attempt ${attempt}/2)`, "Mythology");
            const made = await makeMythShort(key, topic, deps, path.join(config.paths.tempDir || "temp", `myth-${key}-${Date.now()}`));
            // publish at the slot, not before it
            const wait = (slot - istMinute(deps.now())) * 60_000;
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            const videoId = await deps.upload(key, made.video, made.metadata);
            if (!videoId) throw new Error("upload failed");
            history.record(topic.id, videoId);
            pipelineLogger.info(`Mythology (${key}): published "${made.metadata.title}" (${videoId})`, "Mythology");
            break;
          } catch (err) {
            pipelineLogger.warn(`Mythology (${key}) "${topic.id}" failed: ${err instanceof Error ? err.message : err}`, "Mythology");
          }
        }
      } finally {
        // a slot is tried at most twice: a failing provider must not eat the whole day
        writeState(key, { ...state, done: [...state.done, slot] });
        working = false;
      }
      return;
    }
  };
  setInterval(() => void tick().catch((e) => pipelineLogger.error("Mythology tick failed", e, "Mythology")), 60_000);
}
