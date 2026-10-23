import { pipelineLogger } from "../utils/logger";
import { parseAiJson } from "../utils/json";
import { askLlm, cleanScript, splitScriptIntoBeats, type StickmanPlan } from "./stickmanPlanner";

/**
 * Storyboard planner (Storiyum): instead of one stickman explaining, a story has a CAST (people who look different) and every beat is
 * staged as a scene: a background that fits the story, who is in it, where they stand, how they feel. The AI writes the cast and the
 * staging; whatever it leaves out or gets wrong is filled by rules, so a story always has a plan.
 * The enumerations mirror my-video/src/stickman/story/cast.ts.
 */
export const STORY_BGS = ["village", "forest", "home", "room_night", "school", "street", "market", "palace", "temple", "hospital", "river", "road", "office", "farm", "mountain", "beach", "bank", "stock", "newsroom", "govt", "studio", "belly", "cave"];
export type Look = "story" | "finance" | "news";
/** places that make sense for each niche (the AI is only offered these) */
const LOOK_BGS: Record<Look, string[]> = {
  story: ["village", "forest", "home", "room_night", "school", "street", "market", "palace", "temple", "hospital", "river", "road", "office", "farm", "mountain", "beach", "belly", "cave"],
  finance: ["bank", "stock", "office", "home", "market", "street", "village", "farm", "road"],
  news: ["newsroom", "govt", "street", "studio", "hospital", "school", "market", "road", "river", "village"],
};
const TIMES = ["day", "dusk", "night"];
const POSES = ["stand", "talk", "point", "wave", "sad", "happy", "angry", "scared", "walk", "think", "bow", "run", "cry", "pray", "hug", "give", "eat", "sleep", "dance", "fight", "carry", "struggle", "push", "shout", "tired", "jump"];
const PROPS = ["ball", "book", "bag", "letter", "gift", "food", "tea", "money", "phone", "laptop", "flowers", "tree", "dog", "cat", "cow", "bird", "horse", "car", "bus", "bicycle", "boat", "bed", "chair", "table", "lamp", "fire", "crown", "key", "trophy", "cake", "umbrella", "heart", "star", "chest", "diya", "door", "basket", "medicine", "clock", "bell", "sword", "rope", "stone", "candle", "mic", "camera", "cricket"];
const FXS = ["none", "rain", "snow", "hearts", "sparkle", "lightning", "leaves", "smoke", "stars"];
const ANIMS = ["none", "bounce", "float", "shake", "spin", "pop"];
const MOODS = ["neutral", "happy", "sad", "angry", "scared", "surprised", "laugh", "worried"];
const HAIRS = ["short", "side", "long", "bun", "ponytail", "bald", "curly", "turban", "cap"];
const OUTFITS = ["shirt", "kurta", "saree", "dress", "uniform", "suit", "hoodie", "dhoti", "fur"];
const SPECIES = ["wolf", "fox", "lion", "tiger", "dog", "cat", "monkey", "rabbit", "bear", "elephant", "deer", "goat", "buffalo", "cow"];
const FUR: Record<string, string> = { wolf: "#8E9AA6", fox: "#E67E22", lion: "#E0A33A", tiger: "#E88B2E", dog: "#C68642", cat: "#9B9B9B", monkey: "#A0693A", rabbit: "#F2F2F2", bear: "#7B5230", elephant: "#9AA5B1", deer: "#B9814A", goat: "#E5DCCB", buffalo: "#4A4A52", cow: "#EFE6D2" };
/** animals the story names (Hindi and English), in the order they appear: a story about a wolf and a buffalo needs a wolf on screen, not a man */
const ANIMAL_WORDS: [string, string, RegExp][] = [
  ["wolf", "भेड़िया", /भेड़िया|भेड़िये|भेडिया|wolf/i], ["fox", "लोमड़ी", /लोमड़ी|सियार|fox|jackal/i], ["lion", "शेर", /शेर\b|शेरनी|सिंह|lion/i], ["tiger", "बाघ", /बाघ|चीता|tiger|leopard/i],
  ["dog", "कुत्ता", /कुत्ता|कुत्ते|पिल्ला|dog\b/i], ["cat", "बिल्ली", /बिल्ली|billi|cat\b/i], ["monkey", "बंदर", /बंदर|monkey/i], ["rabbit", "खरगोश", /खरगोश|rabbit/i],
  ["bear", "भालू", /भालू|bear\b/i], ["elephant", "हाथी", /हाथी|elephant/i], ["deer", "हिरण", /हिरण|deer/i], ["goat", "बकरी", /बकरी|बकरा|goat/i], ["buffalo", "भैंस", /भैंस|भैंसा|सांड|साँड|बैल|buffalo|bull/i], ["cow", "गाय", /गाय|cow\b/i],
];
const AGES = ["child", "teen", "adult", "elder"];
const SKINS = ["#F3C9A0", "#E7B07F", "#D39A68", "#B9794A", "#8D5A3B"];
const COLORS = ["#2E86DE", "#E84393", "#F39C12", "#16A085", "#8E44AD", "#C0392B", "#27AE60", "#2C3E50"];

