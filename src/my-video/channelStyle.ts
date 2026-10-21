/**
 * How a channel's videos LOOK. "stickman" = the CodeOrCap explainer (one stickman, panels, doodles). The others use the storyboard engine
 * with a cast of characters and a background per place: "story" (Storiyum), "finance" (Prompt Gag: bank, markets, a big figure per scene)
 * and "news" (InfoOnSpot: newsroom, breaking badge, headline bar). CHANNEL_STYLES="storiyum:story,prompt_gag:finance" overrides, "off" = all stickman.
 */
export type VisualStyle = "stickman" | "story" | "finance" | "news";
const DEFAULTS: Record<string, VisualStyle> = { storiyum: "story", prompt_gag: "finance", infoonspot: "news" };

export function visualStyleFor(channelKey: string | undefined, env: NodeJS.ProcessEnv = process.env): VisualStyle {
  if (!channelKey) return "stickman";
  const raw = (env.CHANNEL_STYLES ?? "").trim().toLowerCase();
  if (["off", "none", "0", "false"].includes(raw)) return "stickman";
  const map: Record<string, VisualStyle> = { ...DEFAULTS };
  for (const part of raw.split(",")) {
    const [k, v] = part.split(":").map((x) => x.trim());
    if (k && (v === "stickman" || v === "story" || v === "finance" || v === "news")) map[k] = v;
  }
  return map[channelKey.toLowerCase()] ?? "stickman";
}
