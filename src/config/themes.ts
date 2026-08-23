// Content themes: per-niche prompt fragments used to build all AI metadata prompts.
// A channel profile picks its theme via the NICHE / <PREFIX>_NICHE env var (default "tech").

export interface ContentTheme {
  niche: string;
  // e.g. "a tech/programming YouTube Shorts channel" — dropped into the metadata prompts
  channelDescriptor: string;
  titleRules: string;
  descriptionRules: (brandName: string) => string;
  // tags/hashtags instruction for the vision + viral prompts
  keywordsRule: string;
  // content-analysis instruction: fact-check rules (tech) vs story-analysis rules (stories)
  analysisRules: string;
  // whether to append the "🤖 Tech Fact Check Verdict: …" line to descriptions
  appendVerdict: boolean;
  // hashtag (without #) force-inserted into description/tags by ensureRequiredHashtags
  requiredHashtag: string;
  // ViralAnalyzer hint used when there is no upload history yet
  noHistoryHint: string;
  fallback: { title: string; description: string; tags: string[] };
}

export function createCustomTheme(nicheRaw: string, brandName?: string): ContentTheme {
  const niche = (nicheRaw || "general").toLowerCase().trim();
  const cleanTag = niche.replace(/[^a-z0-9]/g, "");

  return {
    niche,
    channelDescriptor: `a viral ${niche} YouTube Shorts & Instagram Reels channel focused on high-engagement ${niche} content`,
    titleRules: `TITLE RULES: Max 65 chars. Punchy, high-CTR ${niche} hook within first 30 chars. One emoji. No clickbait without delivery.`,
    descriptionRules: (brand: string) =>
      `DESCRIPTION RULES: 120-220 words. Include: 1) What happens in this ${niche} clip. 2) Key takeaway or highlight. 3) Subscribe/Follow CTA for @${brand || brandName || "channel"}. 4) Question to audience. 5) Popular #${cleanTag} and #${cleanTag}shorts hashtags on the last line. Use \\n\\n for paragraph breaks.`,
    keywordsRule: `Provide 1 primary keyword, 5 secondary keywords, 15 tags, and 8-12 hashtags (always include #${cleanTag} #shorts #viral).`,
    analysisRules: `CONTENT RULES: Identify the core theme, key moments, and emotional resonance in this ${niche} video. Set appropriate mood ("funny", "sad", "technical", or "other").`,
    appendVerdict: false,
    requiredHashtag: cleanTag || "shorts",
    noHistoryHint: `No historical uploads data yet. Prefer curiosity-driven, high-retention ${niche} hooks with relatable pacing.`,
    fallback: {
      title: `Amazing ${niche.charAt(0).toUpperCase() + niche.slice(1)} Clip You Must Watch 🔥`,
      description: `Check out this incredible ${niche} video! Follow for daily ${niche} updates and share your thoughts in the comments.\n\n#${cleanTag} #shorts #viral`,
      tags: [cleanTag, niche, "shorts", "viral", "trending", "video"],
    },
  };
}

const techTheme: ContentTheme = {
  niche: "tech",
  channelDescriptor: "a tech/programming YouTube Shorts channel",
  titleRules: `TITLE RULES: Max 65 chars. Primary keyword within first 30 chars. Curiosity without clickbait. Use current year if relevant. One emoji. No ALL CAPS (except AI, API, etc).`,
  descriptionRules: (brandName: string) =>
    `DESCRIPTION RULES: 180-300 words. Include, in this exact order: 1) What the video is about (primary keyword in first sentence). 2) What you'll learn (bullet points). 3) Who it's for. 4) The Fact Check Score (out of 10) along with the Verdict and Reasoning. 5) Subscribe CTA to @${brandName}. 6) Community CTA question. 7) End with popular hashtags on the last line — ALWAYS include #science among them. IMPORTANT: You MUST use \\n\\n to create paragraph breaks between sections.`,
  keywordsRule: `Provide 1 primary keyword, 5 secondary keywords, 15 tags, and 8-12 hashtags (always include #science).`,
  analysisRules: `FACT CHECK RULES: Analyze the code, claims, or technical text in the image. Determine if it is true, false, misleading, or a joke. Provide a factCheckScore (1-10, where 10 is 100% accurate) and a short verdict (e.g., "Mostly True", "False - Syntax Error", "Satire/Meme", "Accurate").`,
  appendVerdict: true,
  requiredHashtag: "science",
  noHistoryHint:
    "No historical uploads data yet. Prefer curiosity-driven programming/tech hooks with high contrast words (e.g. 'replace developers', '10x faster', 'cheat code').",
  fallback: {
    title: "Mind-Blowing Tech Trick You Need To Know ⚡",
    description:
      "Level up your skills with this essential tip every developer should know. Drop a 🔥 if you found this useful!\n\n#coding #programming #developer #tech #shorts #science",
    tags: [
      "coding",
      "programming",
      "developer",
      "tech",
      "shorts",
      "learntocode",
      "webdev",
      "science",
    ],
  },
};

