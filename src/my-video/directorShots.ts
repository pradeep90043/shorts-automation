/**
 * Director shots: on every channel (unless DIRECTOR_SHOTS=off, or a comma list of channels), each narrated beat that does not
 * carry an information panel (code, chart, table, steps, a real photo... - those keep teaching) gets a `shot`: a small film
 * scene described in words (place, characters, what they do, camera) that my-video's director stages physically (people sit
 * on chairs, hands reach cups, the camera follows; my-video/src/stickman/film/direct.ts).
 *
 * The AI first designs the cast once (so a character looks the same all video), then writes the beats' shots in batches.
 * Every shot is checked here against the director's vocabulary (directorCatalog.json, exported from my-video by
 * scripts/film/export-catalog.ts): unknown places drop the shot, unknown actions/targets are removed, and each character's
 * look is copied from the cast design. A beat whose shot is unusable keeps its normal stickman visual, and my-video drops a
 * shot it cannot parse the same way, so a bad shot never stops a video.
 */
import catalog from "./directorCatalog.json";
import { parseAiJson } from "../utils/json";
import { WORDS_PER_SEC, countWords, type StickmanPlan } from "./stickmanPlanner";

type Dict = Record<string, any>;

/** Which channels get director shots: DIRECTOR_SHOTS = "all" (default) | "off" | comma list of channel keys. */
export function directorShotsEnabled(channelKey: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.DIRECTOR_SHOTS ?? "all").trim().toLowerCase();
  if (!v || v === "off" || v === "0" || v === "false") return false;
  if (v === "all" || v === "on" || v === "1" || v === "true") return true;
  return !!channelKey && v.split(",").map((s) => s.trim()).includes(channelKey.toLowerCase());
}

const has = (list: readonly string[], v: unknown): v is string => typeof v === "string" && list.includes(v);
const HEX = /^#[0-9a-fA-F]{6}$/;
const LOOK_KEYS = ["age", "gender", "build", "hair", "beard", "outfit", "skin"] as const;

/** A cast member's look, kept to what the director knows. */
export function sanitizeLook(raw: Dict): Dict {
  const out: Dict = {};
  for (const k of LOOK_KEYS) if (has((catalog.avatar as Dict)[k], raw?.[k])) out[k] = raw[k];
  for (const k of ["top", "bottom", "hairColor"]) if (typeof raw?.[k] === "string" && HEX.test(raw[k])) out[k] = raw[k];
  if (typeof raw?.glasses === "boolean") out.glasses = raw.glasses;
  return out;
}

/** The story's characters, designed once: id -> look. At most 5 (the director's limit per shot). */
export function sanitizeCast(raw: unknown): Map<string, Dict> {
  const cast = new Map<string, Dict>();
  const list = Array.isArray((raw as Dict)?.cast) ? (raw as Dict).cast : Array.isArray(raw) ? raw : [];
  const skin = has(catalog.avatar.skin, (raw as Dict)?.skin) ? (raw as Dict).skin : undefined;
  for (const c of list) {
    const id = typeof c?.id === "string" ? c.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") : "";
    if (!id || cast.has(id) || cast.size >= 5) continue;
    cast.set(id, { ...sanitizeLook(c), ...(skin ? { skin } : {}) });
  }
  return cast;
}

/**
 * One AI-written shot made safe for the director, or null when it cannot be staged at all (unknown place). Problems that
 * were repaired are returned for the log.
 */
