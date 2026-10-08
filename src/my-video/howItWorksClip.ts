import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { pipelineLogger } from "../utils/logger";
import { cancelCloudRun, renderStickmanVideo, resolveMyVideoDir, type CloudRunRef, type StickmanScene, type StickmanVideoSpec } from "./myVideoService";
import { isStickmanBusy } from "./stickmanJobs";
import { cleanScript, sanitizeVisual, splitScriptIntoBeats } from "./stickmanPlanner";

/**
 * The "Let us check how is it working" clip of a CodeOrCap V2 short, made with my-video (a vertical dark stickman
 * explainer with an animated flow diagram). Built from the short's own metadata with plain code - no LLM - so it
 * cannot fail on a degraded AI provider. Any failure just returns false and the caller falls back to Pexels b-roll.
 */

export interface HowItWorksInput {
  explanation: string;
  /** Mermaid flowchart that came with the short's metadata (labels become the diagram nodes) */
  mermaid?: string;
  diagramTitle?: string;
}

const INTRO = "Let us check how is it working.";
const MAX_BODY_BEATS = 5;
const MAX_NODE_CHARS = 24;
const POSES = ["present", "think", "point", "smug", "present"];

const stripEmoji = (s: string): string => s.replace(/[\p{Extended_Pictographic}️‍]/gu, "");

/** Labels of a Mermaid flowchart in order (`A["📥 1. Receive Input"] --> B[Run]`), cleaned for the "flow" panel. */
export function mermaidNodes(mermaid: string | undefined): string[] {
  if (!mermaid) return [];
  const labels: string[] = [];
  const re = /\b[A-Za-z]\w*\s*(?:\["([^"]*)"\]|\[([^\]]*)\]|\(\(?([^)]*)\)?\)|\{([^}]*)\})/g;
  for (const m of mermaid.matchAll(re)) {
    let label = stripEmoji(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/^\s*\d+[.)]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (label.includes(":") && label.split(":")[0].trim().length >= 3) label = label.split(":")[0].trim(); // "Receive Input: <title>" -> "Receive Input"
    label = label.slice(0, MAX_NODE_CHARS).trim();
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.length > 5 ? [...labels.slice(0, 4), labels[labels.length - 1]] : labels;
}

/** Narration beats: the explanation without list numbers, at most MAX_BODY_BEATS (extra text joins the last one). */
export function explanationBeats(explanation: string): string[] {
  const text = cleanScript(explanation.replace(/(^|\s)\d+[.)]\s+/g, "$1").replace(/…/g, ".")).replace(/\s+/g, " ").trim();
  // one beat per sentence (the diagram advances with each); only a long sentence is cut further
  const beats = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 2)
    .flatMap((s) => (s.split(/\s+/).length > 16 ? splitScriptIntoBeats(s) : [s]));
  if (beats.length <= MAX_BODY_BEATS) return beats;
  return [...beats.slice(0, MAX_BODY_BEATS - 1), beats.slice(MAX_BODY_BEATS - 1).join(" ")];
}

/** The my-video project for the clip: vertical, dark theme, gold accent, English male voice like the rest of CodeOrCap. */
export function buildHowItWorksSpec(input: HowItWorksInput, slug: string): StickmanVideoSpec {
  const nodes = mermaidNodes(input.mermaid);
  const hasFlow = nodes.length >= 2;
  const heading = (input.diagramTitle || "How it works").trim().slice(0, 40);
  const beats = explanationBeats(input.explanation);

  const raw: { text: string; visual: Record<string, unknown> }[] = [
    { text: INTRO, visual: { pose: "point", mood: "excited", accent: "gold", camera: "push", setting: "stage", title: "HOW IT WORKS" } },
  ];
  beats.forEach((text, k) => {
    const visual: Record<string, unknown> = { pose: POSES[k % POSES.length], mood: k % 2 ? "neutral" : "happy", accent: "gold", camera: "none", setting: "server", title: heading };
    if (hasFlow) {
      // the packet travels along the diagram as the narration moves on
      const active = beats.length > 1 ? Math.round((k * (nodes.length - 1)) / (beats.length - 1)) : 0;
      visual.flow = { nodes, active };
    } else {
      visual.props = [{ type: k % 2 ? "gear" : "code" }];
      visual.callouts = [text.split(/\s+/).slice(0, 4).join(" ").toUpperCase()];
    }
    raw.push({ text, visual });
  });

  const scenes: StickmanScene[] = raw.map((s, i) => ({
    id: `s${String(i + 1).padStart(2, "0")}`,
    text: s.text,
    visual: sanitizeVisual(s.visual, i),
  }));

  return {
    slug,
    title: heading,
    scenes,
    orientation: "vertical",
    resolution: 1080,
    theme: "dark",
    voice: "en-IN-PrabhatNeural",
    language: "en",
    rate: "+0%",
    noBranding: true, // the short already carries CodeOrCap's own branding; my-video's logo would sit mid-video
  };
}

const off = (v: string | undefined): boolean => /^(off|false|0|no)$/i.test((v ?? "").trim());

/**
 * Only used when it can work without hurting the server: not switched off, and a cloud render is possible
 * (a local Remotion render would swamp the small VM).
 */
export function howItWorksMyVideoEnabled(): boolean {
  if (off(process.env.HOWITWORKS_MYVIDEO)) return false;
  return Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN) || process.env.RENDER_LOCAL === "true";
}

/**
 * Renders the clip to `outPath`. Returns false (never throws) when it is disabled, the renderer is busy with a long
 * video, the render fails, or it takes longer than the timeout - the caller then uses its Pexels fallback.
 */
export async function renderHowItWorksClip(input: HowItWorksInput, outPath: string): Promise<boolean> {
  const log = (msg: string) => pipelineLogger.info(msg, "HowItWorksClip");
  if (!howItWorksMyVideoEnabled()) { log("my-video clip skipped (disabled or no cloud renderer) -> Pexels"); return false; }
  if (!input.explanation?.trim()) return false;
  if (isStickmanBusy()) { log("my-video is busy with a long video -> Pexels"); return false; }
  try { resolveMyVideoDir(); } catch { log("my-video is not installed here -> Pexels"); return false; }

  const timeoutMs = (Number(process.env.HOWITWORKS_MYVIDEO_TIMEOUT_MIN) || 10) * 60_000;
  const spec = buildHowItWorksSpec(input, `hiw-${randomUUID().slice(0, 8)}`);
  let givenUp = false;
  let cloudRun: CloudRunRef | undefined;
  const stop = () => { if (cloudRun) void cancelCloudRun(cloudRun); };
  let timer: NodeJS.Timeout | undefined;
  try {
    log(`Rendering ${spec.scenes.length}-scene clip with my-video (timeout ${Math.round(timeoutMs / 60000)} min)`);
    const result = await Promise.race([
      renderStickmanVideo(
        spec,
        (p) => { if (p.cloudRun) { cloudRun = p.cloudRun; if (givenUp) stop(); } },
        () => givenUp, // still queued behind another render when we gave up: never start it
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { givenUp = true; stop(); reject(new Error(`timed out after ${Math.round(timeoutMs / 60000)} min`)); }, timeoutMs);
      }),
    ]);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await fs.promises.copyFile(result.videoPath, outPath);
    fs.rmSync(result.videoPath, { force: true });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) throw new Error("rendered file is empty");
    log("✓ my-video clip ready");
    return true;
  } catch (err) {
    givenUp = true;
    stop();
    pipelineLogger.warn(`my-video how-it-works clip failed (${err instanceof Error ? err.message : err}) -> Pexels`, "HowItWorksClip");
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