const storiesTheme: ContentTheme = {
  niche: "stories",
  channelDescriptor:
    "a storytelling YouTube Shorts channel posting emotional, suspense, moral and feel-good short stories in a Hinglish voice",
  titleRules: `TITLE RULES: Max 65 chars. Open with an emotional or suspense hook in the first 30 chars (e.g. "Ek chhoti si kahani…", "She opened the door and…"). Hinglish (Hindi + English mix) preferred. Build curiosity but NEVER spoil the ending. One emoji. No ALL CAPS words.`,
  descriptionRules: (brandName: string) =>
    `DESCRIPTION RULES: 150-250 words, Hinglish voice. Include, in this exact order: 1) A one-line hook restating the story's premise (primary keyword in first sentence). 2) A short teaser of what happens — build emotion, never reveal the ending. 3) The feeling or lesson viewers will take away (the moral, if any). 4) Subscribe CTA to @${brandName} for daily short stories. 5) A community question asking viewers what they would do or how the story made them feel. 6) End with popular hashtags on the last line — ALWAYS include #shorts #story #storytime #kahani. IMPORTANT: You MUST use \\n\\n to create paragraph breaks between sections.`,
  keywordsRule: `Provide 1 primary keyword, 5 secondary keywords, 15 tags, and 8-12 hashtags (always include #shorts #story #storytime #kahani).`,
  analysisRules: `STORY RULES: Identify the story's genre (moral, emotional, suspense, funny, romantic), the core emotion it triggers, and the moral/lesson if present. Set mood accordingly ("funny", "sad", or "other").`,
  appendVerdict: false,
  requiredHashtag: "storytime",
  noHistoryHint:
    "No historical uploads data yet. Prefer emotional curiosity hooks and cliffhanger phrasing (e.g. 'you won't believe what happened next', 'ek kahani jo dil chhu jayegi').",
  fallback: {
    title: "Ek Kahani Jo Dil Chhu Jayegi ❤️",
    description:
      "Ek chhoti si kahani jo aapka dil chhu legi. Dekhiye aur bataiye — aap hote toh kya karte? Comment mein zaroor share kijiye!\n\n#shorts #story #storytime #kahani #hindikahani #moralstories",
    tags: [
      "story",
      "stories",
      "storytime",
      "kahani",
      "hindikahani",
      "moralstories",
      "emotionalstory",
      "shorts",
    ],
  },
};

const humorTheme: ContentTheme = {
  niche: "humor",
  channelDescriptor:
    "a viral humor, comedy memes, and funny video YouTube Shorts & Instagram channel",
  titleRules: `TITLE RULES: Max 65 chars. Punchy, funny, relatable hook. High curiosity and humor. One or two funny emojis.`,
  descriptionRules: (brandName: string) =>
    `DESCRIPTION RULES: 100-200 words. Relatable, funny commentary on the clip. Tag your friends CTA. Follow @${brandName} for daily comedy & funny clips! End with popular funny hashtags.`,
  keywordsRule: `Provide 1 primary keyword, 5 secondary keywords, 15 tags, and 8-12 hashtags (always include #shorts #funny #memes #comedy).`,
  analysisRules: `HUMOR RULES: Identify the comedy premise, meme joke, or punchline. Set mood to "funny".`,
  appendVerdict: false,
  requiredHashtag: "memes",
  noHistoryHint:
    "No historical uploads data yet. Prefer relatable high-humor hooks.",
  fallback: {
    title: "Wait For It 😂💀",
    description:
      "Tag someone who needs to see this! Follow for more daily laughs. Drop a 😂 if you laughed!\n\n#shorts #funny #memes #comedy #viral",
    tags: ["funny", "memes", "comedy", "viral", "shorts", "humor", "lol"],
  },
};

export const CONTENT_THEMES: Record<string, ContentTheme> = {
  tech: techTheme,
  stories: storiesTheme,
  humor: humorTheme,
};

