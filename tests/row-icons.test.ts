import assert from "assert";
import { iconFor, iconSvg } from "../src/formats/rowIcons";

// a stored icon per list-card row, picked by topic (no AI picture per row)
const cases: [string, string][] = [
  ["Artificial Intelligence Engineer", "bot"],
  ["Data Scientist / Machine Learning Engineer", "chart-pie"],
  ["Cloud Architect", "cloud"],
  ["Investment Banker", "landmark"],
  ["Cybersecurity Specialist", "shield-check"],
  ["Specialist Doctor (Surgeon / Medical Specialist)", "stethoscope"],
  ["Franchise under ₹5 lakh", "building-2"],
  ["Chai stall", "coffee"],
];
for (const [label, icon] of cases) assert.strictEqual(iconFor(label), icon, label);
assert.ok(iconFor("zzzz qqqq").length > 0, "an unknown row still gets an icon");
const svg = iconSvg("bot", 100, 200, 64, "#FFB800");
assert.ok(svg.startsWith('<g transform="translate(100,200) scale(2.6667)"') && svg.includes('stroke="#FFB800"'));
assert.strictEqual(iconSvg("no-such-icon", 0, 0, 64, "#fff"), "");
console.log("✓ row icons");
