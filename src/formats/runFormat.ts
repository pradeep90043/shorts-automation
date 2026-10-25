import path from "path";
import { pipelineLogger } from "../utils/logger";
import { parseImageVoice, renderImageVoice } from "./imageVoice";
import { listCardFromLines, listCardPrompt, parseListCard, pickMusicBed, renderListCardPng, renderStillReel, type ListCardContent } from "./listCard";
import { imageVoicePrompt } from "./imageVoice";

export type BuiltFormat = "image_music" | "image_voice" | "manual";

export interface FormatRequest {
  format: BuiltFormat;
  brandKey: string;
  /** stable per reel (the shortcode): the same reel always gets the same music bed */
  seed: string;
  /** the source reel's words: transcript, caption, on-screen text, AI description */
  material: string;
  /** on-screen text of a static list card, used only when the LLM cannot structure the material */
  ocrText?: string;
  title?: string;
  hindi: boolean;
  llm: (prompt: string) => Promise<string>;
  tts: (text: string, file: string) => Promise<number>;
  tempDir: string;
  footer?: string;
  /** seconds a static card is shown */
  cardSeconds?: number;
  /** tests: no AI pictures */
  noAi?: boolean;
}

export interface FormatResult {
  format: BuiltFormat;
  videoPath: string;
  cardPng?: string;
  title: string;
}

/** The free models often answer with their thinking or a few words: ask up to `tries` times until `parse` accepts the answer. */
export async function askUntil<T>(llm: (p: string) => Promise<string>, prompt: string, parse: (raw: string) => T | null, tries = 3): Promise<T | null> {
  for (let i = 1; i <= tries; i++) {
    try {
      const out = parse(await llm(prompt));
      if (out) return out;
      pipelineLogger.warn(`Format: answer ${i}/${tries} unusable`, "Formats");
    } catch (e) {
      pipelineLogger.warn(`Format: attempt ${i}/${tries} failed (${String((e as Error)?.message ?? e).slice(0, 100)})`, "Formats");
    }
  }
  return null;
}

/** Builds the Short for a format. Throws when it cannot, so the caller can fall back to the channel's normal Short. */
export async function buildFormatShort(r: FormatRequest): Promise<FormatResult> {
  const material = r.material.replace(/\s+/g, " ").trim();
  if (material.length < 20 && !(r.ocrText && r.ocrText.length >= 20)) throw new Error("not enough source text for the format");

  if (r.format === "image_voice") {
    const plan = await askUntil(r.llm, imageVoicePrompt(material, r.hindi), parseImageVoice);
    if (!plan) throw new Error("could not plan the image+voice scenes");
    const out = path.join(r.tempDir, "format_image_voice.mp4");
    await renderImageVoice(plan, { brandKey: r.brandKey, tempDir: path.join(r.tempDir, "iv"), tts: r.tts, bed: pickMusicBed(r.seed), out, footer: r.footer, noAi: r.noAi });
    return { format: "image_voice", videoPath: out, title: plan.title };
  }

  // image_music and manual both start from the same list card
  let card: ListCardContent | null = await askUntil(r.llm, listCardPrompt(material, r.hindi), parseListCard);
  if (!card && r.ocrText) card = listCardFromLines(r.ocrText, r.title ?? "");
  if (!card) throw new Error("could not structure the source text into a list card");
  const png = await renderListCardPng(card, r.brandKey, path.join(r.tempDir, "format_card.png"), { footer: r.footer, background: r.noAi ? null : undefined });
  const out = path.join(r.tempDir, "format_image_music.mp4");
  await renderStillReel(png, pickMusicBed(r.seed), out, r.cardSeconds ?? 6);
  return { format: r.format, videoPath: out, cardPng: png, title: card.title };
}