export interface StoryMember {
  id: string; name?: string; age: string; skin: string; hair: string; hairColor: string; outfit: string; color: string; color2?: string;
  glasses?: boolean; beard?: boolean; bindi?: boolean;
  /** an animal character (see ANIMAL_WORDS); `skin` is then its fur */
  species?: string;
}
const pick = (list: readonly string[], v: unknown, fallback: string): string => (typeof v === "string" && list.includes(v) ? v : fallback);
const hex = (v: unknown, fallback: string): string => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback);

/** Background by what the beat talks about (Hindi and English words); the previous background is kept when nothing matches. */
const BG_WORDS: [string, RegExp][] = [
  ["belly", /(पेट|बैल|सांड|साँड|भैंस|जानवर|मछली|साँप|अजगर|शेर|हाथी|मगरमच्छ)\s*(के|की|का)?\s*(पेट\s*(के|में)?\s*)?(अंदर|भीतर)|पेट\s*(के\s*)?(अंदर|में)|inside (the |a )?(belly|stomach|body)/i],
  ["cave", /गुफा|खोह|cave/i],
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
/** a beat where someone actually SAYS something (quotes or a speech verb): only then does a character talk; narration is not spoken by the characters */
const DIALOGUE = /["“”‘’\u0027]|कहा|बोला|बोली|बोले|चिल्लाया|चिल्लाई|पूछा|पूछी|पुकारा|कहने लगा|कहने लगी|said|asked|replied|shouted/i;
/** the words a character says in a beat: the quoted part ("नहीं, मैं नहीं आऊँगा") cut to what fits a speech bubble */
function quotedLine(text: string): string | undefined {
  const m = text.match(/["“”«]([^"“”»]{2,80})["“”»]/) ?? text.match(/(?:कहा|बोला|बोली|बोले|पूछा|चिल्लाया|said|asked)[,:]?\s*[\u201C"']?([^।.!?"”']{2,60})/);
  if (!m) return undefined;
  const words = m[1].trim().replace(/[,;:]+$/, "").split(/\s+/);
  const line = words.slice(0, 5).join(" ");
  return line.length >= 2 ? line + (words.length > 5 ? "…" : /[!?]$/.test(m[1].trim()) ? "" : "") : undefined;
}
const REACT_WORDS: [string, RegExp][] = [
  ["no", /नहीं|ना\s|मना कर|इनकार|इंकार|कभी नहीं|\bno\b|refus/i], ["yes", /हाँ|हां|जी हाँ|ठीक है|मान गया|मान गई|राज़ी|सहमत|सिर हिलाया|\byes\b|agreed|nodded/i],
  ["surprise", /हैरान|चौंक|अचानक|दंग|surpris|shock/i], ["laugh", /हँस|ठहाक|खिलखिला|laugh/i], ["shrug", /पता नहीं|क्या पता|shrug/i],
];
const firstMatch = (list: [string, RegExp][], text: string): string | undefined => list.find(([, re]) => re.test(text))?.[0];

