import { tagEmotions } from "./emotion";
import { buildOmniVoiceJob } from "./omnivoice/job";
import { runOnKaggle } from "./omnivoice/kaggleRunner";
import { generateVoiceboxNarration, type VoiceboxOptions } from "../my-video/voiceboxNarration";
import { pipelineLogger as logger } from "../utils/logger";

/**
 * Narration for a video or a Short: one <name>.mp3 per line in the channel's voice, whatever engine speaks it.
 *   omnivoice (default): OmniVoice on a free Kaggle T4 (fast); when Kaggle fails, is out of quota or too slow, the same runner on
 *                        GitHub Actions CPU runners (omnivoice-scenes.yml, slow but parallel)
 *   voicebox:            the old Chatterbox path (voicebox-scenes.yml), kept behind VOICE_ENGINE=voicebox as an emergency switch
 */
export const OMNIVOICE_WORKFLOW = "omnivoice-scenes.yml";

export type VoiceEngine = "omnivoice" | "voicebox";
export const voiceEngine = (env: NodeJS.ProcessEnv = process.env): VoiceEngine =>
  /^voicebox$/i.test((env.VOICE_ENGINE ?? "").trim()) ? "voicebox" : "omnivoice";
const kaggleOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(off|false|0|no)$/i.test((env.KAGGLE_VOICE ?? "").trim());

export interface NarrationOptions extends VoiceboxOptions {
  /** whose cloned voice narrates (voiceProfiles.ts); CodeOrCap's when absent */
  channelKey?: string;
}

export async function generateNarration(opts: NarrationOptions): Promise<{ dir: string; files: number }> {
  if (voiceEngine() === "voicebox") return generateVoiceboxNarration(opts);
  // re-attaching to a fallback run that was already going on GitHub
  if (opts.resume) return generateVoiceboxNarration({ ...opts, workflow: OMNIVOICE_WORKFLOW });

  const started = Date.now();
  const lines = await tagEmotions(opts.lines);
  const job = buildOmniVoiceJob(opts.slug, lines, { channelKey: opts.channelKey, language: opts.language, speed: opts.speed });
  const budget = opts.giveUpMs ?? 3 * 60 * 60 * 1000;

  if (kaggleOn()) {
    try {
      return await runOnKaggle({
        slug: opts.slug,
        job,
        lines,
        onProgress: opts.onProgress,
        isCancelled: opts.isCancelled,
        giveUpMs: Math.min(budget, (Number(process.env.KAGGLE_VOICE_TIMEOUT_MIN) || 45) * 60_000),
      });
    } catch (err) {
      if (opts.isCancelled?.()) throw err;
      logger.warn(`[omnivoice] Kaggle failed (${err instanceof Error ? err.message.slice(0, 200) : err}) -> GitHub Actions fallback`, "OmniVoice");
    }
  }

  return generateVoiceboxNarration({
    ...opts,
    lines,
    emotionsTagged: true,
    workflow: OMNIVOICE_WORKFLOW,
    inputs: { ...(opts.inputs ?? {}), characters: JSON.stringify(job.characters), ...(job.narrator ? { narrator: job.narrator } : {}) },
    giveUpMs: Math.max(10 * 60_000, budget - (Date.now() - started)),
  });
}