export function sanitizeShot(raw: unknown, cast: Map<string, Dict>, secs: number): { shot: Dict | null; problems: string[] } {
  const problems: string[] = [];
  const r = raw as Dict;
  if (!r || typeof r !== "object" || !has(catalog.places, r.place)) return { shot: null, problems: [`unknown place "${r?.place}"`] };
  const shot: Dict = { secs: Math.max(1.5, Math.min(30, secs)), place: r.place };
  if (has(catalog.times, r.time)) shot.time = r.time;
  if (typeof r.furnish === "boolean") shot.furnish = r.furnish;
  if (Array.isArray(r.fx)) shot.fx = r.fx.filter((f: unknown) => has(catalog.fx, f));

  // props: known kinds, unique ids, standing on something that exists
  const ids = new Set<string>(shot.furnish === false ? [] : (catalog.placeThings as Dict)[r.place] ?? []);
  shot.props = [];
  for (const p of Array.isArray(r.props) ? r.props.slice(0, 24) : []) {
    if (!p || typeof p.id !== "string" || !(p.kind in catalog.props) || ids.has(p.id)) { problems.push(`prop dropped: ${JSON.stringify(p)?.slice(0, 60)}`); continue; }
    const prop: Dict = { id: p.id, kind: p.kind };
    if (typeof p.on === "string" && (p.on === "floor" || p.on === "wall" || ids.has(p.on))) prop.on = p.on;
    for (const k of ["at", "height"]) if (typeof p[k] === "number" && p[k] >= 0 && p[k] <= 1) prop[k] = p[k];
    if (has(["back", "mid", "front"], p.row)) prop.row = p.row;
    if (typeof p.label === "string") prop.label = p.label.slice(0, 40);
    if (typeof p.lit === "boolean") prop.lit = p.lit;
    if (typeof p.color === "string" && HEX.test(p.color)) prop.color = p.color;
    shot.props.push(prop);
    ids.add(p.id);
  }

  // cast: only designed characters, with their designed look (a character never changes clothes between beats)
  shot.cast = [];
  const inShot = new Set<string>();
  for (const c of Array.isArray(r.cast) ? r.cast : []) {
    const id = typeof c?.id === "string" ? c.id.trim().toLowerCase() : "";
    if (!cast.has(id) || inShot.has(id) || inShot.size >= 5) { if (id && !cast.has(id)) problems.push(`unknown character "${id}"`); continue; }
    const m: Dict = { id, ...cast.get(id) };
    if (typeof c.at === "number" && c.at >= 0 && c.at <= 1) m.at = c.at;
    if (has(["back", "mid", "front"], c.row)) m.row = c.row;
    if (has(["left", "right"], c.facing)) m.facing = c.facing;
    if (has(catalog.moods, c.mood)) m.mood = c.mood;
    if (has(catalog.poses, c.pose)) m.pose = c.pose;
    for (const k of ["sitOn", "lieOn", "holds"]) if (typeof c[k] === "string" && ids.has(c[k])) m[k] = c[k];
    if (has(["left", "right"], c.enter)) m.enter = c.enter;
    shot.cast.push(m);
    inShot.add(id);
  }

  // actions: known verbs by people in the shot, aimed at things or people that exist; times inside the shot
  shot.actions = [];
  for (const a0 of Array.isArray(r.actions) ? r.actions.slice(0, 40) : []) {
    // a pose or mood written without its verb ({who, pose: "think"}) means that verb
    const a = a0 && !a0.do ? { ...a0, do: a0.pose ? "pose" : a0.mood ? "mood" : undefined } : a0;
    // an object used but never added ("use phone"): add it - in the hand for using / drinking / handing over, on a surface to pick up
    if (a && typeof a.target === "string" && !ids.has(a.target) && !inShot.has(a.target.toLowerCase())) {
      const kind = SYNONYMS[a.target.toLowerCase().replace(/[-_ ]?\d+$/, "")] ?? a.target.toLowerCase().replace(/[-_ ]?\d+$/, "");
      const actor = shot.cast.find((m: Dict) => m.id === String(a.who ?? "").toLowerCase());
      if ((catalog.props as Dict)[kind]?.mount === "surface" && actor) {
        // table-like surfaces first (a cup on the bed looks wrong), then anything with a top
        const surface = TABLES.map((t) => [...ids].find((id) => id === t || shot.props.find((p: Dict) => p.id === id)?.kind === t)).find(Boolean)
          ?? [...ids].find((id) => (catalog.props as Dict)[id]?.top);
        shot.props.push({ id: a.target, kind, on: surface ?? "floor" });
        ids.add(a.target);
        if (HANDLED.has(a.do) && !actor.holds) actor.holds = a.target;
        problems.push(`added the ${kind} it uses`);
      }
    }
    if (!a || !has(catalog.actions, a.do) || !inShot.has(String(a.who ?? "").toLowerCase())) { problems.push(`action dropped: ${JSON.stringify(a)?.slice(0, 60)}`); continue; }
    // narration carries the words: characters do not get speech captions in a narrated video
    if (a.do === "say" || a.do === "think") continue;
    const act: Dict = { at: Math.max(0, Math.min(secs - 0.3, Number(a.at) || 0)), who: String(a.who).toLowerCase(), do: a.do };
    // "put the book on the phone": things go down on a surface - the nearest table-like one in the shot
    if (a.do === "put" && typeof a.target === "string" && !isSurface(a.target, shot)) {
      const table = TABLES.map((t) => [...ids].find((id) => id === t || shot.props.find((p: Dict) => p.id === id)?.kind === t)).find(Boolean);
      problems.push(`put on "${a.target}" (not a surface) -> ${table ?? "the floor"}`);
      a.target = table;
    }
    if (typeof a.target === "string") {
      const t = a.target.toLowerCase() === "camera" ? "camera" : a.target;
      if (t === "camera" || ids.has(t) || inShot.has(t.toLowerCase())) act.target = inShot.has(t.toLowerCase()) ? t.toLowerCase() : t;
      else { problems.push(`target "${a.target}" not in the shot`); continue; }
    }
    if (typeof a.to === "number" && a.to >= 0 && a.to <= 1) act.to = a.to;
    else if (has(["left", "right"], a.to)) act.to = a.to;
    if (typeof a.spot === "number" && a.spot >= 0 && a.spot <= 1) act.spot = a.spot;
    if (has(catalog.poses, a.pose)) act.pose = a.pose;
    if (has(catalog.moods, a.mood)) act.mood = a.mood;
    if (typeof a.dur === "number" && a.dur >= 0.2) act.dur = Math.min(20, a.dur);
    shot.actions.push(act);
  }

  const cam = (r.camera ?? {}) as Dict;
  shot.camera = {
    shot: has(catalog.shotSizes, cam.shot) ? cam.shot : "wide",
    move: has(catalog.moves, cam.move) ? cam.move : "static",
    feel: has(catalog.feels, cam.feel) ? cam.feel : "steady",
  };
  const on = (Array.isArray(cam.on) ? cam.on : cam.on !== undefined ? [cam.on] : []).map((x: unknown) => String(x)).filter((x: string) => ids.has(x) || inShot.has(x.toLowerCase())).map((x: string) => (inShot.has(x.toLowerCase()) ? x.toLowerCase() : x));
  if (on.length) shot.camera.on = on.length === 1 ? on[0] : on;
  return { shot, problems };
}

