import sharp from "sharp";
import { FreeLlmApiClient } from "../ai/freellmapi";
import { pipelineLogger } from "../utils/logger";

/** Result of a list-card visual QA check. */
export interface CardQaResult {
  /** true = card looks fine, false = problem detected → re-render or abort */
  ok: boolean;
  /** short human-readable verdict e.g. "text overlap in row 3" */
  reason: string;
  /** did the AI model actually respond? (false = timed-out / not available → treat as ok) */
  checked: boolean;
}

const PROMPT = `You are a visual QA inspector for short-form social media cards.
Look at this 1080×1920 list card image and answer ONLY with a JSON object — no markdown, no explanation.

Check for ALL of these problems:
1. text_overlap   — any label, value or title text that overlaps with another text element
2. text_cutoff    — any text that is cut off at the card's edge or clipped by a rounded rect
3. icon_overlap   — any row icon that overlaps label or value text
4. illegible_text — any text that is too small to read (< ~30px visually) or nearly invisible (same colour as background)
5. title_cutoff   — the card title is missing or partially outside the frame

JSON schema (all fields required):
{
  "ok": boolean,          // true when the card has NONE of the above problems
  "problems": string[],   // list of problem keys found (empty array when ok=true)
  "reason": string        // one-line human description, e.g. "text_overlap: row 2 label runs into value"; "" when ok=true
}

Be strict: a single character clipped or two words touching counts as a problem.`;

/**
 * Sends the rendered card PNG to the FreeLLM API vision model and checks for
 * layout problems (text overlap, cutoff, illegible text, etc.).
 *
 * Returns `{ ok: true, checked: false }` on any error or timeout so a single
 * unavailable model never blocks the publish pipeline.
 */
export async function checkCardQa(
  cardPng: string,
  freellmapi: FreeLlmApiClient,
): Promise<CardQaResult> {
  try {
    // Downscale to 540×960 — enough for the vision model, half the bandwidth
    const buffer = await sharp(cardPng)
      .resize(540, 960, { fit: "inside" })
      .jpeg({ quality: 80 })
      .toBuffer();

    const base64 = buffer.toString("base64");

    let raw = "";
    try {
      raw = await freellmapi.generateVision(PROMPT, base64, "image/jpeg");
    } catch (visionErr: any) {
      pipelineLogger.warn(
        `CardQA: vision call failed (${String(visionErr?.message ?? visionErr).slice(0, 200)}); skipping QA`,
        "CardQA",
      );
      return { ok: true, reason: "vision unavailable", checked: false };
    }

    // Extract JSON from the response (the model may wrap it in markdown)
    const jsonMatch = /\{[\s\S]*\}/.exec(raw ?? "");
    if (!jsonMatch) {
      pipelineLogger.warn(`CardQA: could not parse model response; skipping QA. raw="${raw.slice(0, 200)}"`, "CardQA");
      return { ok: true, reason: "unparseable response", checked: false };
    }

    let parsed: { ok: boolean; problems: string[]; reason: string };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      pipelineLogger.warn(`CardQA: JSON.parse failed; skipping QA. raw="${raw.slice(0, 200)}"`, "CardQA");
      return { ok: true, reason: "unparseable response", checked: false };
    }

    const ok = parsed.ok === true;
    const reason = String(parsed.reason ?? parsed.problems?.join(", ") ?? "").slice(0, 300);

    if (ok) {
      pipelineLogger.info("CardQA: card passed visual inspection ✓", "CardQA");
    } else {
      pipelineLogger.warn(`CardQA: card FAILED — ${reason}`, "CardQA");
    }

    return { ok, reason, checked: true };
  } catch (err: any) {
    pipelineLogger.warn(
      `CardQA: unexpected error (${String(err?.message ?? err).slice(0, 200)}); skipping QA`,
      "CardQA",
    );
    return { ok: true, reason: "unexpected error", checked: false };
  }
}
