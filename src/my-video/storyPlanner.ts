import { pipelineLogger } from "../utils/logger";
import { parseAiJson } from "../utils/json";
import { askLlm, cleanScript, splitScriptIntoBeats, type StickmanPlan } from "./stickmanPlanner";

/**
 * Storyboard planner (Storiyum): instead of one stickman explaining, a story has a CAST (people who look different) and every beat is
 * staged as a scene: a background that fits the story, who is in it, where they stand, how they feel. The AI writes the cast and the
 * staging; whatever it leaves out or gets wrong is filled by rules, so a story always has a plan.
 * The enumerations mirror my-video/src/stickman/story/cast.ts.
 */
export const STORY_BGS = ["village", "forest", "home", "room_night", "school", "street", "market", "palace", "temple", "hospital", "river", "road", "office", "farm", "mountain", "beach", "bank", "stock", "newsroom", "govt", "studio"];
export type Look = "story" | "finance" | "news";
/** places that make sense for each niche (the AI is only offered these) */
const LOOK_BGS: Record<Look, string[]> = {
  story: ["village", "forest", "home", "room_night", "school", "street", "market", "palace", "temple", "hospital", "river", "road", "office", "farm", "mountain", "beach"],
  finance: ["bank", "stock", "office", "home", "market", "street", "village", "farm", "road"],
  news: ["newsroom", "govt", "street", "studio", "hospital", "school", "market", "road", "river", "village"],
};
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
  ["stock", /शेयर|सेंसेक्स|निफ्टी|स्टॉक|म्यूचुअल|एसआईपी|sensex|nifty|stock|mutual fund|sip/i],
  ["bank", /बैंक|आरबीआई|ईएमआई|लोन|ब्याज|रेपो|खाता|bank|rbi|emi|loan|interest|repo/i],
  ["govt", /संसद|सरकार|मंत्री|प्रधानमंत्री|चुनाव|नीति|कानून|parliament|government|minister|election/i],
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
function fallbackCast(look: Look = "story"): StoryMember[] {
  if (look === "news") return [
    { id: "anchor", name: "", age: "adult", skin: SKINS[1], hair: "side", hairColor: "#1B1B1B", outfit: "suit", color: "#1F3A5F", glasses: true },
    { id: "reporter", name: "", age: "adult", skin: SKINS[2], hair: "ponytail", hairColor: "#2B1A12", outfit: "dress", color: "#C0392B" },
  ];
  if (look === "finance") return [
    { id: "advisor", name: "सलाहकार", age: "adult", skin: SKINS[2], hair: "short", hairColor: "#1B1B1B", outfit: "suit", color: "#0B6E4F", glasses: true },
    { id: "customer", name: "", age: "adult", skin: SKINS[3], hair: "short", hairColor: "#1B1B1B", outfit: "kurta", color: "#F39C12" },
  ];
  return [
    { id: "hero", name: "", age: "adult", skin: SKINS[2], hair: "short", hairColor: "#1B1B1B", outfit: "shirt", color: COLORS[0], color2: "#2D3436" },
    { id: "friend", name: "", age: "adult", skin: SKINS[1], hair: "long", hairColor: "#2B1A12", outfit: "kurta", color: COLORS[1], color2: "#2D3436", bindi: true },
  ];
}

export function sanitizeCast(raw: unknown, look: Look = "story"): StoryMember[] {
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
  return out.length ? out : fallbackCast(look);
}

export interface Staged {
  /** how many beats in a row this place has been shown (finance / news change place after a few) */
  run?: number;
  /** the place the words/AI asked for (before the forced change of scenery) */
  topic?: string;
  look: Look; headline?: string; stat?: { label: string; value: string }; place?: string;
  bg: string; time: string;
  chars: { id: string; x: number; pose: string; mood: string; flip: boolean; scale: number; delay: number; speaking: boolean }[];
}

