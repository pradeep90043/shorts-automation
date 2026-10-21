/**
 * How a channel's videos LOOK. "stickman" = the CodeOrCap explainer (one stickman, panels, doodles); "story" = a storyboard with a cast of
 * characters and a background per place (Storiyum). STORY_STYLE_CHANNELS="a,b" picks the channels, "off" turns it off.
 */
export type VisualStyle = "stickman" | "story";
export function visualStyleFor(channelKey: string | undefined, env: NodeJS.ProcessEnv = process.env): VisualStyle {
  const raw = (env.STORY_STYLE_CHANNELS ?? "storiyum").trim().toLowerCase();
  if (!channelKey || ["", "off", "none", "0", "false"].includes(raw)) return "stickman";
  return raw.split(",").map((s) => s.trim()).includes(channelKey.toLowerCase()) ? "story" : "stickman";
}
