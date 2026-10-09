/**
 * Doodle asset catalogue: the names of every hand-drawn vector asset the "scene" panel can place, plus the words that
 * make an asset a good illustration of a sentence. Pure data (no React) so scripts and the shorts-automation app can
 * import / mirror it. Add the drawing in assets.tsx whenever you add a name here (a test keeps the two in step).
 */

export const SCENE_BACKGROUNDS = ["paper", "sky", "night", "room", "lab"] as const;
export type SceneBackground = (typeof SCENE_BACKGROUNDS)[number];

export const SCENE_TINTS = ["red", "blue", "green", "gold", "gray"] as const;
export type SceneTint = (typeof SCENE_TINTS)[number];

/** asset name -> words (lower case, matched at a word start) that call for it */
export const ASSET_KEYWORDS = {
  // tech
  server: ["server", "servers", "data center", "data centre", "datacenter", "datacentre", "hosting", "backend", "rack", "infrastructure", "hardware"],
  laptop: ["laptop", "computer", "developer", "coding", "code", "program", "software", "app", "website", "browser", "screen"],
  phone: ["phone", "smartphone", "mobile", "android", "iphone", "device"],
  cloud: ["cloud", "online", "internet", "saas", "stream", "upload", "download"],
  database: ["database", "data", "storage", "sql", "records", "table", "store", "stores", "stored"],
  chip: ["chip", "chips", "processor", "cpu", "gpu", "gpus", "silicon", "semiconductor", "transistor", "tpu"],
  robot: ["ai", "robot", "chatbot", "chatgpt", "model", "models", "llm", "gpt", "machine learning", "neural", "automation", "automated"],
  wifi: ["wifi", "wi-fi", "wireless", "signal", "network", "5g", "connection", "connect", "bandwidth"],
  plug: ["plug", "plugged", "cable", "charger", "charging", "outlet", "socket"],
  bolt: ["electricity", "electric", "power", "energy", "watt", "watts", "kwh", "gwh", "mwh", "voltage", "current", "grid"],
  battery: ["battery", "batteries", "charge", "lithium", "ev"],
  // security
  lock: ["lock", "locked", "secure", "security", "private", "privacy", "encrypt", "encrypted", "password", "protect", "protected"],
  shield: ["shield", "safe", "safety", "defense", "defence", "firewall", "antivirus", "trust", "trusted", "guard"],
  // analytics / ideas
  chart: ["chart", "growth", "grows", "grow", "increase", "increases", "rise", "rises", "rising", "trend", "statistics", "percent", "rate", "demand", "scale"],
  document: ["document", "report", "paper", "file", "files", "text", "article", "script", "log", "logs", "notes"],
  magnifier: ["search", "find", "analyze", "analyse", "analysis", "inspect", "check", "detect", "scan", "look", "investigate", "debug"],
  clock: ["time", "hour", "hours", "minute", "minutes", "second", "seconds", "daily", "month", "monthly", "year", "years", "speed", "fast", "latency", "delay", "schedule"],
  money: ["money", "cost", "costs", "price", "pay", "paid", "dollar", "dollars", "salary", "revenue", "profit", "budget", "cheap", "expensive"],
  brain: ["brain", "think", "thinking", "learn", "learning", "memory", "mind", "reasoning", "intelligence", "understand", "knowledge"],
  bulb: ["idea", "ideas", "insight", "why", "because", "reason", "solution", "tip", "trick", "smart", "innovation", "discover"],
  // physical world
  drop: ["water", "liquid", "coolant", "cooling", "cooled", "evaporate", "evaporated", "evaporation", "rain", "wet", "drink", "moisture", "fluid"],
  fire: ["fire", "burn", "burns", "hot", "heat", "heated", "overheat", "overheating", "flame", "thermal"],
  thermometer: ["temperature", "thermometer", "degrees", "celsius", "warm", "warming", "climate", "cool"],
  fan: ["fan", "fans", "airflow", "ventilation", "cooling system", "air conditioning", "blower"],
  factory: ["factory", "industry", "industrial", "manufacture", "manufacturing", "production", "plant", "emissions", "pollution"],
  tower: ["cooling tower", "power plant", "nuclear", "steam", "reactor", "turbine house"],
  city: ["city", "cities", "urban", "town", "skyline", "building", "buildings", "office", "company", "companies", "enterprise"],
  globe: ["world", "global", "globally", "worldwide", "earth", "planet", "international", "country", "countries", "everywhere"],
  tree: ["tree", "trees", "forest", "nature", "environment", "green", "carbon", "sustainable", "sustainability", "planet"],
  sun: ["sun", "solar energy", "sunlight", "daytime", "sunny", "renewable"],
  house: ["house", "home", "homes", "household", "residential", "family", "families", "apartment"],
  car: ["car", "cars", "vehicle", "drive", "driving", "transport", "traffic", "road"],
  solar: ["solar", "solar panel", "solar panels", "photovoltaic", "renewables"],
  turbine: ["wind", "turbine", "wind turbine", "windmill"],
  // people & status
  person: ["person", "people", "user", "users", "customer", "customers", "human", "humans", "someone", "everyone", "you", "client", "team"],
  "person-worried": ["worried", "problem", "problems", "risk", "risks", "fear", "struggle", "struggling", "confused", "stress"],
  "person-happy": ["happy", "success", "win", "wins", "celebrate", "benefit", "benefits", "enjoy", "improve", "improves", "better"],
  warning: ["warning", "danger", "dangerous", "error", "errors", "fail", "fails", "failure", "crash", "bug", "bugs", "risk", "threat", "attack", "hack", "breach"],
  check: ["correct", "true", "verified", "works", "working", "done", "complete", "completed", "success", "passes", "valid", "approved"],
  cross: ["wrong", "false", "fake", "myth", "incorrect", "no", "never", "blocked", "denied", "rejected", "invalid", "stop"],
  rocket: ["launch", "launches", "boost", "faster", "startup", "start", "begin", "ship", "deploy", "deployed", "release", "released", "space"],
  flag: ["goal", "goals", "target", "milestone", "finish", "result", "outcome", "mission", "win", "first"],
  gear: ["process", "processes", "engine", "settings", "configure", "configuration", "mechanism", "works by", "operate", "operates", "system", "systems", "machine"],
} as const;

export type SceneAsset = keyof typeof ASSET_KEYWORDS;
export const SCENE_ASSETS = Object.keys(ASSET_KEYWORDS) as [SceneAsset, ...SceneAsset[]];

/** Background that fits the topic (first match wins). */
export const BACKGROUND_KEYWORDS: [SceneBackground, string[]][] = [
  ["night", ["night", "dark", "sleep", "midnight", "evening", "moon", "stars"]],
  ["sky", ["outdoor", "outside", "nature", "sun", "weather", "wind", "forest", "world", "planet", "city", "solar", "tree", "environment", "climate", "global"]],
  ["room", ["home", "house", "office", "room", "desk", "family", "team", "meeting"]],
  ["lab", ["data", "server", "chip", "ai", "model", "research", "experiment", "science", "test", "lab", "analysis", "cooling", "system", "network", "cloud", "code", "software", "database"]],
];