/** Things the narration names that can be drawn (Hindi and English): what the story talks about must be on the screen. */
const PROP_WORDS: [string, RegExp][] = [
  ["gift", /तोहफ़ा|तोहफा|उपहार|गिफ्ट|gift|present/i], ["letter", /चिट्ठी|पत्र|खत\b|letter/i], ["money", /पैसे|रुपये|रुपए|नोट|धन\b|money|rupee/i], ["food", /खाना|रोटी|भोजन|मिठाई|खिचड़ी|food|meal|bread/i],
  ["tea", /चाय|tea\b/i], ["cake", /केक|cake/i], ["book", /किताब|पुस्तक|कॉपी|book|notebook/i], ["bag", /बस्ता|बैग|थैला|bag\b/i], ["ball", /गेंद|ball\b/i], ["cricket", /बल्ला|क्रिकेट|cricket|bat\b/i],
  ["dog", /कुत्ता|कुत्ते|पिल्ला|dog\b|puppy/i], ["cat", /बिल्ली|cat\b/i], ["cow", /गाय|भैंस|भैंसा|बैल|cow\b|buffalo|bull/i], ["horse", /घोड़ा|घोड़े|horse/i], ["bird", /चिड़िया|पक्षी|तोता|कबूतर|bird|parrot/i],
  ["car", /कार\b|गाड़ी|car\b|taxi|जीप/i], ["bus", /बस\b|bus\b/i], ["bicycle", /साइकिल|cycle|bicycle/i], ["boat", /नाव|नौका|boat/i],
  ["bed", /बिस्तर|पलंग|खाट|bed\b/i], ["chair", /कुर्सी|chair/i], ["table", /मेज़|मेज\b|table\b/i], ["door", /दरवाज़ा|दरवाजा|door\b/i], ["lamp", /लैंप|बल्ब|lamp/i], ["candle", /मोमबत्ती|candle/i], ["diya", /दीया|दीपक|diya/i],
  ["fire", /आग\b|अलाव|fire\b|flame/i], ["crown", /ताज\b|मुकुट|crown/i], ["key", /चाबी|कुंजी|key\b/i], ["trophy", /ट्रॉफी|इनाम|पुरस्कार|कप\b|trophy|prize/i], ["umbrella", /छाता|छतरी|umbrella/i],
  ["heart", /दिल\b|प्यार|मोहब्बत|heart|love/i], ["star", /सितारा|तारा\b|star\b/i], ["chest", /ख़ज़ाना|खज़ाना|खजाना|संदूक|treasure|chest/i], ["basket", /टोकरी|basket/i], ["medicine", /दवा\b|दवाई|medicine/i],
  ["clock", /घड़ी|clock|watch/i], ["bell", /घंटी|घंटा|bell\b/i], ["sword", /तलवार|sword/i], ["rope", /रस्सी|rope/i], ["stone", /पत्थर|stone|rock\b/i], ["flowers", /फूल|गुलाब|flower|rose/i], ["tree", /पेड़|वृक्ष|tree\b/i],
  ["phone", /फोन|मोबाइल|phone|mobile/i], ["laptop", /लैपटॉप|कंप्यूटर|laptop|computer/i], ["mic", /माइक|mic\b/i], ["camera", /कैमरा|कैमरे|camera/i],
];
const POSE_WORDS: [string, RegExp][] = [
  ["struggle", /छटपटा|फँस|फंस|तड़प|संघर्ष|निकलने की कोशिश|बाहर निकलने|बंद हो चुका|stuck|trapped|struggl/i], ["shout", /चिल्ला|पुकार|बचाओ|दहाड़|शोर मचा|shout|yell|cried out|roar/i],
  ["push", /धक्का|धकेल|खींच|ज़ोर लगा|जोर लगा|push|pull/i], ["tired", /थक|हाँफ|हांफ|निढाल|tired|exhaust|panting/i], ["jump", /कूद|उछल|छलांग|jump|leap/i],
  ["hug", /गले लग|गले मिल|hug/i], ["cry", /रो\s|रोया|रोई|रोने|रोते|आँसू|आंसू|सिसक|cry|wept|tears/i], ["run", /भाग|दौड़|run\b|ran\b|rushed/i], ["pray", /प्रार्थना|पूजा|दुआ|नमस्ते|pray|worship/i],
  ["sleep", /सो गया|सो गई|सोया|सोई|नींद|सो रहा|sleep|slept/i], ["eat", /खाया|खा रहा|खाने लगा|खिलाया|खा\s|eat\b|ate\b|fed\b/i], ["give", /दिया|दी\b|देते|सौंप|भेंट|give\b|gave\b/i],
  ["dance", /नाच|नाचा|dance/i], ["fight", /लड़|झगड़|मारा|पीटा|fight|fought|hit\b/i], ["carry", /उठाया|उठा लिया|लेकर|ले गया|carry|carried/i], ["point", /दिखाया|इशारा|point/i],
];
const FX_WORDS: [string, RegExp][] = [
  ["lightning", /बिजली|तूफ़ान|तूफान|आँधी|storm|thunder/i], ["rain", /बारिश|बरसात|भीग|rain/i], ["snow", /बर्फ|हिमपात|snow/i], ["hearts", /प्यार|प्रेम|शादी|मोहब्बत|love|wedding/i],
  ["sparkle", /जादू|चमत्कार|चमक|magic|miracle|sparkl/i], ["smoke", /धुआँ|धुआं|smoke/i], ["leaves", /पतझड़|पत्ते|autumn|leaves/i],
];

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
    const species = typeof r?.species === "string" && SPECIES.includes(r.species) ? r.species : undefined;
    const outfit = pick(OUTFITS, r?.outfit, species ? "fur" : "shirt");
    out.push({
      ...(species ? { species } : {}),
      id, name: typeof r?.name === "string" ? r.name.slice(0, 14) : "", age: species ? "adult" : pick(AGES, r?.age, "adult"), skin: species ? hex(r?.skin, FUR[species]) : hex(r?.skin, SKINS[i % SKINS.length]),
      hair: species ? "bald" : pick(HAIRS, r?.hair, "short"), hairColor: hex(r?.hairColor, "#1B1B1B"), outfit, color: hex(r?.color, COLORS[i % COLORS.length]),
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
  /** counts the shots: a new place or time starts a new one */
  shot?: number;
  /** same place and time as the previous beat: the shot goes on (no transition, nobody re-enters) */
  cont?: boolean;
  look: Look; headline?: string; stat?: { label: string; value: string }; place?: string;
  bg: string; time: string;
  chars: { id: string; x: number; pose: string; mood: string; flip: boolean; scale: number; delay: number; speaking: boolean; fromX?: number; holds?: string; says?: string; react?: string }[];
  props?: { type: string; x: number; air: number; scale: number; anim: string; delay: number }[];
  fx?: string;
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
  const sameShot = !!prev && bg === prev.bg && time === prev.time;
  const shot = !prev ? 0 : sameShot ? prev.shot ?? 0 : (prev.shot ?? 0) + 1;
  let chars = (Array.isArray(raw?.chars) ? raw.chars : []).filter((c: any) => ids.has(c?.id)).slice(0, 4);
  if (!chars.length) {
    // rule staging. Inside a shot the same people stay exactly where they stand and only the speaker changes (a different layout on every
    // beat made the picture jump); a new shot picks a new layout.
    const mood = firstMatch(MOOD_WORDS, text) ?? "neutral";
    const order = cast.map((c) => c.id);
    const talks = look !== "story" || DIALOGUE.test(text);
    const posePool = mood === "neutral" ? [talks ? "talk" : "stand"] : mood === "sad" ? ["sad"] : mood === "scared" ? ["scared"] : mood === "angry" ? ["angry"] : ["happy", talks ? "talk" : "stand"];
    const verbPose = firstMatch(POSE_WORDS, text);
    const pose = verbPose ?? posePool[index % posePool.length];
    if (sameShot && prev!.chars.length) {
      const pids = prev!.chars.map((c) => c.id);
      const lead = pids[Math.floor(index / 2) % pids.length];
      chars = prev!.chars.map((c) => ({ id: c.id, x: c.x, pose: c.id === lead ? pose : "stand", mood, flip: c.flip, scale: c.scale, speaking: talks && c.id === lead }));
    } else {
      const lead = order[shot % order.length];
      const other = order[(shot + 1) % order.length];
      const layout = shot % 4;
      if (order.length === 1 || layout === 1) chars = [{ id: lead, x: shot % 8 < 4 ? 40 : 60, pose, mood, flip: shot % 8 >= 4, scale: 1.15, speaking: talks }];
      else if (layout === 2) chars = [{ id: other, x: 28, pose: "stand", mood, flip: false, speaking: false }, { id: lead, x: 70, pose, mood, flip: true, speaking: talks }];
      else if (layout === 3) chars = [{ id: lead, x: 34, pose, mood, flip: false, speaking: talks, scale: 1.1 }, { id: other, x: 80, pose: "stand", mood: "neutral", flip: true, scale: 0.9 }];
      else chars = [{ id: lead, x: 30, pose, mood, flip: false, speaking: talks }, { id: other, x: 70, pose: "stand", mood, flip: true }];
    }
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
    holds: PROPS.includes(c.holds) ? c.holds : undefined,
    says: typeof c.says === "string" && c.says.trim() ? c.says.trim().slice(0, 30) : undefined,
    react: ["no", "yes", "shrug", "surprise", "laugh"].includes(c.react) ? c.react : undefined,
  }));
  if (look !== "story" && !staged.some((c: { speaking: boolean }) => c.speaking)) staged[0].speaking = true;
  // dialogue: the speaker shows the quoted words in a bubble; whoever answers no / yes shakes their head or nods (rules fill what the AI left out)
  if (look === "story") {
    const speaker = staged.find((c: { speaking: boolean }) => c.speaking);
    const line = quotedLine(text);
    if (speaker && line && !speaker.says) speaker.says = line;
    const reaction = firstMatch(REACT_WORDS, text);
    if (reaction) {
      const target = staged.find((c: { react?: string; speaking: boolean }) => !c.react && (staged.length === 1 || !c.speaking)) ?? speaker;
      if (target && !target.react) target.react = reaction;
      if (reaction === "no" && speaker && !speaker.react && staged.length > 1) speaker.react = "no";
    }
  }
  // the AI often leaves a person standing in a beat whose words say what they DO: the words win for the first idle person
  const doing = firstMatch(POSE_WORDS, text);
  if (look === "story" && doing && ["struggle", "shout", "run", "cry", "hug", "pray", "eat", "sleep", "give", "carry", "fight", "dance", "push", "tired", "jump"].includes(doing)) {
    const idle = staged.find((c: { pose: string }) => ["stand", "talk", "think", "point", "wave", "walk", "sad"].includes(c.pose));
    if (idle && !staged.some((c: { pose: string }) => c.pose === doing)) idle.pose = doing;
  }

  // what the beat talks about is on the screen: objects and animals (AI first, otherwise the words), weather, and the thing in someone's hand
  let props: NonNullable<Staged["props"]> = (Array.isArray(raw?.props) ? raw.props : [])
    .filter((p: any) => PROPS.includes(p?.type)).slice(0, 4)
    .map((p: any, k: number) => ({ type: p.type, x: Math.max(6, Math.min(94, Number.isFinite(Number(p.x)) ? Number(p.x) : 50)), air: Math.max(0, Math.min(1, Number(p.air) || 0)), scale: Math.max(0.5, Math.min(2.2, Number(p.scale) || 1)), anim: ANIMS.includes(p.anim) ? p.anim : "none", delay: 6 + k * 6 }));
  if (!props.length) {
    const found = PROP_WORDS.filter(([, re]) => re.test(text)).map(([n]) => n).slice(0, 2);
    props = found.map((type, k) => ({
      type, x: staged.length === 1 ? (staged[0].x < 50 ? 74 : 26) : 50 + (k ? 22 : 0), air: ["bird", "heart", "star", "bell"].includes(type) ? 0.5 : 0,
      scale: ["car", "bus", "boat", "tree", "horse", "cow", "bed", "door"].includes(type) ? 1.2 : ["dog", "cat", "bird"].includes(type) ? 1.4 : 1.3, anim: ["ball", "dog", "bird"].includes(type) ? "bounce" : ["heart", "star"].includes(type) ? "float" : "pop", delay: 6 + k * 6,
    }));
  }
  const fxRaw = typeof raw?.fx === "string" && FXS.includes(raw.fx) ? raw.fx : undefined;
  const fx = fxRaw ?? firstMatch(FX_WORDS, text) ?? (time === "night" && look === "story" ? "stars" : "none");
  // give / carry / eat: the object goes into the performer's hand instead of standing on the floor
  const doer = staged.find((c: { pose: string }) => ["give", "carry", "eat"].includes(c.pose));
  if (doer) {
    const handy = props.find((p) => ["gift", "food", "tea", "cake", "book", "letter", "money", "flowers", "bag", "basket", "medicine", "key", "trophy", "crown", "phone", "ball"].includes(p.type));
    if (handy) { doer.holds = handy.type; props = props.filter((p) => p !== handy); }
    else if (doer.pose === "give") doer.holds = "gift";
    else if (doer.pose === "eat") doer.holds = "food";
  }
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
  return { look, headline, stat, place, run, topic: wanted, shot, cont: sameShot, bg, time, chars: staged, props, fx };
}

