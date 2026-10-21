import { pipelineLogger } from "../utils/logger";
import { parseAiJson } from "../utils/json";
import { askLlm, cleanScript, splitScriptIntoBeats, type StickmanPlan } from "./stickmanPlanner";

/**
 * Storyboard planner (Storiyum): instead of one stickman explaining, a story has a CAST (people who look different) and every beat is
 * staged as a scene: a background that fits the story, who is in it, where they stand, how they feel. The AI writes the cast and the
 * staging; whatever it leaves out or gets wrong is filled by rules, so a story always has a plan.
 * The enumerations mirror my-video/src/stickman/story/cast.ts.
 */
export const STORY_BGS = ["village", "forest", "home", "room_night", "school", "street", "market", "palace", "temple", "hospital", "river", "road", "office", "farm", "mountain", "beach"];
const TIMES = ["day", "dusk", "night"];
const POSES = ["stand", "talk", "point", "wave", "sad", "happy", "angry", "scared", "walk", "think", "bow"];
const MOODS = ["neutral", "happy", "sad", "angry", "scared", "surprised", "laugh", "worried"];
const HAIRS = ["short", "side", "long", "bun", "ponytail", "bald", "curly", "turban", "cap"];
const OUTFITS = ["shirt", "kurta", "saree", "dress", "uniform", "suit", "hoodie", "dhoti"];
const AGES = ["child", "teen", "adult", "elder"];
const SKINS = ["#F3C9A0", "#E7B07F", "#D39A68", "#B9794A", "#8D5A3B"];
const COLORS = ["#2E86DE", "#E84393", "#F39C12", "#16A085", "#8E44AD", "#C0392B", "#27AE60", "#2C3E50"];

export interface StoryMember {
  id: string; name?: string; age: string; skin: string; hair: string; hairColor: string; outfit: string; color: string; color2?: string;
  glasses?: boolean; beard?: boolean; bindi?: boolean;
}
const pick = (list: readonly string[], v: unknown, fallback: string): string => (typeof v === "string" && list.includes(v) ? v : fallback);
const hex = (v: unknown, fallback: string): string => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback);

/** Background by what the beat talks about (Hindi and English words); the previous background is kept when nothing matches. */
const BG_WORDS: [string, RegExp][] = [
  ["school", /स्कूल|कक्षा|टीचर|शिक्षक|परीक्षा|school|class|teacher|exam/i],
  ["hospital", /अस्पताल|डॉक्टर|बीमार|दवा|hospital|doctor|sick/i],
  ["market", /बाज़ार|बाजार|दुकान|मंडी|खरीद|market|shop/i],
  ["palace", /राजा|रानी|महल|दरबार|राजकुमार|king|queen|palace/i],
  ["temple", /मंदिर|पूजा|भगवान|आरती|temple|prayer/i],
  ["forest", /जंगल|शेर|पेड़|forest|jungle/i],
  ["river", /नदी|नाव|तालाब|पुल|river|boat|lake/i],
  ["farm", /खेत|किसान|फसल|बैल|farm|farmer|crop/i],
  ["mountain", /पहाड़|बर्फ|चोटी|mountain|snow/i],
  ["beach", /समुद्र|समंदर|किनारा|beach|sea|ocean/i],
  ["office", /ऑफिस|दफ्तर|बॉस|नौकरी|कंपनी|office|boss|job/i],
  ["road", /सड़क|रास्ता|सफर|गाड़ी|बस |road|journey|drive/i],
  ["street", /शहर|गली|मोहल्ला|सड़क पर|city|street/i],
  ["room_night", /रात|नींद|सपना|सोया|सो गया|night|dream|sleep/i],
  ["home", /घर|माँ|पापा|दादी|दादा|रसोई|home|house|mother|father/i],
  ["village", /गाँव|गांव|village/i],
];
const TIME_WORDS: [string, RegExp][] = [["night", /रात|अंधेरा|चाँद|night|dark/i], ["dusk", /शाम|सूरज ढल|dusk|evening|sunset/i], ["day", /सुबह|दिन|धूप|morning|day|noon/i]];
const MOOD_WORDS: [string, RegExp][] = [
  ["sad", /रो|आँसू|दुख|उदास|अकेला|sad|cry|alone/i], ["scared", /डर|भूत|खतरा|चीख|scared|afraid|danger/i], ["angry", /गुस्सा|नाराज़|चिल्ला|angry|shout/i],
  ["surprised", /अचानक|हैरान|चौंक|surprise|suddenly|shock/i], ["laugh", /हँस|ठहाके|मज़ाक|laugh|joke/i], ["happy", /खुश|ख़ुशी|तालियाँ|जीत|happy|win|joy|celebrate/i],
  ["worried", /चिंता|परेशान|सोच|worried|tension|problem/i],
];
const firstMatch = (list: [string, RegExp][], text: string): string | undefined => list.find(([, re]) => re.test(text))?.[0];

