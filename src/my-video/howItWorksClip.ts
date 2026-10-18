import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { pipelineLogger } from "../utils/logger";
import { cancelCloudRun, renderStickmanVideo, resolveMyVideoDir, type CloudRunRef, type StickmanScene, type StickmanVideoSpec } from "./myVideoService";
import { isStickmanBusy } from "./stickmanJobs";
import { sceneForSentence } from "./sceneComposer";
import { cleanScript, directBeats, diversifyVisuals, dropInventedNumbers, isThin, sanitizeVisual, splitScriptIntoBeats } from "./stickmanPlanner";

/**
 * The "Let us check how is it working" clip of a CodeOrCap V2 short, made with my-video (a vertical dark stickman
 * explainer). Every sentence of the short's own explanation becomes a scene whose visual follows what that sentence
 * says: the LLM director picks a matching panel/props/setting (one short call, capped), and when it is slow or fails the
 * visuals are derived from the sentences themselves - never a generic placeholder diagram. Any failure of the whole
 * clip returns false and the caller falls back to Pexels b-roll.
 */

export interface HowItWorksInput {
  explanation: string;
  /**
   * Ready-made narration (the cloned voice), one mp3 per scene in order: the intro line, then one per sentence
   * (see howItWorksLines). Used only when there is exactly one existing file per scene; otherwise the clip speaks with its own voice.
   */
  narrationFiles?: string[];
  /** the short's title, as context for the visual director */
  title?: string;
  /** Mermaid flowchart from the short's own metadata (labels become the diagram nodes) - NOT a generated placeholder */
  mermaid?: string;
  diagramTitle?: string;
  /** spoken first line (defaults to CodeOrCap's "Let us check how is it working.") */
  intro?: string;
  /** on-screen title of the first scene (defaults to "HOW IT WORKS") */
  title2?: string;
  /** "hi" = Hindi channel: the director writes every title / label / callout in Hindi (Devanagari) */
  language?: string;
}

const INTRO = "Let us check how is it working.";
const MAX_BODY_BEATS = 5;
const MAX_NODE_CHARS = 24;
const POSES = ["present", "think", "point", "smug", "present"];

const stripEmoji = (s: string): string => s.replace(/[\p{Extended_Pictographic}️‍]/gu, "");

/** Labels of a Mermaid flowchart (`graph` or `flowchart`) in order, cleaned for the "flow" panel. */
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

/** The lines the clip narrates, in scene order: the intro, then one per sentence of the explanation. */
export const howItWorksLines = (explanation: string, intro: string = INTRO): string[] => [intro, ...explanationBeats(explanation)];

/** Narration beats: one per sentence of the explanation (list numbers removed), at most MAX_BODY_BEATS. */
export function explanationBeats(explanation: string): string[] {
  const text = cleanScript(explanation.replace(/(^|\s)\d+[.)]\s+/g, "$1").replace(/…/g, ".")).replace(/\s+/g, " ").trim();
  // one beat per sentence (the visuals advance with each); only a long sentence is cut further
  const beats = text.split(/(?<=[.!?।])\s+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 2)
    .flatMap((s) => (s.split(/\s+/).length > 16 ? splitScriptIntoBeats(s) : [s]));
  if (beats.length <= MAX_BODY_BEATS) return beats;
  return [...beats.slice(0, MAX_BODY_BEATS - 1), beats.slice(MAX_BODY_BEATS - 1).join(" ")];
}

const STOP = new Set(("the a an and or but of to in on for with from by at as is are was were be been being this that these those it its their " +
  "his her our your you we they then than so if when while which who what how why can could will would should may might also just very more " +
  "most much many some any each every into over under about after before during between through across per via using use uses used has have had " +
  "does do did not no").split(" "));

/** A 1-3 word topic label for a sentence ("Water absorbs thermal energy from the chips" -> "Water Absorbs Thermal"). */
export function keyPhrase(sentence: string): string {
  const words = sentence.replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
  const content = words.filter((w) => !STOP.has(w.toLowerCase()));
  const picked = (content.length ? content : words).slice(0, 3);
  const title = (ws: string[]) => ws.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  while (picked.length > 1 && title(picked).length > MAX_NODE_CHARS) picked.pop();
  return title(picked).slice(0, MAX_NODE_CHARS).trim();
}

