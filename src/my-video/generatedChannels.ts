/**
 * Channels whose Shorts are made entirely by my-video (a stickman/doodle video narrated by the cloned voice), with no footage of the
 * source reel and no extra "how it works" clip. Storiyum by default; STORIYUM_GENERATED=off brings back the reel-based Short,
 * GENERATED_SHORT_CHANNELS="a,b" picks other channels.
 */
export function isGeneratedShortChannel(channelKey: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.GENERATED_SHORT_CHANNELS ?? "storiyum").trim().toLowerCase();
  if (["", "off", "none", "0", "false"].includes(raw) || ["off", "false", "0"].includes((env.STORIYUM_GENERATED ?? "").trim().toLowerCase()) && channelKey.toLowerCase() === "storiyum") return false;
  return raw.split(",").map((s) => s.trim()).includes(channelKey.toLowerCase());
}
