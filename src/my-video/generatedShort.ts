import { exec } from "child_process";
import fs from "fs";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { toDevanagari } from "../audio/clonedVoice";
export { isGeneratedShortChannel } from "./generatedChannels";
import { getStickmanJob, isStickmanBusy, startStickmanJob } from "./stickmanJobs";
import { tagSpeakers, type SpeakerLine } from "../audio/omnivoice/speakers";
import { voiceEngine } from "../audio/narration";
import { makeAsk } from "../longvideo-auto/llm";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Splits narration into sentences, writes each in Devanagari (the cloned voice reads Devanagari), and joins them back. */
async function devanagariScript(script: string): Promise<string> {
  if (/[ऀ-ॿ]/.test(script) && !/[A-Za-z]{4,}\s+[A-Za-z]{3,}/.test(script)) return script;
  const sentences = script.split(/(?<=[।.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const lines = sentences.map((text, i) => ({ name: `g${i}`, text }));
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await toDevanagari(lines);
    if (out) return out.map((l) => l.text).join(" ");
  }
  // all-or-nothing failed three times: sentence by sentence, an English sentence that cannot be converted is dropped (the cloned Hindi voice cannot read it)
  const kept: string[] = [];
  for (const l of lines) {
    const one = /[\u0900-\u097F]/.test(l.text) ? [l] : await toDevanagari([l]);
    if (one) kept.push(one[0].text);
  }
  return kept.length ? kept.join(" ") : script;
}

export interface GeneratedShortInput {
  script: string;
  title: string;
  channelKey: string;
  language?: string;
  /** where the finished 1080x1920 file is written */
  outPath: string;
  onProgress?: (detail: string) => void;
}

/**
 * Renders a vertical Short with my-video from a narration script: the stickman engine plans the scenes, speaks the narration with the
 * channel's cloned voice and renders on the GitHub runners. Throws when it cannot (there is no original reel to fall back to).
 */
export async function renderGeneratedShort(input: GeneratedShortInput): Promise<string> {
  const script = await devanagariScript(input.script.replace(/\s+/g, " ").trim());
  const words = script.split(/\s+/).filter(Boolean).length;
  const targetSec = Math.min(58, Math.max(35, Math.round(words / 2.6)));

  // Storiyum dialogue in character voices (OmniVoice only): one LLM call marks which sentences a character speaks; none = all narrated
  let speakerLines: SpeakerLine[] = [];
  if (input.channelKey.toLowerCase() === "storiyum" && voiceEngine() === "omnivoice") {
    speakerLines = await tagSpeakers(script, makeAsk({ timeoutMs: 60_000, hedgeMs: 15_000 }));
    if (speakerLines.length) pipelineLogger.info(`Generated Short: ${speakerLines.length} dialogue line(s) in character voices (${[...new Set(speakerLines.map((l) => l.speaker))].join(", ")})`, "GeneratedShort");
  }

  const waitUntil = Date.now() + (Number(process.env.GENERATED_SHORT_QUEUE_MIN) || 30) * 60_000;
  while (isStickmanBusy()) {
    if (Date.now() > waitUntil) throw new Error("the video engine stayed busy: the generated Short could not start");
    input.onProgress?.("Waiting for the video engine");
    await sleep(15_000);
  }
  const job = startStickmanJob({
    script, title: input.title, voice: "voicebox", language: input.language ?? "hi",
    channelKey: input.channelKey, orientation: "vertical", targetSec, resolution: 1080, noRunnerPublish: true, keepScript: true, speakerLines,
  });
  pipelineLogger.info(`Generated Short: job ${job.id}, ${words} words, ~${targetSec}s`, "GeneratedShort");

  const deadline = Date.now() + (Number(process.env.GENERATED_SHORT_TIMEOUT_MIN) || 40) * 60_000;
  for (;;) {
    await sleep(10_000);
    const j = getStickmanJob(job.id);
    if (!j) throw new Error("the generated Short job disappeared");
    const stage = j.stages?.find((s) => s.status === "running");
    if (stage) input.onProgress?.(`Generating the Short: ${stage.label}`);
    if (j.status === "failed" || j.status === "cancelled") throw new Error(`generated Short ${j.status}: ${j.error ?? ""}`.trim());
    if (j.status === "done") {
      if (!j.videoPath || !fs.existsSync(j.videoPath)) throw new Error("the generated Short finished without a video file");
      // the exact format the verdict/outro sequence is joined with (1080x1920, 30 fps, 44.1 kHz stereo, broadcast loudness)
      await new Promise<void>((resolve, reject) => {
        exec(
          `${config.binaries.ffmpeg} -y -i "${j.videoPath}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30" ` +
            `-af "aresample=44100,loudnorm=I=-16:TP=-1.5:LRA=11" -ar 44100 -ac 2 -c:v libx264 -preset superfast -crf 20 -pix_fmt yuv420p -c:a aac "${input.outPath}"`,
          (err) => (err ? reject(err) : resolve()),
        );
      });
      return input.outPath;
    }
    if (Date.now() > deadline) throw new Error("the generated Short took too long");
  }
}