/** Backdrop that fits what the sentence is about. */
const SETTING_RULES: [RegExp, string][] = [
  [/\b(data ?cent(er|re)s?|servers?|database|backend|api|infrastructure|hardware|chips?|gpus?|cooling)\b/i, "server"],
  [/\b(cloud|deploy\w*|network|devops|kubernetes|docker)\b/i, "cloud"],
  [/\b(jobs?|careers?|developers?|engineers?|teams?|interviews?|salary|hiring)\b/i, "office"],
  [/\b(world|global\w*|countr(y|ies)|industry|market|cities|city|society|worldwide)\b/i, "city"],
  [/\b(learn\w*|concepts?|tutorials?|basics|teach\w*|understand\w*)\b/i, "classroom"],
  [/\b(future|space|ai|models?|intelligen\w*|robots?)\b/i, "space"],
];
export const settingFor = (text: string, fallback = "server"): string => SETTING_RULES.find(([re]) => re.test(text))?.[1] ?? fallback;

/** Props that fit the sentence (0-2). */
const PROP_RULES: [RegExp, string][] = [
  [/\b(cost|costs|money|price|pay|paid|billion|million|dollars?|\$)\b/i, "money"],
  [/\b(grow\w*|increas\w*|rise|rises|rising|more|massive|surge|boost\w*|higher|demand)\b/i, "chartUp"],
  [/\b(drop\w*|decreas\w*|reduc\w*|less|lower|save[sd]?|cut)\b/i, "chartDown"],
  [/\b(risk\w*|warning|danger\w*|problem\w*|overheat\w*|crash\w*)\b/i, "warning"],
  [/\b(secur\w*|lock\w*|private|encrypt\w*|protect\w*)\b/i, "lock"],
  [/\b(bug|bugs|error|errors|fail\w*|broken)\b/i, "bug"],
  [/\b(code|function|script|program\w*)\b/i, "code"],
  [/\b(ai|models?|robots?|llm|gpt|chatgpt|automat\w*)\b/i, "robot"],
  [/\b(time|hours?|months?|years?|daily|every|speed\w*|fast\w*|seconds?|minutes?)\b/i, "clock"],
  [/\b(launch\w*|start\w*|rocket)\b/i, "rocket"],
  [/\b(check\w*|true|correct|verif\w*)\b/i, "check"],
  [/\b(analy\w*|search\w*|inspect\w*|find\w*|detect\w*)\b/i, "magnifier"],
  [/\b(idea|insight|why|because|reason)\b/i, "bulb"],
];
export const propsFor = (text: string): { type: string }[] =>
  PROP_RULES.filter(([re]) => re.test(text)).slice(0, 2).map(([, type]) => ({ type }));

/** The visual for one sentence when the director gave nothing usable: derived from the sentence itself. */
function visualFromSentence(text: string, k: number, count: number, nodes: string[], heading: string): Record<string, unknown> {
  const visual: Record<string, unknown> = {
    pose: POSES[k % POSES.length], mood: k % 2 ? "neutral" : "happy", accent: "gold", camera: k === 0 ? "push" : "none",
    setting: settingFor(text), title: heading,
  };
  const illustration = off(process.env.HOWITWORKS_SCENES) ? null : sceneForSentence(text, heading);
  if (illustration) {
    // hand-drawn illustration of the things the sentence talks about (server -> water drop ...), one per sentence
    visual.scene = illustration;
  } else if (nodes.length >= 2) {
    // the packet travels along the diagram as the narration moves on
    const active = count > 1 ? Math.round((k * (nodes.length - 1)) / (count - 1)) : 0;
    visual.flow = { nodes, active };
  } else {
    visual.props = propsFor(text).length ? propsFor(text) : [{ type: k % 2 ? "gear" : "code" }];
    visual.callouts = [text.split(/\s+/).slice(0, 4).join(" ").toUpperCase()];
  }
  return visual;
}

/**
 * The my-video project for the clip: vertical, dark theme, gold accent, English male voice like the rest of CodeOrCap.
 * `directed` = per-sentence visuals from the LLM director (by body-beat index); sentences it missed or left bare are
 * derived from the sentence itself.
 */
