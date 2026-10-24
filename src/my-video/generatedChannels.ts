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

/**
 * A YouTube Short taken as a source is only ever material: its transcript and caption feed the story, but none of its footage or
 * audio is reused. The Short is always made by my-video, whatever the channel. YOUTUBE_SOURCE_GENERATED=off turns this off.
 */
export function usesGeneratedShort(channelKey: string, sourceUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const youtubeSource = /(?:youtube\.com|youtu\.be)\//i.test(sourceUrl ?? "") && !["off", "false", "0"].includes((env.YOUTUBE_SOURCE_GENERATED ?? "").trim().toLowerCase());
  return youtubeSource || isGeneratedShortChannel(channelKey, env);
}