/** the words the AI uses for things, in the director's kinds */
const SYNONYMS: Record<string, string> = {
  cup: "mug", tea: "mug", coffee: "mug", chai: "mug", water: "bottle", alarm: "alarm-clock", mobile: "phone", smartphone: "phone",
  books: "book-stack", textbook: "book", diary: "notebook", copy: "notebook", schoolbag: "bag", backpack: "bag", letter: "paper",
};
const TABLES = ["desk", "table", "nightstand", "counter", "kitchen-counter", "tv-stand", "wall-shelf", "bench"];
/** can things be put on it? (a place's own furniture by its id, or a prop by its kind) */
const isSurface = (id: string, shot: Dict) => {
  const kind = shot.props.find((p: Dict) => p.id === id)?.kind ?? id;
  return id === "floor" || id === "counter" || id === "desk" || !!(catalog.props as Dict)[kind]?.top;
};
/** actions done with a thing in the hand: an added thing starts there */
const HANDLED = new Set(["use", "drink", "eat", "put", "give", "write"]);

/** Who holds what when a shot ends (from `holds`, picks, puts and hand-overs). */
export function heldAtEnd(shot: Dict): Map<string, Dict> {
  const props = new Map<string, Dict>((shot.props ?? []).map((p: Dict) => [p.id, p]));
  const held = new Map<string, Dict>();
  for (const c of shot.cast ?? []) if (c.holds && props.has(c.holds)) held.set(c.id, props.get(c.holds)!);
  for (const a of [...(shot.actions ?? [])].sort((x: Dict, y: Dict) => x.at - y.at)) {
    if (a.do === "pick" && props.has(a.target)) held.set(a.who, props.get(a.target)!);
    else if (a.do === "put" || a.do === "fall") held.delete(a.who);
    else if (a.do === "give" && held.has(a.who)) { held.set(a.target, held.get(a.who)!); held.delete(a.who); }
  }
  return held;
}

/**
 * Continuity of hands between consecutive shots: "she had the cup in her hand" then "she put it on the table" - when someone
 * puts down, hands over or uses something without picking it up first, they still hold what the previous shot ended with.
 */