export function buildHowItWorksSpec(input: HowItWorksInput, slug: string, directed?: Map<number, any>): StickmanVideoSpec {
  const heading = (input.diagramTitle || "How it works").trim().slice(0, 40);
  const beats = explanationBeats(input.explanation);
  let nodes = mermaidNodes(input.mermaid);
  if (nodes.length < 2 && beats.length >= 2) {
    // no usable diagram from the metadata: the topic of each sentence IS the diagram (never a generic placeholder)
    nodes = [...new Set(beats.map(keyPhrase).filter((l) => l.length >= 3))].slice(0, 5);
    if (nodes.length < 2) nodes = [];
  }

  const raw: { text: string; visual: Record<string, unknown> }[] = [
    { text: input.intro ?? INTRO, visual: { pose: "point", mood: "excited", accent: "gold", camera: "push", setting: "stage", title: input.title2 ?? "HOW IT WORKS", callouts: heading && heading !== "How it works" ? [heading.toUpperCase()] : undefined } },
  ];
  beats.forEach((text, k) => {
    const fromLlm = directed?.get(k);
    const visual = fromLlm && !isThin(fromLlm) ? { ...fromLlm, accent: fromLlm.accent ?? "gold" } : visualFromSentence(text, k, beats.length, nodes, heading);
    raw.push({ text, visual });
  });

  const scenes: StickmanScene[] = raw.map((s, i) => ({
    id: `s${String(i + 1).padStart(2, "0")}`,
    text: s.text,
    visual: sanitizeVisual(s.visual, i),
  }));
  diversifyVisuals(scenes);
  dropInventedNumbers(scenes, beats.join(" ")); // a chart/counter may only show figures the narration states

  return {
    slug,
    title: heading,
    scenes,
    orientation: "vertical",
    resolution: 1080,
    theme: "dark",
    voice: input.language === "hi" ? "hi-IN-MadhurNeural" : "en-IN-PrabhatNeural",
    language: input.language === "hi" ? "hi" : "en",
    rate: "+0%",
    noBranding: true, // the short already carries CodeOrCap's own branding; my-video's logo would sit mid-video
  };
}

const off = (v: string | undefined): boolean => /^(off|false|0|no)$/i.test((v ?? "").trim());

/**
 * One short, time-capped LLM call: a visual for each sentence that matches what it says. Returns undefined when the
 * LLM is switched off (HOWITWORKS_LLM=off), slow or wrong - the caller then derives visuals from the sentences.
 */
export async function directHowItWorks(input: HowItWorksInput): Promise<Map<number, any> | undefined> {
  if (off(process.env.HOWITWORKS_LLM)) return undefined;
  const beats = explanationBeats(input.explanation);
  if (!beats.length) return undefined;
  const diagram = mermaidNodes(input.mermaid);
  const hint =
    `This is a ~20 second vertical "how it works" explainer clip inside a short${input.title ? ` titled "${input.title}"` : ""}. ` +
    `Make each beat's visual show what THAT sentence says (a panel that matches it - flow, steps, compare, counter, chart, table, code, terminal, alert - or a fitting prop and setting), ` +
    `never the same generic boxes for every beat.${diagram.length >= 2 ? ` The author's diagram idea: ${diagram.join(" -> ")}.` : ""} ` +
    `Never invent a number, percentage, rate or name: a chart, counter or card may only show figures that appear in the beats above.` +
    (input.language === "hi" ? ` Write every on-screen title, label, tag and callout in Hindi (Devanagari script), short, never in English.` : "");
  const capMs = (Number(process.env.HOWITWORKS_LLM_TIMEOUT_SEC) || 60) * 1000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const res = await Promise.race([
      directBeats(beats, beats.map((_, i) => i), beats.length, { beatScene: beats.map(() => 0), notes: [hint] }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), capMs); }),
    ]);
    if (!res || !res.byIndex.size) { pipelineLogger.info("visual director gave nothing in time -> visuals derived from the sentences", "HowItWorksClip"); return undefined; }
    pipelineLogger.info(`visual director directed ${res.byIndex.size}/${beats.length} sentences`, "HowItWorksClip");
    return res.byIndex;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  const directed = await directHowItWorks(input);
  const spec = buildHowItWorksSpec(input, `hiw-${randomUUID().slice(0, 8)}`, directed);
  // ready-made narration: my-video measures these files instead of synthesising, so every scene lasts as long as its line
  let narrationTmp: string | undefined;
  const supplied = input.narrationFiles;
  if (supplied && supplied.length === spec.scenes.length && supplied.every((f) => f && fs.existsSync(f))) {
    narrationTmp = fs.mkdtempSync(path.join(os.tmpdir(), "hiw-voice-"));
    spec.scenes.forEach((sc, i) => fs.copyFileSync(supplied[i], path.join(narrationTmp!, `segment_${i}_${sc.id}.mp3`)));
    spec.narrationDir = narrationTmp;
    log(`using the supplied cloned-voice narration for ${spec.scenes.length} scenes`);
  } else if (supplied?.length) {
    log(`supplied narration does not match the clip's ${spec.scenes.length} scenes (${supplied.length} files) -> its own voice`);
  }
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
    if (narrationTmp) fs.rmSync(narrationTmp, { recursive: true, force: true });
  }
}