const BATCH = 14;
const LOOK_BRIEF: Record<Look, string> = {
  story: "a Hindi story video",
  finance: "a Hindi personal-finance explainer (money, loans, markets). The cast is people in a money situation: an adviser (suit) and an ordinary customer (kurta, saree, shirt). Each scene also gets a short \"headline\" (at most 7 Hindi words) and, when the beat names a number, a \"stat\":{\"label\":\"2-3 words\",\"value\":\"5.50%\"}",
  news: "a Hindi news video. The cast is an anchor (suit), a reporter and the people in the news (officials, citizens). Each scene also gets a short \"headline\" (at most 7 Hindi words, like a news ticker) and a \"place\" (city or location in Hindi, when known)",
};
const castPrompt = (beats: string[], title: string, look: Look): string =>
  `You are the storyboard artist of ${LOOK_BRIEF[look]} "${title}". Read the narration beats and design the CAST and the staging of every beat.\n` +
  `Return ONLY raw JSON: {"cast":[{"id":"short_latin_id","name":"Hindi first name","age":"${AGES.join("|")}","skin":"#hex","hair":"${HAIRS.join("|")}","hairColor":"#hex","outfit":"${OUTFITS.join("|")}","color":"#hex","color2":"#hex","glasses":false,"beard":false,"bindi":false,"species":"only for animal characters: ${SPECIES.join("|")}"}],` +
  `"scenes":[{"i":0,"bg":"${LOOK_BGS[look].join("|")}","time":"${TIMES.join("|")}","headline":"","place":"","fx":"${FXS.join("|")}","props":[{"type":"${PROPS.join("|")}","x":0-100,"air":0,"scale":1.3,"anim":"${ANIMS.join("|")}"}],"chars":[{"id":"cast id","x":0-100,"pose":"${POSES.join("|")}","mood":"${MOODS.join("|")}","flip":false,"speaking":true,"holds":"optional prop type in the hand"}]}]}\n` +
  `THE CHARACTERS ACT, THEY DO NOT NARRATE: the narrator is off screen. Set "speaking":true ONLY in a beat where a character really says words (dialogue); otherwise every "speaking" is false and the characters perform the event with a pose (struggle, push, shout, run, cry, hug, give, eat, sleep, pray, fight, carry, tired, jump). When the story goes INSIDE something (a belly, a cave) use bg "belly" or "cave". SHOW WHAT HAPPENS: every concrete thing the beat mentions must be on screen: the objects, animals, vehicles and weather as "props"/"fx" (a dog, a gift, rain, a bus), and what a person DOES as the pose (running = run, crying = cry, hugging = hug, giving = give with holds, eating = eat with holds, sleeping = sleep, praying = pray, fighting = fight, carrying = carry). ` +
  `If a character in the story is an ANIMAL (a wolf, a lion, a fox...), make it an animal cast member: species set, outfit "fur", skin = its fur colour, hair "bald", age "adult". Rules: 2 to 4 cast members, each clearly different (age, clothes, colours) and matching the story (a grandfather is an elder with a dhoti or kurta, a mother wears a saree, a student a uniform). ` +
  `One scene per beat, in order. The background must fit WHERE the beat happens and the time of day WHEN; change it when the place changes. ` +
  `Put only the people who are in that beat on stage (1-3), x = where they stand left (10) to right (90), the speaker or main person speaking:true, moods and poses that show the emotion of the beat. ` +
  `Do not think out loud: the first character of your answer is "{".\n/no_think\n\nBeats:\n${beats.map((b, i) => `${i}. ${b}`).join("\n")}`;