export function carryHolds(prev: Dict | undefined, shot: Dict): string[] {
  if (!prev) return [];
  const before = heldAtEnd(prev), fixed: string[] = [];
  const picked = new Set<string>();
  for (const a of [...shot.actions].sort((x: Dict, y: Dict) => x.at - y.at)) {
    if (a.do === "pick") picked.add(a.who);
    const actor = shot.cast.find((c: Dict) => c.id === a.who), carried = before.get(a.who);
    if (!actor || actor.holds || picked.has(a.who) || !carried || !HANDLED.has(a.do)) continue;
    // "use the laptop" is not about the cup in the hand
    if ((a.do === "use" || a.do === "drink" || a.do === "eat" || a.do === "write") && a.target && a.target !== carried.id) continue;
    if (!shot.props.find((p: Dict) => p.id === carried.id)) shot.props.push({ id: carried.id, kind: carried.kind, on: "floor" });
    actor.holds = carried.id;
    fixed.push(`${a.who} still holds the ${carried.kind}`);
  }
  return fixed;
}

/** visuals that teach (the explainer channels' panels, a real photo): a beat that has one keeps it instead of a shot */
export const INFO_PANELS = ["steps", "flow", "code", "terminal", "browser", "compare", "counter", "chart", "progress", "table", "alert", "news", "photo", "svg", "container", "quiz"];
export const hasInfoPanel = (visual: Dict | undefined) => !!visual && INFO_PANELS.some((k) => visual[k] !== undefined && visual[k] !== null);

const secsFor = (text: string) => Math.max(1.5, countWords(text) / WORDS_PER_SEC);

export function buildCastPrompt(beats: string[]): string {
  return `You are the casting director of an animated short story film. Read the story and design its characters.
Output ONLY JSON: { "skin": one of ${catalog.avatar.skin.join("|")}, "cast": [ { "id": short lowercase id (e.g. "raju", "maa"), "age", "gender", "build", "hair", "hairColor"?: "#hex", "beard"?, "glasses"?: true|false, "outfit", "top": "#hex", "bottom"?: "#hex" } ] }
At most 5 characters: the ones that appear on screen. Choose looks that fit the story (Indian setting unless the story says otherwise: kurta, saree, school uniform...).
Allowed: age ${catalog.avatar.age.join("/")}; gender ${catalog.avatar.gender.join("/")}; build ${catalog.avatar.build.join("/")}; hair ${catalog.avatar.hair.join("/")}; beard ${catalog.avatar.beard.join("/")}; outfit ${catalog.avatar.outfit.join("/")}.
Use skin "silhouette" for a dark cinematic look, or one skin tone for everyone (light/medium/tan/dark).

STORY:
${beats.join(" ")}`;
}

export function buildShotsPrompt(beats: string[], idxs: number[], cast: Map<string, Dict>): string {
  const castList = [...cast.entries()].map(([id, look]) => `- ${id}: ${JSON.stringify(look)}`).join("\n");
  const before = beats.slice(Math.max(0, idxs[0] - 3), idxs[0]).join(" ");
  return `You stage an animated story film, one short shot per narrated line. A narrator speaks every line; your shot shows what the line describes, acted out by the characters. Never put the narration on screen and never give characters speech: no "say"/"think", no captions.
Output ONLY JSON: { "shots": [ { "i": line number, "shot": { "place", "time"?, "props"?: [...], "cast": [...], "actions": [...], "camera": {...} } } ] }

SHOT FIELDS (words only, never coordinates; the engine places everything physically)
- place, time ("day"|"dusk"|"night"|"rain"), optional furnish:false for an empty room.
- props: [{ id, kind, on, at, label?, lit? }]: "on" is "floor", "wall", or the id of a thing with a surface. A place's own furniture already exists (ids below): refer to it, never re-add it.
- cast: [{ id, at: 0-1 across the screen, row?: "back"|"mid"|"front", facing?: "left"|"right", mood?, sitOn?, lieOn?, holds?, enter?: "left"|"right" }]. Use only these characters (their looks are fixed):
${castList}
- actions: [{ at: seconds into the shot, who, do, target?, to?, spot?, pose?, mood?, dur? }]
    walk/run (target a prop or person, or to: 0-1 / "left" / "right"), enter, exit, sit (target a seat), stand, lie / sleep (target a bed or sofa), wake,
    pick (a small thing), put (target a surface id), give (target a person; must be holding something), use (laptop, phone, book), write, press, switch,
    look / face (target, or "camera"), pose, mood, jump, dance, clap, kneel, pray, hug (target a person), fall, drink / eat (target a cup, bottle, food), nod, shake, point / wave (target), bow.
  A person picks only with free hands; put/give only when holding. One person's actions happen in order; leave time for walking (about 1.5 s across a room).
- camera: { shot: "wide"|"full"|"medium"|"close"|"detail", on: id or [ids], move: "static"|"push-in"|"pull-out"|"pan-left"|"pan-right"|"follow", feel?: "steady"|"handheld" }

SHOW THE LINE LITERALLY: every object the line mentions is a prop (phone, cup -> mug, book, bag, alarm clock -> alarm-clock, tea -> mug...) and the character really uses it: "sitting with the phone" = cast sitOn "chair" + holds "phone" (or use "phone"); "put the cup on the table" = holds "cup" at the start, then put. Give people something to DO in almost every shot (an action, a pose or a mood change); a line that only sets the scene may have no people at all (cast: []) - e.g. the clock on the wall at night with a slow push-in.
CONTINUITY: consecutive lines in the same place keep the place, props and where people are: start each shot the way the previous one ended (who is sitting where, who holds what - use sitOn / lieOn / holds). Vary the camera from line to line like an editor (establishing wide, then medium/close on faces, detail on an important object).

VOCABULARY (use only these words)
${catalog.text}

Each line's time on screen is given in seconds: fit the actions inside it.
${before ? `\nTHE STORY SO FAR (context only): ${before}\n` : ""}
LINES TO STAGE:
${idxs.map((i) => `${i}. (${secsFor(beats[i]).toFixed(1)} s) ${beats[i]}`).join("\n")}`;
}