/** A cast when the AI gave none: two people who look different from each other (and from the CodeOrCap stickman). */
function fallbackCast(): StoryMember[] {
  return [
    { id: "hero", name: "", age: "adult", skin: SKINS[2], hair: "short", hairColor: "#1B1B1B", outfit: "shirt", color: COLORS[0], color2: "#2D3436" },
    { id: "friend", name: "", age: "adult", skin: SKINS[1], hair: "long", hairColor: "#2B1A12", outfit: "kurta", color: COLORS[1], color2: "#2D3436", bindi: true },
  ];
}

export function sanitizeCast(raw: unknown): StoryMember[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: StoryMember[] = [];
  list.slice(0, 5).forEach((r: any, i) => {
    const id = String(r?.id ?? `c${i + 1}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || `c${i + 1}`;
    if (seen.has(id)) return;
    seen.add(id);
    const outfit = pick(OUTFITS, r?.outfit, "shirt");
    out.push({
      id, name: typeof r?.name === "string" ? r.name.slice(0, 14) : "", age: pick(AGES, r?.age, "adult"), skin: hex(r?.skin, SKINS[i % SKINS.length]),
      hair: pick(HAIRS, r?.hair, "short"), hairColor: hex(r?.hairColor, "#1B1B1B"), outfit, color: hex(r?.color, COLORS[i % COLORS.length]),
      color2: hex(r?.color2, outfit === "saree" ? "#F1C40F" : "#2D3436"), glasses: !!r?.glasses, beard: !!r?.beard, bindi: !!r?.bindi,
    });
  });
  return out.length ? out : fallbackCast();
}

export interface Staged {
  bg: string; time: string;
  chars: { id: string; x: number; pose: string; mood: string; flip: boolean; scale: number; delay: number; speaking: boolean }[];
}

/** One beat's scene from what the AI said (or nothing): everything is clamped to what my-video can draw. */
export function sanitizeStaging(raw: any, text: string, cast: StoryMember[], prev: Staged | undefined, index: number): Staged {
  const ids = new Set(cast.map((c) => c.id));
  const bg = pick(STORY_BGS, raw?.bg, firstMatch(BG_WORDS, text) ?? prev?.bg ?? "village");
  const time = pick(TIMES, raw?.time, firstMatch(TIME_WORDS, text) ?? prev?.time ?? "day");
  let chars = (Array.isArray(raw?.chars) ? raw.chars : []).filter((c: any) => ids.has(c?.id)).slice(0, 4);
  if (!chars.length) {
    // rule staging: the previous scene's people stay, otherwise the first one or two of the cast
    const mood = firstMatch(MOOD_WORDS, text) ?? "neutral";
    const who = prev?.chars.map((c) => c.id) ?? cast.slice(0, 2).map((c) => c.id);
    chars = who.map((id, k) => ({ id, x: who.length === 1 ? 50 : k === 0 ? 30 : 70, pose: k === 0 ? "talk" : "stand", mood, flip: k === 1, speaking: k === 0 }));
  }
  const n = chars.length;
  const staged = chars.map((c: any, k: number) => ({
    id: String(c.id),
    x: Math.max(8, Math.min(92, Number.isFinite(Number(c.x)) && c.x !== undefined ? Number(c.x) : n === 1 ? 50 : 18 + (64 * k) / (n - 1))),
    pose: pick(POSES, c.pose, "stand"),
    mood: pick(MOODS, c.mood, firstMatch(MOOD_WORDS, text) ?? "neutral"),
    flip: typeof c.flip === "boolean" ? c.flip : (Number(c.x) || 50) > 55,
    scale: Math.max(0.6, Math.min(1.3, Number(c.scale) || 1)),
    delay: (k + (index === 0 ? 1 : 0)) * 4,
    speaking: !!c.speaking,
  }));
  if (!staged.some((c: { speaking: boolean }) => c.speaking)) staged[0].speaking = true;
  return { bg, time, chars: staged };
}

const BATCH = 14;
const castPrompt = (beats: string[], title: string): string =>
  `You are the storyboard artist of a Hindi story video "${title}". Read the narration beats and design the CAST and the staging of every beat.\n` +
  `Return ONLY raw JSON: {"cast":[{"id":"short_latin_id","name":"Hindi first name","age":"${AGES.join("|")}","skin":"#hex","hair":"${HAIRS.join("|")}","hairColor":"#hex","outfit":"${OUTFITS.join("|")}","color":"#hex","color2":"#hex","glasses":false,"beard":false,"bindi":false}],` +
  `"scenes":[{"i":0,"bg":"${STORY_BGS.join("|")}","time":"${TIMES.join("|")}","chars":[{"id":"cast id","x":0-100,"pose":"${POSES.join("|")}","mood":"${MOODS.join("|")}","flip":false,"speaking":true}]}]}\n` +
  `Rules: 2 to 4 cast members, each clearly different (age, clothes, colours) and matching the story (a grandfather is an elder with a dhoti or kurta, a mother wears a saree, a student a uniform). ` +
  `One scene per beat, in order. The background must fit WHERE the beat happens and the time of day WHEN; change it when the place changes. ` +
  `Put only the people who are in that beat on stage (1-3), x = where they stand left (10) to right (90), the speaker or main person speaking:true, moods and poses that show the emotion of the beat. ` +
  `Do not think out loud: the first character of your answer is "{".\n/no_think\n\nBeats:\n${beats.map((b, i) => `${i}. ${b}`).join("\n")}`;
const stagePrompt = (beats: string[], from: number, cast: StoryMember[]): string =>
  `Stage these beats of a Hindi story. Cast: ${JSON.stringify(cast.map((c) => ({ id: c.id, name: c.name, age: c.age })))}.\n` +
  `Return ONLY raw JSON: {"scenes":[{"i":${from},"bg":"${STORY_BGS.join("|")}","time":"${TIMES.join("|")}","chars":[{"id":"cast id","x":0-100,"pose":"${POSES.join("|")}","mood":"${MOODS.join("|")}","flip":false,"speaking":true}]}]}\n` +
  `One scene per beat in order, i counts from ${from}. Background = where the beat happens; only people in the beat are on stage. No thinking out loud; start with "{".\n/no_think\n\n${beats.map((b, k) => `${from + k}. ${b}`).join("\n")}`;

/** The plan of a story video: scenes carry `visual.story`, the cast travels with the plan. */
export async function planStoryboard(script: string, titleHint?: string): Promise<StickmanPlan & { cast: StoryMember[] }> {
  const beats = splitScriptIntoBeats(cleanScript(script));
  if (!beats.length) throw new Error("Script is empty");
  const title = titleHint?.trim() || beats[0].slice(0, 80);

  let cast: StoryMember[] = [];
  const raws = new Map<number, any>();
  const take = (parsed: any, offset: number) => {
    const scenes = Array.isArray(parsed?.scenes) ? parsed.scenes : [];
    scenes.forEach((sc: any, pos: number) => {
      const i = Number.isInteger(sc?.i) && sc.i >= offset && sc.i < offset + BATCH ? sc.i : offset + pos;
      if (!raws.has(i)) raws.set(i, sc);
    });
  };
  let aiOk = false;
  try {
    const first = beats.slice(0, BATCH);
    const parsed: any = parseAiJson(await askLlm(castPrompt(first, title)));
    cast = sanitizeCast(parsed?.cast);
    take(parsed, 0);
    aiOk = Array.isArray(parsed?.cast) && parsed.cast.length > 0;
  } catch (err: any) {
    pipelineLogger.warn(`Storyboard cast/staging answer unusable (${String(err?.message ?? err).slice(0, 120)}): staging by rules`, "StoryPlanner");
  }
  if (!cast.length) cast = fallbackCast();
  for (let from = BATCH; from < beats.length; from += BATCH) {
    try { take(parseAiJson(await askLlm(stagePrompt(beats.slice(from, from + BATCH), from, cast))), from); } catch { /* rules below */ }
  }

  let prev: Staged | undefined;
  const scenes = beats.map((text, i) => {
    const st = sanitizeStaging(raws.get(i), text, cast, prev, i);
    prev = st;
    return {
      id: `s${String(i + 1).padStart(2, "0")}`,
      text,
      visual: { pose: "idle", mood: "neutral", camera: i % 3 === 0 ? "push" : i % 3 === 1 ? "pan-right" : "pull", story: st } as unknown,
    };
  });
  pipelineLogger.info(`Storyboard: ${cast.length} characters (${cast.map((c) => c.name || c.id).join(", ")}), ${scenes.length} scenes, ${raws.size} staged by the AI`, "StoryPlanner");
  return {
    title,
    description: beats.slice(0, 2).join(" "),
    tags: [],
    scenes: scenes as StickmanPlan["scenes"],
    aiVisuals: aiOk,
    cast,
  };
}