/** One beat's scene from what the AI said (or nothing): everything is clamped to what my-video can draw. */
export function sanitizeStaging(raw: any, text: string, cast: StoryMember[], prev: Staged | undefined, index: number, look: Look = "story"): Staged {
  const ids = new Set(cast.map((c) => c.id));
  const allowed = LOOK_BGS[look];
  const byWords = firstMatch(BG_WORDS, text);
  // nothing says where we are: finance and news change place every few beats (a bank for 70 scenes in a row is not a video)
  const rotation = look === "finance" ? ["bank", "office", "home", "market", "stock", "street"] : look === "news" ? ["newsroom", "street", "govt", "studio", "market", "road"] : [];
  const byRotation = rotation.length ? rotation[Math.floor(index / 5) % rotation.length] : undefined;
  const wanted = pick(allowed, raw?.bg, byWords && allowed.includes(byWords) ? byWords : byRotation ?? prev?.topic ?? allowed[0]);
  let bg = wanted;
  let run = prev && wanted === prev.topic ? (prev.run ?? 1) + 1 : 1;
  // a video about banks asks for "bank" on every beat: after a few beats in one place the scene moves on anyway, and keeps moving
  if (rotation.length && prev && wanted === prev.topic && run > 4) {
    bg = rotation[(Math.max(0, rotation.indexOf(prev.bg)) + 1) % rotation.length];
    run = 1;
  } else if (prev && wanted === prev.topic) {
    bg = prev.bg;
  }
  const time = pick(TIMES, raw?.time, firstMatch(TIME_WORDS, text) ?? prev?.time ?? "day");
  let chars = (Array.isArray(raw?.chars) ? raw.chars : []).filter((c: any) => ids.has(c?.id)).slice(0, 4);
  if (!chars.length) {
    // rule staging: the previous scene's people stay, otherwise the first one or two of the cast
    const mood = firstMatch(MOOD_WORDS, text) ?? "neutral";
    const ids = cast.map((c) => c.id);
    const lead = ids[Math.floor(index / 2) % ids.length];
    const other = ids[(Math.floor(index / 2) + 1) % ids.length];
    const posePool = mood === "neutral" ? ["talk", "point", "think", "stand", "talk", "wave"] : mood === "sad" ? ["sad", "stand"] : mood === "scared" ? ["scared", "stand"] : mood === "angry" ? ["angry", "point"] : ["happy", "talk", "wave"];
    const pose = posePool[index % posePool.length];
    // four layouts in rotation: pair, close-up of the speaker, pair mirrored, speaker small beside the other
    const layout = index % 4;
    if (ids.length === 1 || layout === 1) chars = [{ id: lead, x: index % 8 < 4 ? 40 : 60, pose, mood, flip: index % 8 >= 4, scale: 1.15, speaking: true }];
    else if (layout === 2) chars = [{ id: other, x: 28, pose: "stand", mood, flip: false, speaking: false }, { id: lead, x: 70, pose, mood, flip: true, speaking: true }];
    else if (layout === 3) chars = [{ id: lead, x: 34, pose, mood, flip: false, speaking: true, scale: 1.1 }, { id: other, x: 80, pose: "think", mood: "neutral", flip: true, scale: 0.9 }];
    else chars = [{ id: lead, x: 30, pose, mood, flip: false, speaking: true }, { id: other, x: 70, pose: "stand", mood, flip: true }];
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
  // niche frame: a headline for news / finance, a big figure for finance, a place for news
  const clean = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const hasFigure = /[₹$]\s?[\d,.]+|[\d,.]+\s?(?:%|प्रतिशत|अंक|रुपये|रुपए)/.test(text);
  const headline = look === "story" ? undefined : clean(raw?.headline, 70) ?? (index % 5 === 0 || hasFigure ? words.slice(0, 7).join(" ") : undefined);
  const figure = text.match(/[₹$]\s?[\d,.]+(?:\s?(?:करोड़|लाख|हज़ार|अरब))?|[\d,.]+\s?(?:%|प्रतिशत|अंक|रुपये|रुपए)/);
  const stat = look === "finance"
    ? (raw?.stat && clean(raw.stat.value, 14) && clean(raw.stat.label, 30) ? { label: clean(raw.stat.label, 30)!, value: clean(raw.stat.value, 14)! } : figure ? { label: "आँकड़ा", value: figure[0].replace(/\s?प्रतिशत/, "%").trim().slice(0, 14) } : undefined)
    : undefined;
  const place = look === "news" ? clean(raw?.place, 24) ?? prev?.place : undefined;
  return { look, headline, stat, place, run, topic: wanted, bg, time, chars: staged };
}

const BATCH = 14;
const LOOK_BRIEF: Record<Look, string> = {
  story: "a Hindi story video",
  finance: "a Hindi personal-finance explainer (money, loans, markets). The cast is people in a money situation: an adviser (suit) and an ordinary customer (kurta, saree, shirt). Each scene also gets a short \"headline\" (at most 7 Hindi words) and, when the beat names a number, a \"stat\":{\"label\":\"2-3 words\",\"value\":\"5.50%\"}",
  news: "a Hindi news video. The cast is an anchor (suit), a reporter and the people in the news (officials, citizens). Each scene also gets a short \"headline\" (at most 7 Hindi words, like a news ticker) and a \"place\" (city or location in Hindi, when known)",
};
const castPrompt = (beats: string[], title: string, look: Look): string =>
  `You are the storyboard artist of ${LOOK_BRIEF[look]} "${title}". Read the narration beats and design the CAST and the staging of every beat.\n` +
  `Return ONLY raw JSON: {"cast":[{"id":"short_latin_id","name":"Hindi first name","age":"${AGES.join("|")}","skin":"#hex","hair":"${HAIRS.join("|")}","hairColor":"#hex","outfit":"${OUTFITS.join("|")}","color":"#hex","color2":"#hex","glasses":false,"beard":false,"bindi":false}],` +
  `"scenes":[{"i":0,"bg":"${LOOK_BGS[look].join("|")}","time":"${TIMES.join("|")}","headline":"","place":"","chars":[{"id":"cast id","x":0-100,"pose":"${POSES.join("|")}","mood":"${MOODS.join("|")}","flip":false,"speaking":true}]}]}\n` +
  `Rules: 2 to 4 cast members, each clearly different (age, clothes, colours) and matching the story (a grandfather is an elder with a dhoti or kurta, a mother wears a saree, a student a uniform). ` +
  `One scene per beat, in order. The background must fit WHERE the beat happens and the time of day WHEN; change it when the place changes. ` +
  `Put only the people who are in that beat on stage (1-3), x = where they stand left (10) to right (90), the speaker or main person speaking:true, moods and poses that show the emotion of the beat. ` +
  `Do not think out loud: the first character of your answer is "{".\n/no_think\n\nBeats:\n${beats.map((b, i) => `${i}. ${b}`).join("\n")}`;
const stagePrompt = (beats: string[], from: number, cast: StoryMember[], look: Look): string =>
  `Stage these beats of ${LOOK_BRIEF[look]}. Cast: ${JSON.stringify(cast.map((c) => ({ id: c.id, name: c.name, age: c.age })))}.\n` +
  `Return ONLY raw JSON: {"scenes":[{"i":${from},"bg":"${LOOK_BGS[look].join("|")}","time":"${TIMES.join("|")}","headline":"","place":"","chars":[{"id":"cast id","x":0-100,"pose":"${POSES.join("|")}","mood":"${MOODS.join("|")}","flip":false,"speaking":true}]}]}\n` +
  `One scene per beat in order, i counts from ${from}. Background = where the beat happens; only people in the beat are on stage. No thinking out loud; start with "{".\n/no_think\n\n${beats.map((b, k) => `${from + k}. ${b}`).join("\n")}`;

/** The plan of a story video: scenes carry `visual.story`, the cast travels with the plan. */
export async function planStoryboard(script: string, titleHint?: string, look: Look = "story"): Promise<StickmanPlan & { cast: StoryMember[] }> {
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
  // the cast decides how the whole story looks: ask up to 3 times (a malformed answer is common on the free models) before the default pair
  const clean = (raw: string) => raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
  for (let attempt = 1; attempt <= 3 && !aiOk; attempt++) {
    try {
      const first = beats.slice(0, BATCH);
      const parsed: any = parseAiJson(clean(await askLlm(castPrompt(first, title, look))));
      if (!Array.isArray(parsed?.cast) || !parsed.cast.length) throw new Error("no cast in the answer");
      cast = sanitizeCast(parsed.cast, look);
      take(parsed, 0);
      aiOk = true;
    } catch (err: any) {
      pipelineLogger.warn(`Storyboard cast/staging answer unusable, attempt ${attempt}/3 (${String(err?.message ?? err).slice(0, 120)})`, "StoryPlanner");
    }
  }
  if (!cast.length) cast = fallbackCast(look);
  for (let from = BATCH; from < beats.length; from += BATCH) {
    try { take(parseAiJson(clean(await askLlm(stagePrompt(beats.slice(from, from + BATCH), from, cast, look)))), from); } catch { /* rules below */ }
  }

  let prev: Staged | undefined;
  const scenes = beats.map((text, i) => {
    const st = sanitizeStaging(raws.get(i), text, cast, prev, i, look);
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