/** Runs `tasks` with at most `limit` in flight. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) { const k = next++; if (k >= tasks.length) return; out[k] = await tasks[k](); }
  }));
  return out;
}

export interface DirectorShotsResult { cast: number; staged: number; beats: number; repaired: number }

/**
 * Adds a director shot to every beat it can. Never throws for AI trouble: whatever could not be staged keeps its normal visual.
 */
export async function addDirectorShots(
  plan: StickmanPlan,
  ask: (prompt: string) => Promise<string>,
  log: (msg: string) => void = () => {},
  batch = 8,
): Promise<DirectorShotsResult> {
  const beats = plan.scenes.map((s) => s.text);
  const result: DirectorShotsResult = { cast: 0, staged: 0, beats: beats.length, repaired: 0 };
  let cast = new Map<string, Dict>();
  try { cast = sanitizeCast(parseAiJson<any>(await ask(buildCastPrompt(beats)))); } catch (err: any) { log(`director: cast design failed (${err.message})`); }
  result.cast = cast.size;
  if (!cast.size) { log("director: no cast, keeping the normal visuals"); return result; }
  log(`director: cast ${[...cast.keys()].join(", ")}`);

  // only beats without a teaching panel are staged (the AI is not even asked about the others)
  const stageable = beats.map((_, i) => i).filter((i) => !hasInfoPanel(plan.scenes[i].visual as Dict));
  result.beats = stageable.length;
  if (!stageable.length) { log("director: every beat carries an information panel, nothing to stage"); return result; }
  const groups = Array.from({ length: Math.ceil(stageable.length / batch) }, (_, g) => stageable.slice(g * batch, g * batch + batch));
  await pool(groups.map((idxs) => async () => {
    let parsed: any;
    try { parsed = parseAiJson<any>(await ask(buildShotsPrompt(beats, idxs, cast))); } catch (err: any) { log(`director: beats ${idxs[0]}-${idxs[idxs.length - 1]} not staged (${err.message})`); return; }
    const got: any[] = Array.isArray(parsed?.shots) ? parsed.shots : [];
    let prev: Dict | undefined;
    got.map((entry, pos) => ({ entry, i: Number.isInteger(entry?.i) && idxs.includes(entry.i) ? entry.i : idxs[pos] }))
      .filter((x) => x.i !== undefined).sort((a, b) => a.i - b.i)
      .forEach(({ entry, i }) => {
      const { shot, problems } = sanitizeShot(entry?.shot ?? entry, cast, secsFor(beats[i]));
      if (shot && prev && prev.place === shot.place) problems.push(...carryHolds(prev, shot));
      if (shot) prev = shot;
      // a shot with nobody in it is fine when it shows something (setting the scene); an empty place is not
      if (!shot || (!shot.cast.length && !shot.props.length && !(catalog.placeThings as Dict)[shot.place]?.length)) return;
      if (problems.length) { result.repaired++; log(`director: beat ${i} repaired: ${problems.slice(0, 3).join("; ")}`); }
      (plan.scenes[i].visual as Dict).shot = shot;
      result.staged++;
    });
  }), 4);
  log(`director: ${result.staged}/${stageable.length} story beats staged as film shots (${beats.length - stageable.length} keep their information panel; ${result.repaired} repaired)`);
  return result;
}
