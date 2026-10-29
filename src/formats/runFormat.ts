import path from "path";
import { pipelineLogger } from "../utils/logger";
import { parseImageVoice, renderImageVoice } from "./imageVoice";
import { listCardFromLines, listCardPrompt, parseListCard, pickMusicBed, renderListCardPng, renderStillReel, type ListCardContent } from "./listCard";
import { imageVoicePrompt } from "./imageVoice";
import { checkCardQa } from "./cardQa";
import { FreeLlmApiClient } from "../ai/freellmapi";

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
  /**
   * FreeLLM API client used for card visual QA.
   * When provided, the rendered PNG is sent to the vision model after rendering;
   * if problems are detected the card is rebuilt once (different LLM draw) before giving up.
   * When absent the QA step is skipped silently.
   */
  freellmapi?: FreeLlmApiClient;
}

export interface FormatResult {
  format: BuiltFormat;
  videoPath: string;
  cardPng?: string;
  title: string;
  /** populated when visual QA ran: true = passed, false = failed (video still returned, caller decides) */
  qaOk?: boolean;
  qaReason?: string;
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

/**
 * Renders a list card PNG and runs visual QA on it (when `freellmapi` is provided).
 * On a QA failure the card is re-asked from the LLM (one retry) before giving up and
 * returning the best available PNG + the QA verdict for the caller to decide.
 */
async function renderAndQaCard(
  card: ListCardContent,
  r: FormatRequest,
  pngPath: string,
): Promise<{ png: string; qaOk: boolean; qaReason: string }> {
  const png = await renderListCardPng(card, r.brandKey, pngPath, {
    footer: r.footer,
    background: r.noAi ? null : undefined,
  });

  if (!r.freellmapi) return { png, qaOk: true, qaReason: "" };

  const qa = await checkCardQa(png, r.freellmapi);
  if (!qa.checked || qa.ok) return { png, qaOk: true, qaReason: qa.reason };

  // QA failed — ask the LLM for a fresh card layout and re-render once
  pipelineLogger.warn(
    `CardQA failed (${qa.reason}); requesting a new card layout from the LLM`,
    "Formats",
  );
  const fresh = await askUntil(r.llm, listCardPrompt(r.material.replace(/\s+/g, " ").trim(), r.hindi), parseListCard, 2);
  if (!fresh) {
    pipelineLogger.error(`CardQA re-ask produced no usable card (${qa.reason}) — rejecting list card format`, "Formats");
    throw new Error(`List card failed visual QA: ${qa.reason}`);
  }

  const pngRetry = pngPath.replace(/\.png$/, "_retry.png");
  const png2 = await renderListCardPng(fresh, r.brandKey, pngRetry, {
    footer: r.footer,
    background: r.noAi ? null : undefined,
  });
  const qa2 = await checkCardQa(png2, r.freellmapi);
  if (qa2.ok || !qa2.checked) {
    pipelineLogger.info("CardQA retry passed ✓", "Formats");
    return { png: png2, qaOk: true, qaReason: "" };
  }
  pipelineLogger.error(`CardQA retry still failed (${qa2.reason}) — rejecting list card format`, "Formats");
  throw new Error(`List card failed visual QA after retry: ${qa2.reason}`);
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

  const { png, qaOk, qaReason } = await renderAndQaCard(
    card,
    r,
    path.join(r.tempDir, "format_card.png"),
  );

  const out = path.join(r.tempDir, "format_image_music.mp4");
  await renderStillReel(png, pickMusicBed(r.seed), out, r.cardSeconds ?? 6);
  return { format: r.format, videoPath: out, cardPng: png, title: card.title, qaOk, qaReason };
}
