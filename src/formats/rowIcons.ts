import fs from "fs";
import path from "path";

/**
 * One icon per list-card row, picked by what the row is about (AI Engineer -> bot, Specialist Doctor -> stethoscope).
 * The icons are a curated set of Lucide icons (ISC licence, assets/icons/LICENSE-lucide.txt) stored in the repo, so a card
 * needs no extra AI picture and no download: the only generated picture stays the card's background.
 */

interface IconEntry { svg: string; tags: string[] }

const ICON_FILE = path.join(__dirname, "../../assets/icons/lucide-icons.json");
let icons: Record<string, IconEntry> | null = null;
const load = (): Record<string, IconEntry> => (icons ??= fs.existsSync(ICON_FILE) ? JSON.parse(fs.readFileSync(ICON_FILE, "utf8")) : {});

/** Topic words -> icon, checked first and in order (the tags alone pick odd icons for job titles). */
const RULES: [RegExp, string][] = [
  [/\b(data scien\w*|data analy\w*|analytics|big data)\b/i, "chart-pie"],  // before AI: "Data Scientist / Machine Learning Engineer" is a data job
  [/\b(ai|artificial intelligence|machine learning|ml|llm|chatgpt|gpt|robot\w*|automation)\b/i, "bot"],
  [/\b(database|sql|dba)\b/i, "database"],
  [/\b(cloud|aws|azure|gcp)\b/i, "cloud"],
  [/\b(devops|sre|site reliability|kubernetes|docker|infrastructure)\b/i, "server"],
  [/\b(cyber\w*|security|ethical hack\w*|infosec)\b/i, "shield-check"],
  [/\b(blockchain|web3|crypto\w*|bitcoin)\b/i, "blocks"],
  [/\b(software|developer|programmer|coder|coding|full ?stack|backend|frontend|engineer(ing)? (in )?it)\b/i, "code"],
  [/\b(product manager|project manager|scrum|manager)\b/i, "target"],
  [/\b(invest\w* bank\w*|banker|banking|bank)\b/i, "landmark"],
  [/\b(chartered accountant|accountant|ca\b|audit\w*|tax)\b/i, "calculator"],
  [/\b(consult\w*|strategy|advisor)\b/i, "briefcase"],
  [/\b(doctor|surgeon|physician|medical|mbbs|specialist doctor|health)\b/i, "stethoscope"],
  [/\b(nurse|hospital|clinic)\b/i, "hospital"],
  [/\b(pharma\w*|medicine|chemist)\b/i, "pill"],
  [/\b(lawyer|legal|advocate|judge|law)\b/i, "scale"],
  [/\b(pilot|airline|aviation|flight)\b/i, "plane"],
  [/\b(teacher|professor|education|tutor|coaching|course)\b/i, "graduation-cap"],
  [/\b(design\w*|ui|ux|graphic|artist)\b/i, "palette"],
  [/\b(marketing|ads?|advertis\w*|social media|influencer)\b/i, "megaphone"],
  [/\b(sales|selling|retail|shop|store|kirana)\b/i, "store"],
  [/\b(e-?commerce|online store|dropship\w*)\b/i, "shopping-cart"],
  [/\b(food|restaurant|cafe|cloud kitchen|chef|catering|tiffin)\b/i, "utensils"],
  [/\b(tea|chai|coffee)\b/i, "coffee"],
  [/\b(franchise|business|startup|company|enterprise)\b/i, "building-2"],
  [/\b(real estate|property|rent\w*|house|flat)\b/i, "key"],
  [/\b(farm\w*|agri\w*|crop|tractor)\b/i, "sprout"],
  [/\b(lemon|citrus|fruit)\b/i, "citrus"],
  [/\b(transport|logistics|delivery|truck|courier)\b/i, "truck"],
  [/\b(car|auto\w*|vehicle|cab|taxi)\b/i, "car"],
  [/\b(manufactur\w*|factory|production)\b/i, "factory"],
  [/\b(construction|civil|builder)\b/i, "hard-hat"],
  [/\b(electric\w*|solar|energy|power|ev)\b/i, "zap"],
  [/\b(video|youtube|film|content creat\w*|editor)\b/i, "video"],
  [/\b(photo\w*|camera)\b/i, "camera"],
  [/\b(writ\w*|copywrit\w*|blog\w*|author)\b/i, "pen-tool"],
  [/\b(salary|income|pay|earning|ctc|lpa|package)\b/i, "badge-indian-rupee"],
  [/\b(saving\w*|save|piggy)\b/i, "piggy-bank"],
  [/\b(loan|emi|credit card|credit)\b/i, "credit-card"],
  [/\b(profit|growth|return\w*|sip|mutual fund|stock\w*|share market)\b/i, "trending-up"],
  [/\b(cost|investment|capital|budget|price|fee)\b/i, "wallet"],
  [/\b(time|hours?|months?|years?|duration)\b/i, "clock"],
  [/\b(government|govt|ias|upsc|public sector)\b/i, "landmark"],
  [/\b(phone|mobile|app)\b/i, "smartphone"],
];

/** The icon for a row label: a topic rule, else the best match on Lucide's own tags, else a neutral spark. */
export function iconFor(label: string): string {
  const set = load();
  for (const [re, name] of RULES) if (re.test(label) && set[name]) return name;
  const words = label.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
  let best = "";
  let score = 0;
  for (const [name, e] of Object.entries(set)) {
    const hay = [name, ...e.tags].join(" ");
    const s = words.filter((w) => hay.includes(w)).length;
    if (s > score) { best = name; score = s; }
  }
  return best || (set.sparkles ? "sparkles" : Object.keys(set)[0] ?? "");
}

/** The icon as SVG, drawn in `color` inside a `size` px square at (x, y); "" when the icon set is missing. */
export function iconSvg(name: string, x: number, y: number, size: number, color: string): string {
  const e = load()[name];
  if (!e) return "";
  const s = (size / 24).toFixed(4);
  return `<g transform="translate(${x},${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${e.svg}</g>`;
}