const stagePrompt = (beats: string[], from: number, cast: StoryMember[], look: Look): string =>
  `Stage these beats of ${LOOK_BRIEF[look]}. Cast: ${JSON.stringify(cast.map((c) => ({ id: c.id, name: c.name, age: c.age })))}.\n` +
  `Return ONLY raw JSON: {"scenes":[{"i":${from},"bg":"${LOOK_BGS[look].join("|")}","time":"${TIMES.join("|")}","headline":"","place":"","fx":"${FXS.join("|")}","props":[{"type":"${PROPS.join("|")}","x":0-100,"air":0,"scale":1.3,"anim":"${ANIMS.join("|")}"}],"chars":[{"id":"cast id","x":0-100,"pose":"${POSES.join("|")}","mood":"${MOODS.join("|")}","flip":false,"speaking":true,"holds":"optional prop type in the hand"}]}]}\n` +
  `The characters ACT out the event (poses like struggle, push, shout, run, cry, hug, tired, jump); "speaking":true only when someone really says words in the beat; bg "belly"/"cave" when the story is inside something. Show what the beat says happens: its objects, animals, vehicles and weather as props/fx, and each person's action as the pose (run, cry, hug, give, eat, sleep, pray, fight, carry; give/eat/carry with holds). One scene per beat in order, i counts from ${from}. Background = where the beat happens; only people in the beat are on stage. No thinking out loud; start with "{".\n/no_think\n\n${beats.map((b, k) => `${from + k}. ${b}`).join("\n")}`;

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
  // no cast from the AI: a story about animals gets those animals (up to 3), not two people
  if (!cast.length || (!aiOk && look === "story")) {
    const text = beats.join(" ");
    const seen = ANIMAL_WORDS.filter(([, , re]) => re.test(text)).slice(0, 3);
    if (seen.length >= 1 && look === "story") {
      cast = seen.map(([species, hindi]) => ({ id: species, name: hindi, age: "adult", skin: FUR[species], hair: "bald", hairColor: "#1B1B1B", outfit: "fur", color: FUR[species], species }));
      if (cast.length === 1) cast.push({ id: "narrator", name: "", age: "adult", skin: SKINS[2], hair: "short", hairColor: "#1B1B1B", outfit: "kurta", color: COLORS[2], color2: "#2D3436" });
    } else if (!cast.length) cast = fallbackCast(look);
  }
  for (let from = BATCH; from < beats.length; from += BATCH) {
    try { take(parseAiJson(clean(await askLlm(stagePrompt(beats.slice(from, from + BATCH), from, cast, look)))), from); } catch { /* rules below */ }
  }

  let prev: Staged | undefined;
  const scenes = beats.map((text, i) => {
    const st = sanitizeStaging(raws.get(i), text, cast, prev, i, look);
    // a continuing shot: whoever stood in the previous beat walks from there (nobody re-enters, nothing fades)
    if (st.cont && prev) for (const c of st.chars) c.fromX = prev.chars.find((p) => p.id === c.id)?.x;
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
