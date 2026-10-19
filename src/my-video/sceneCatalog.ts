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
  // finance
  rupee: ["rupee", "rupees", "inr", "currency", "cash", "income", "earn", "earning", "earnings", "rs", "lakh", "crore", "inflation", "tax", "taxes", "gst"],
  bank: ["bank", "banks", "rbi", "loan", "loans", "emi", "interest", "mortgage", "credit", "deposit", "fd", "ipo", "sebi", "nbfc", "insurance"],
  piggy: ["save", "saving", "savings", "sip", "mutual fund", "mutual funds", "invest", "investing", "investment", "investments", "retirement", "pension"],
  wallet: ["wallet", "spend", "spending", "expense", "expenses", "upi", "paytm", "bill", "bills", "rent"],
  card: ["card", "cards", "credit card", "debit card", "atm", "swipe", "payment", "payments", "checkout"],
  "gold-bar": ["gold", "silver", "bullion", "jewellery", "jewelry", "precious"],
  "stock-up": ["bull", "bullish", "rally", "surge", "surges", "soar", "soars", "gain", "gains", "profit", "profits", "all-time high", "sensex", "nifty", "stock market", "stocks"],
  "stock-down": ["crash", "crashes", "bearish", "plunge", "plunges", "fall", "falls", "falling", "drop", "drops", "loss", "losses", "recession", "slump", "decline", "declines"],
  calculator: ["calculate", "calculation", "math", "total", "sum", "percentage", "ratio", "formula", "compound"],
  receipt: ["receipt", "invoice", "purchase", "transaction", "transactions", "statement", "charge", "charges", "fee", "fees"],
  contract: ["contract", "agreement", "sign", "signed", "terms", "policy", "clause", "deal", "legal", "will"],
  // story
  heart: ["love", "heart", "romance", "relationship", "relationships", "care", "kindness", "affection", "marriage", "wedding", "friendship"],
  "broken-heart": ["heartbreak", "breakup", "betrayal", "betrayed", "cheated", "loss of love", "sad", "grief", "sorrow", "tears", "alone", "lonely"],
  key: ["key", "keys", "secret", "secrets", "unlock", "unlocked", "access", "mystery", "clue", "hidden"],
  door: ["door", "doors", "enter", "entrance", "exit", "opportunity", "gateway", "threshold", "knock"],
  book: ["book", "books", "story", "stories", "read", "reading", "chapter", "novel", "lesson", "lessons", "study", "education"],
  crown: ["king", "queen", "royal", "throne", "emperor", "empire", "ruler", "champion", "best", "number one", "legend"],
  moon: ["moon", "midnight", "dream", "dreams", "bedtime", "lunar"],
  star: ["star", "stars", "famous", "celebrity", "fame", "bollywood", "actor", "actress", "rating", "ratings", "special"],
  ghost: ["ghost", "ghosts", "haunted", "horror", "spooky", "scary", "spirit", "paranormal", "curse", "cursed"],
  castle: ["castle", "fort", "palace", "kingdom", "history", "historical", "ancient", "medieval", "temple"],
  // news / general
  newspaper: ["news", "newspaper", "headline", "headlines", "press", "media", "journalist", "breaking", "reported", "report says", "according to"],
  microphone: ["interview", "speech", "speaks", "said", "statement", "podcast", "press conference", "address", "announce", "announced", "announcement"],
  camera: ["photo", "photos", "camera", "video", "footage", "caught on camera", "viral", "recorded", "cctv", "film", "movie"],
  tv: ["tv", "television", "channel", "broadcast", "live", "show", "serial", "news channel", "ott", "netflix"],
  megaphone: ["protest", "protests", "campaign", "slogan", "rally", "advertise", "advertisement", "ad", "ads", "promotion", "viral post", "announce to"],
  gavel: ["court", "judge", "verdict", "supreme court", "high court", "trial", "lawsuit", "sentence", "sentenced", "case", "petition", "ruling", "bail"],
  ballot: ["vote", "votes", "voting", "election", "elections", "poll", "polls", "ballot", "parliament", "government", "minister", "party", "politics", "political", "bjp", "congress"],
  siren: ["police", "arrest", "arrested", "crime", "criminal", "theft", "robbery", "murder", "accident", "emergency", "fir", "investigation", "fraud", "scam", "scams"],
  hospital: ["hospital", "doctor", "doctors", "health", "disease", "medicine", "medical", "patient", "patients", "virus", "covid", "cancer", "treatment", "surgery", "vaccine"],
  school: ["school", "college", "university", "student", "students", "exam", "exams", "degree", "graduate", "graduation", "teacher", "classroom", "neet", "jee", "upsc"],
  airplane: ["flight", "flights", "airplane", "aeroplane", "plane", "airport", "airline", "travel", "tourist", "visa", "passport", "abroad", "tourism"],
  train: ["train", "trains", "railway", "railways", "metro", "station", "commute", "irctc", "ticket", "tickets", "bullet train", "vande bharat"],
  cart: ["shop", "shopping", "buy", "buying", "sale", "sell", "selling", "order", "ecommerce", "e-commerce", "amazon", "flipkart", "discount", "offer", "store"],
  trophy: ["trophy", "award", "awards", "winner", "won", "championship", "cup", "medal", "medals", "olympics", "title", "prize", "achievement"],
  cricket: ["cricket", "ipl", "bat", "bowler", "batsman", "wicket", "match", "t20", "world cup", "kohli", "dhoni", "sports", "player", "players"],
  bell: ["alert", "alerts", "notification", "notifications", "reminder", "subscribe", "alarm", "notice", "update", "updates"],
  calendar: ["date", "deadline", "schedule", "calendar", "today", "tomorrow", "week", "weekly", "season", "festival", "diwali", "holiday", "from april", "by march"],
  "id-card": ["aadhaar", "aadhar", "pan card", "identity", "id", "kyc", "licence", "license", "voter", "citizen", "registration", "profile"],
  scales: ["justice", "law", "laws", "rights", "fair", "unfair", "balance", "compare", "pros and cons", "constitution", "regulation", "rules"],
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
