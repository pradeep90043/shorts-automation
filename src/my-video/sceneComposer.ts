import { ASSET_KEYWORDS, BACKGROUND_KEYWORDS, type SceneAsset, type SceneBackground } from "./sceneCatalog";

/**
 * Turns a sentence into a "scene" illustration spec (my-video's doodle asset library) with plain code, no AI: the
 * assets the sentence talks about, left to right in the order it mentions them, with arrows between them and the
 * sentence's own words as hand-lettered labels. "AI data centers use liquid cooling" -> server -> drop (labelled
 * "Data Centers", "Liquid").
 */

export interface SceneItem { asset: SceneAsset; x: number; y: number; size: number; label?: string }
export interface SceneArrow { from: [number, number]; to: [number, number] }
export interface SceneSpec { background: SceneBackground; items: SceneItem[]; arrows: SceneArrow[] }

/** Assets that fit almost any sentence: used only when nothing more specific matched. */
const GENERIC = new Set<SceneAsset>(["person", "gear", "check", "cross", "flag", "document", "clock", "chart", "bulb", "magnifier", "warning", "rocket", "bolt"]);
/** Matches on very common words ("AI", "model"): fine as a filler, but never worth a slot that a concrete thing could take. */
const WEAK = new Set<SceneAsset>(["robot"]);
const PERSON = (a: SceneAsset): boolean => a === "person" || a === "person-worried" || a === "person-happy";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** whole-word (plural allowed) matcher for a keyword or phrase */
// \b only knows ASCII letters, so Hindi (Devanagari) words never matched: use Unicode letter/mark boundaries instead.
// Hindi inflections (पैसा/पैसे, बैंक/बैंकों) are covered by letting a keyword be followed by a few more marks/letters.
const wordRe = (kw: string): RegExp => {
  const hindi = /[\u0900-\u097F]/.test(kw);
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escape(kw).replace(/\s+/g, "\\s+")}${hindi ? "[\\p{M}\\p{L}]{0,3}" : "(?:s|es)?"}(?![\\p{L}\\p{M}\\p{N}])`, "iu");
};

/** Hindi / Hinglish words that call for an asset (the English list above only fires on English narration). */
const HINDI_KEYWORDS: Partial<Record<SceneAsset, string[]>> = {
  money: ["पैसा", "पैसे", "रुपया", "रुपये", "रुपए", "कमाई", "सैलरी", "वेतन", "कीमत", "खर्च", "बचत", "निवेश", "कर्ज", "लोन", "ईएमआई", "ब्याज", "महंगा", "सस्ता", "बजट", "मुनाफा", "नुकसान", "paisa", "paise", "rupee", "rupaye"],
  chart: ["बढ़त", "बढ़ता", "बढ़ती", "बढ़ोतरी", "ग्रोथ", "प्रतिशत", "फीसदी", "रिटर्न", "मार्केट", "शेयर", "निफ्टी", "सेंसेक्स", "मांग", "दर", "आंकड़े"],
  city: ["कंपनी", "शहर", "दफ्तर", "ऑफिस", "इमारत", "बाजार", "कारोबार", "दुकान"],
  house: ["घर", "मकान", "परिवार", "फ्लैट", "किराया"],
  clock: ["समय", "घंटा", "घंटे", "मिनट", "सेकंड", "रोज", "महीना", "महीने", "साल", "तारीख", "देर", "जल्दी", "इंतजार"],
  person: ["लोग", "इंसान", "आदमी", "ग्राहक", "आप", "तुम", "कोई", "सब", "दोस्त", "टीम"],
  "person-worried": ["चिंता", "डर", "परेशान", "टेंशन", "तनाव", "मुश्किल", "दिक्कत", "समस्या", "खतरा", "घबराहट"],
  "person-happy": ["खुश", "खुशी", "फायदा", "सफल", "सफलता", "जीत", "बेहतर", "आराम", "राहत"],
  warning: ["धोखा", "फ्रॉड", "स्कैम", "ठगी", "खतरनाक", "सावधान", "गलती", "एरर", "हैक", "चोरी", "जुर्माना"],
  lock: ["ताला", "सुरक्षित", "पासवर्ड", "प्राइवेसी", "गोपनीय", "बंद"],
  shield: ["सुरक्षा", "बचाव", "भरोसा", "बीमा", "इंश्योरेंस", "गारंटी"],
  document: ["दस्तावेज", "फॉर्म", "कागज", "रिपोर्ट", "फाइल", "नियम", "कानून", "रसीद", "बिल", "खाता", "आधार", "पैन"],
  phone: ["फोन", "मोबाइल", "स्मार्टफोन", "ऐप", "यूपीआई", "upi"],
  laptop: ["कंप्यूटर", "लैपटॉप", "वेबसाइट", "कोड", "सॉफ्टवेयर"],
  brain: ["दिमाग", "सोच", "सोचना", "समझ", "सीखना", "याद", "मन"],
  bulb: ["आइडिया", "तरीका", "वजह", "कारण", "समाधान", "ट्रिक", "राज", "सच"],
  magnifier: ["जांच", "देखिए", "ढूंढ", "खोज", "पता", "चेक"],
  check: ["सही", "सच", "पक्का", "मंजूर", "पास", "पूरा", "हो गया"],
  cross: ["गलत", "झूठ", "मिथक", "नहीं", "मना", "रोक", "रद्द", "फेल"],
  rocket: ["शुरू", "लॉन्च", "तेज", "स्टार्टअप", "उड़ान"],
  flag: ["लक्ष्य", "मंजिल", "टारगेट", "नतीजा", "पहला"],
  globe: ["दुनिया", "देश", "भारत", "विदेश", "वैश्विक"],
  car: ["गाड़ी", "कार", "बाइक", "सड़क", "ट्रैफिक"],
  fire: ["आग", "गर्मी", "गरम", "जलना"],
  drop: ["पानी", "बारिश", "तरल"],
  tree: ["पेड़", "जंगल", "प्रकृति", "हरा"],
  bolt: ["बिजली", "ऊर्जा", "पावर"],
  factory: ["फैक्ट्री", "उद्योग", "कारखाना", "उत्पादन", "प्रदूषण"],
  database: ["डेटा", "रिकॉर्ड", "डेटाबेस"],
  cloud: ["क्लाउड", "इंटरनेट", "ऑनलाइन"],
  wifi: ["नेटवर्क", "सिग्नल", "वाईफाई"],
  robot: ["एआई", "रोबोट", "चैटजीपीटी"],
  rupee: ["कैश", "नकद", "टैक्स", "जीएसटी", "महंगाई", "लाख", "करोड़", "आय"],
  bank: ["बैंक", "आरबीआई", "ऋण", "एफडी", "आईपीओ", "सेबी"],
  piggy: ["बचाना", "बचत", "एसआईपी", "म्यूचुअल फंड", "निवेश", "रिटायरमेंट", "पेंशन"],
  wallet: ["बटुआ", "वॉलेट", "खर्चा", "बिल"],
  card: ["कार्ड", "क्रेडिट कार्ड", "डेबिट कार्ड", "एटीएम", "पेमेंट", "भुगतान"],
  "gold-bar": ["सोना", "सोने", "चांदी", "गहने", "ज्वेलरी"],
  "stock-up": ["तेजी", "उछाल", "रैली", "मुनाफा"],
  "stock-down": ["गिरावट", "गिरा", "गिरता", "क्रैश", "मंदी", "घाटा", "नुकसान"],
  calculator: ["हिसाब", "गणित", "जोड़", "फॉर्मूला", "कुल"],
  receipt: ["रसीद", "इनवॉइस", "लेनदेन", "शुल्क", "चार्ज", "फीस"],
  contract: ["अनुबंध", "समझौता", "करार", "दस्तखत", "शर्तें", "पॉलिसी", "डील"],
  heart: ["प्यार", "दिल", "इश्क", "मोहब्बत", "रिश्ता", "रिश्ते", "शादी", "दोस्ती"],
  "broken-heart": ["धोखा", "दिल टूटा", "जुदाई", "ब्रेकअप", "आंसू", "उदास", "अकेला", "अकेले", "गम"],
  key: ["चाबी", "रहस्य", "राज", "सुराग", "छिपा"],
  door: ["दरवाजा", "दरवाज़ा", "दरवाजे", "प्रवेश", "मौका", "अवसर"],
  book: ["किताब", "कहानी", "पढ़ाई", "पढ़ना", "सबक", "अध्याय", "शिक्षा"],
  crown: ["राजा", "रानी", "सम्राट", "राज", "ताज", "महान", "बादशाह"],
  moon: ["चांद", "चाँद", "रात", "सपना", "सपने"],
  star: ["सितारा", "सितारे", "मशहूर", "बॉलीवुड", "अभिनेता", "अभिनेत्री", "स्टार"],
  ghost: ["भूत", "भूतिया", "डरावना", "आत्मा", "श्राप", "हॉरर"],
  castle: ["किला", "महल", "इतिहास", "प्राचीन", "मंदिर", "साम्राज्य"],
  newspaper: ["खबर", "खबरें", "समाचार", "अखबार", "सुर्खी", "मीडिया", "पत्रकार"],
  microphone: ["इंटरव्यू", "भाषण", "बयान", "पॉडकास्ट", "घोषणा", "कहा"],
  camera: ["फोटो", "तस्वीर", "वीडियो", "कैमरा", "फुटेज", "वायरल", "फिल्म", "सीसीटीवी"],
  tv: ["टीवी", "चैनल", "प्रसारण", "लाइव", "सीरियल", "शो"],
  megaphone: ["विरोध", "प्रदर्शन", "आंदोलन", "नारा", "विज्ञापन", "प्रचार"],
  gavel: ["अदालत", "कोर्ट", "जज", "न्यायाधीश", "फैसला", "मुकदमा", "सजा", "याचिका", "जमानत", "सुप्रीम कोर्ट"],
  ballot: ["वोट", "चुनाव", "मतदान", "संसद", "सरकार", "मंत्री", "पार्टी", "राजनीति", "बीजेपी", "कांग्रेस"],
  siren: ["पुलिस", "गिरफ्तार", "अपराध", "चोरी", "हत्या", "हादसा", "दुर्घटना", "एफआईआर", "जांच", "धोखाधड़ी", "ठगी", "स्कैम"],
  hospital: ["अस्पताल", "डॉक्टर", "सेहत", "बीमारी", "दवा", "मरीज", "वायरस", "कैंसर", "इलाज", "वैक्सीन"],
  school: ["स्कूल", "कॉलेज", "विश्वविद्यालय", "छात्र", "परीक्षा", "डिग्री", "शिक्षक", "नीट", "यूपीएससी"],
  airplane: ["फ्लाइट", "हवाई जहाज", "विमान", "हवाई अड्डा", "एयरलाइन", "यात्रा", "वीजा", "पासपोर्ट", "पर्यटन"],
  train: ["ट्रेन", "रेलवे", "रेल", "मेट्रो", "स्टेशन", "टिकट", "आईआरसीटीसी", "वंदे भारत"],
  cart: ["खरीद", "खरीदना", "बेचना", "सेल", "ऑर्डर", "ऑफर", "डिस्काउंट", "दुकान", "अमेज़न", "फ्लिपकार्ट"],
  trophy: ["ट्रॉफी", "पुरस्कार", "अवॉर्ड", "विजेता", "जीता", "मेडल", "चैंपियन", "ओलंपिक"],
  cricket: ["क्रिकेट", "आईपीएल", "बल्ला", "गेंदबाज", "बल्लेबाज", "विकेट", "मैच", "विराट", "धोनी", "खिलाड़ी"],
  bell: ["अलर्ट", "नोटिफिकेशन", "याद दिलाना", "सब्सक्राइब", "अपडेट", "सूचना"],
  calendar: ["तारीख", "डेडलाइन", "कैलेंडर", "आज", "कल", "हफ्ते", "त्योहार", "दिवाली", "छुट्टी", "अप्रैल", "मार्च"],
  "id-card": ["आधार", "पैन कार्ड", "पहचान", "केवाईसी", "लाइसेंस", "वोटर आईडी", "नागरिक", "पंजीकरण"],
  scales: ["न्याय", "कानून", "अधिकार", "संविधान", "नियम", "बराबरी", "तुलना"],
};

const MATCHERS: { asset: SceneAsset; kw: string; re: RegExp }[] = (Object.entries(ASSET_KEYWORDS) as [SceneAsset, readonly string[]][])
  .flatMap(([asset, kws]) => [...kws, ...(HINDI_KEYWORDS[asset] ?? [])].map((kw) => ({ asset, kw, re: wordRe(kw) })));

const titleCase = (s: string): string => s.replace(/\s+/g, " ").trim().split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

/** The assets a sentence calls for, in the order it mentions them (specific ones first when there are too many). */
export function matchAssets(text: string, max = 3): { asset: SceneAsset; word: string; index: number }[] {
  const all: { asset: SceneAsset; word: string; index: number }[] = [];
  for (const { asset, re } of MATCHERS) {
    const m = re.exec(text);
    if (m) all.push({ asset, word: m[0], index: m.index });
  }
  // "data" inside "data centers" (or "power" inside "power plants") is the longer phrase's word, not a second asset
  const free = all.filter((h) => !all.some((o) => o.asset !== h.asset && o.word.length > h.word.length && o.index <= h.index && o.index + o.word.length >= h.index + h.word.length));
  const best = new Map<SceneAsset, { asset: SceneAsset; word: string; index: number }>();
  for (const h of free) {
    const cur = best.get(h.asset);
    if (!cur || h.index < cur.index || (h.index === cur.index && h.word.length > cur.word.length)) best.set(h.asset, h);
  }
  let hits = [...best.values()];
  // one person-family asset at most (the worried / happy variant when the sentence is about feelings)
  const people = hits.filter((h) => PERSON(h.asset)).sort((a, b) => Number(a.asset === "person") - Number(b.asset === "person") || a.index - b.index);
  hits = [...hits.filter((h) => !PERSON(h.asset)), ...people.slice(0, 1)];
  const specific = hits.filter((h) => !GENERIC.has(h.asset) && !WEAK.has(h.asset));
  const pool = specific.length >= 2 ? specific : [...specific, ...hits.filter((h) => GENERIC.has(h.asset) || WEAK.has(h.asset))];
  return pool
    .sort((a, b) => a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index);
}

/** Backdrop that fits the topic (first match wins), else a plain page. */
export function backgroundFor(text: string): SceneBackground {
  for (const [bg, words] of BACKGROUND_KEYWORDS) if (words.some((w) => wordRe(w).test(text))) return bg;
  return "paper";
}

const LAYOUT: Record<number, { xs: number[]; size: number }> = {
  1: { xs: [50], size: 64 },
  2: { xs: [28, 72], size: 54 },
  3: { xs: [17, 50, 83], size: 46 },
};
/** assets stand on the floor line of the card (about 74% down), so a taller asset has a higher centre */
const FLOOR = 74;

/** The illustration for one sentence, or null when it mentions nothing the library can draw. */
export function sceneForSentence(text: string, context = ""): SceneSpec | null {
  const hits = matchAssets(text, 3);
  if (!hits.length) return null;
  const { xs, size } = LAYOUT[hits.length];
  const y = FLOOR - size / 2;
  const items: SceneItem[] = hits.map((h, i) => ({ asset: h.asset, x: xs[i], y, size, label: titleCase(h.word).slice(0, 22) }));
  // an arrow in the gap between neighbours: cause -> effect, in the order the sentence tells it
  const half = size * 0.27 + 2.5;
  const arrows: SceneArrow[] = items.slice(1).map((it, i) => ({ from: [items[i].x + half, y], to: [it.x - half, y] }));
  return { background: backgroundFor(`${text} ${context}`), items, arrows };
}
