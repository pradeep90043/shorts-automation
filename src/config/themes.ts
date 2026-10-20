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
  fallback: {
    title: string;
    description: string;
    tags: string[];
    coverCategory?: string;
    coverEmoji?: string;
    coverHeadline?: string;
  };
}

export function createCustomTheme(nicheRaw: string, brandName?: string): ContentTheme {
  const niche = (nicheRaw || "general").toLowerCase().trim();
  const cleanTag = niche.replace(/[^a-z0-9]/g, "");

  return {
    niche,
    channelDescriptor: `a viral ${niche} YouTube Shorts & Instagram Reels channel focused on high-engagement ${niche} content`,
    titleRules: `TITLE RULES: Max 65 chars. Punchy, high-CTR ${niche} hook within first 30 chars. One emoji. No clickbait without delivery.`,
    descriptionRules: (brand: string) =>
      `DESCRIPTION RULES: 120-220 words. Include: 1) What happens in this ${niche} clip. 2) Key takeaway or highlight. 3) Subscribe/Follow CTA for @${brand || brandName || "channel"}. 4) Question to audience. 5) A credit line reading exactly: "📲 CONTENT SOURCE/CREDIT: @<original_creator>\\n(Respective Owner)\\nDM FOR CREDIT OR REMOVAL". 6) Popular #${cleanTag} and #${cleanTag}shorts hashtags on the last line. Use \\n\\n for paragraph breaks.`,
    keywordsRule: `Provide 1 primary keyword, 5 secondary keywords, 15 tags, and 8-12 hashtags (always include #${cleanTag} #shorts #viral).`,
    analysisRules: `CONTENT RULES: Identify the core theme, key moments, and emotional resonance in this ${niche} video. Set appropriate mood ("funny", "sad", "technical", or "other").`,
    appendVerdict: false,
    requiredHashtag: cleanTag || "shorts",
    noHistoryHint: `No historical uploads data yet. Prefer curiosity-driven, high-retention ${niche} hooks with relatable pacing.`,
    fallback: {
      title: `Amazing ${niche.charAt(0).toUpperCase() + niche.slice(1)} Clip You Must Watch 🔥`,
      description: `Check out this incredible ${niche} video! Follow for daily ${niche} updates and share your thoughts in the comments.\n\n📲 CONTENT SOURCE/CREDIT: @creator\n(Respective Owner)\nDM FOR CREDIT OR REMOVAL\n\n#${cleanTag} #shorts #viral`,
      tags: [cleanTag, niche, "shorts", "viral", "trending", "video"],
    },
  };
}

const techTheme: ContentTheme = {
  niche: "tech",
  channelDescriptor: "a tech, science and fact-check YouTube Shorts channel (any claim that can be verified: technology, science, health, space, nature, viral claims)",
  titleRules: `TITLE RULES: Max 65 chars. Primary keyword within first 30 chars. Curiosity without clickbait. Use current year if relevant. One emoji. No ALL CAPS (except AI, API, etc).`,
  descriptionRules: (brandName: string) =>
    `DESCRIPTION RULES: 220-400 words. Include, in this exact order: 1) What the video is about (primary keyword in first sentence). 2) What you'll learn (bullet points). 2b) EVERYTHING SHOWN IN THE REEL: if the reel shows a list, ranking, set of tools, apps, commands, steps or tips, list EVERY item as its own line "• <name> — <what it is used for, one short sentence>", in the order shown, with the exact count the reel shows (e.g. all 7 AI coding tools). On screen the caption and reaction sticker hide some items, so take items from ALL the frames, the transcript, the on-screen text and the original caption, and complete them with what you know about each item. Never skip an item and never invent one that is not in the reel. 3) Who it's for. 4) The Fact Check Score (out of 10) along with the Verdict and Reasoning. 5) Subscribe CTA to @${brandName}. 6) Community CTA question. 7) A credit line reading exactly: "📲 CONTENT SOURCE/CREDIT: @<original_creator>\\n(Respective Owner)\\nDM FOR CREDIT OR REMOVAL". 8) End with popular hashtags on the last line — ALWAYS include #science among them. IMPORTANT: You MUST use \\n\\n to create paragraph breaks between sections.`,
  keywordsRule: `Provide 1 primary keyword, 5 secondary keywords, 15 tags, and 8-12 hashtags (always include #science).`,
  analysisRules: `FACT CHECK RULES: Analyze the code, scientific or factual claims, or technical text in the image. Determine if it is true, false, misleading, or a joke. Provide a factCheckScore (1-10, where 10 is 100% accurate) and a short verdict (e.g., "Mostly True", "False - Syntax Error", "Satire/Meme", "Accurate").`,
  appendVerdict: true,
  requiredHashtag: "science",
  noHistoryHint:
    "No historical uploads data yet. Prefer curiosity-driven tech and science hooks with high contrast words (e.g. 'replace developers', '10x faster', 'scientists were wrong', 'is this really true').",
  fallback: {
    title: "Mind-Blowing Tech Trick You Need To Know ⚡",
    description:
      "Level up your skills with this essential tip every developer should know. Drop a 🔥 if you found this useful!\n\n📲 CONTENT SOURCE/CREDIT: @creator\n(Respective Owner)\nDM FOR CREDIT OR REMOVAL\n\n#coding #programming #developer #tech #shorts #science",
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
    `DESCRIPTION RULES: 150-250 words, Hinglish voice. Include, in this exact order: 1) A one-line hook restating the story's premise (primary keyword in first sentence). 2) A short teaser of what happens — build emotion, never reveal the ending. 3) The feeling or lesson viewers will take away (the moral, if any). 4) Subscribe CTA to @${brandName} for daily short stories. 5) A community question asking viewers what they would do or how the story made them feel. 6) A credit line reading exactly: "📲 CONTENT SOURCE/CREDIT: @<original_creator>\\n(Respective Owner)\\nDM FOR CREDIT OR REMOVAL". 7) End with popular hashtags on the last line — ALWAYS include #shorts #story #storytime #kahani. IMPORTANT: You MUST use \\n\\n to create paragraph breaks between sections.`,
  keywordsRule: `Provide 1 primary keyword, 5 secondary keywords, 15 tags, and 8-12 hashtags (always include #shorts #story #storytime #kahani).`,
  analysisRules: `STORY RULES: Identify the story's genre (moral, emotional, suspense, funny, romantic), the core emotion it triggers, and the moral/lesson if present. Set mood accordingly ("funny", "sad", or "other").`,
  appendVerdict: false,
  requiredHashtag: "storytime",
  noHistoryHint:
    "No historical uploads data yet. Prefer emotional curiosity hooks and cliffhanger phrasing (e.g. 'you won't believe what happened next', 'ek kahani jo dil chhu jayegi').",
  fallback: {
    title: "Ek Kahani Jo Dil Chhu Jayegi ❤️",
    description:
      "Ek chhoti si kahani jo aapka dil chhu legi. Dekhiye aur bataiye — aap hote toh kya karte? Comment mein zaroor share kijiye!\n\n📲 CONTENT SOURCE/CREDIT: @creator\n(Respective Owner)\nDM FOR CREDIT OR REMOVAL\n\n#shorts #story #storytime #kahani #hindikahani #moralstories",
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
    `DESCRIPTION RULES: 100-200 words. Relatable, funny commentary on the clip. Tag your friends CTA. Follow @${brandName} for daily comedy & funny clips! Include a credit line reading exactly: "📲 CONTENT SOURCE/CREDIT: @<original_creator>\\n(Respective Owner)\\nDM FOR CREDIT OR REMOVAL". End with popular funny hashtags.`,
  keywordsRule: `Provide 1 primary keyword, 5 secondary keywords, 15 tags, and 8-12 hashtags (always include #shorts #funny #memes #comedy).`,
  analysisRules: `HUMOR RULES: Identify the comedy premise, meme joke, or punchline. Set mood to "funny".`,
  appendVerdict: false,
  requiredHashtag: "memes",
  noHistoryHint:
    "No historical uploads data yet. Prefer relatable high-humor hooks.",
  fallback: {
    title: "Wait For It 😂💀",
    description:
      "Tag someone who needs to see this! Follow for more daily laughs. Drop a 😂 if you laughed!\n\n📲 CONTENT SOURCE/CREDIT: @creator\n(Respective Owner)\nDM FOR CREDIT OR REMOVAL\n\n#shorts #funny #memes #comedy #viral",
    tags: ["funny", "memes", "comedy", "viral", "shorts", "humor", "lol"],
  },
};

// InfoOnSpot — informative tech / AI / money / social / trending "explained" reels.
// Encodes the InfoOnSpot content template: strong short headline, structured
// caption (hook → transition → bullets → reality check → takeaway → keyword CTA
// → credit → disclaimer), 5-8 hashtags, credible non-clickbait voice.
const infoOnSpotTheme: ContentTheme = {
  niche: "infoonspot",
  channelDescriptor:
    "InfoOnSpot — a fast, credible tech, AI, websites, career, and digital tools explainer channel modeled after @briefonspot and @indfeed24hr",
  titleRules: `TITLE RULES: A 5-8 word punchy ALL-CAPS headline flanked by 1-2 relevant emojis. Examples: "🤖 3 WEBSITES TO FIND REMOTE AI WORK! 🤯", "🎬 TURN LONG VIDEOS INTO SHORTS WITH AI! 🔥", "💻 GENERATE QR CODES IN MS WORD! ⚡", "🚀 THIS AI BUILDS ENTIRE WEBSITES! 👀".`,
  descriptionRules: (_brandName: string) =>
    `CAPTION RULES — follow this EXACT structure separated by \\n\\n:\n` +
    `Content taken by this page & for more follow\n@<original_creator>\n\n` +
    `[EMOJI] [PUNCHY ALL-CAPS HEADLINE] [EMOJI]\n\n` +
    `[1-2 sentence compelling summary of what happens or what this tool/update does + 👀 emoji].\n\n` +
    `[SECTION HEADER IN CAPS WITH EMOJI, e.g. 🌐 PLATFORMS TO CHECK OUT / 📚 WHAT YOU'LL LEARN / 🤖 HOW IT WORKS / ⚡ KEY HIGHLIGHTS]\n\n` +
    `• [Bullet point 1 — concise takeaway or feature]\n` +
    `• [Bullet point 2 — concise takeaway or feature]\n` +
    `• [Bullet point 3 — concise takeaway or feature]\n` +
    `• [Bullet point 4 — concise takeaway or feature]\n\n` +
    `💡 WHY THIS MATTERS\n[1-2 balanced sentences on practical utility, limitation, or reality check. Never guarantee income or overstate capabilities].\n\n` +
    `💬 WANT THE LINK / DETAILS?\nComment "KEYWORD" and check your DMs! (KEYWORD = 1 specific word tied to the tool/topic, e.g. AI / TOOL / REMOTE / PROMPT / CODE).\n\n` +
    `📌 SAVE THIS REEL\nSave it for later and share it with someone who needs this. 👇\n\n` +
    `📲 CONTENT SOURCE/CREDIT: @<original_creator>\n(Respective Owner)\nDM FOR CREDIT OR REMOVAL\n\n` +
    `Disclaimer: This content is shared for informational and educational purposes only. Tools, features, eligibility, and results can vary over time. Always verify before using or investing.\n\n` +
    `#InfoOnSpot #Tech #AI #AITools #Technology #DigitalTools #Productivity`,
  keywordsRule: `Provide 1 primary keyword, 5 secondary keywords, 15 tags, and 6-8 clean hashtags — ALWAYS include #InfoOnSpot #Tech #AI #Technology #AITools.`,
  analysisRules:
    `INFO RULES: Classify the clip into EXACTLY ONE category: AI, TECH, WEBSITES, MONEY, CAREER, or TOOLS. Extract: 1) What tool, feature, website, or news is shown. 2) 3-4 concrete bullet points explaining what it does. 3) The original creator handle (@username). 4) One short keyword for comment CTA. Set mood to "technical" for AI/Tech, "other" otherwise.`,
  appendVerdict: false,
  requiredHashtag: "InfoOnSpot",
  noHistoryHint:
    "No historical uploads data yet. Prefer clear, high-utility tool/website/AI explainers with concise bullet points and direct engagement hooks.",
  fallback: {
    title: "🤖 3 WEBSITES TO FIND REMOTE AI WORK! 🤯",
    description:
      "Content taken by this page & for more follow\n@creator\n\n" +
      "💻 3 WEBSITES TO FIND REMOTE AI WORK! 🤯\n\n" +
      "Looking for ways to build a side income online? These platforms could be worth exploring. 👀\n\n" +
      "🌐 3 PLATFORMS TO CHECK OUT\n\n" +
      "• 🤖 Platform 1: AI training, evaluation and data labeling tasks\n" +
      "• 💼 Platform 2: Connecting skilled professionals with remote tech projects\n" +
      "• 🚀 Platform 3: Specialized freelancing for modern digital creators\n\n" +
      "💡 WHY THIS MATTERS\nYou don't need huge upfront investment to start building online skills. Focus on practical opportunities that reward what you already know.\n\n" +
      '💬 WANT THE COMPLETE LIST?\nComment "REMOTE" and check your DMs! 👇\n\n' +
      "📌 SAVE THIS REEL\nSave it for later and share it with someone looking for remote work. 👇\n\n" +
      "📲 CONTENT SOURCE/CREDIT: @creator\n(Respective Owner)\nDM FOR CREDIT OR REMOVAL\n\n" +
      "Disclaimer: This content is shared for informational and educational purposes only. Platform availability, task availability, eligibility, and earnings can vary. Income is not guaranteed.\n\n" +
      "#InfoOnSpot #Tech #AI #AITools #Technology #RemoteWork #DigitalSkills",
    tags: ["infoonspot", "tech", "ai", "ai tools", "technology", "remote work", "digital tools", "explained"],
    coverCategory: "TECH",
    coverEmoji: "💻",
    coverHeadline: "3 WEBSITES FOR\nREMOTE AI WORK",
  },
};


// Prompt Gag — current market news and opinion (finance). Educational only: no advice, no promises, no stock "picks".
const financeTheme: ContentTheme = {
  niche: "finance",
  channelDescriptor:
    "a credible Indian finance explainer YouTube Shorts & Instagram channel: what is moving the market today, why, and a balanced opinion",
  titleRules: `TITLE RULES: Max 65 chars. A clear, specific hook about what happened in the market or money topic. One relevant emoji. Never promise returns, never say "buy"/"sell", no "guaranteed", no "100% profit".`,
  descriptionRules: (brandName: string) =>
    `DESCRIPTION RULES: 100-180 words. 1) What happened (facts only, from the clip). 2) Why it matters in plain words. 3) One balanced opinion that names the risk too. ` +
    `4) Follow @${brandName} for daily market updates. 5) Include a credit line reading exactly: "📲 CONTENT SOURCE/CREDIT: @<original_creator> (Respective Owner) DM FOR CREDIT OR REMOVAL". ` +
    `6) End with: "Disclaimer: Educational content only, not financial advice. Do your own research or ask a registered advisor before investing."`,
  keywordsRule: `Provide 1 primary keyword, 5 secondary keywords, 15 tags, and 6-8 hashtags (always include #shorts #finance #stockmarket #investing).`,
  analysisRules:
    `FINANCE RULES: Identify the market event, number or claim shown. Separate fact from opinion. Flag any claim of guaranteed returns, ` +
    `"sure-shot" tips or buy/sell calls as unsafe and do NOT repeat them. Never state a price or percentage the clip does not show. Set mood to "serious" or "educational".`,
  appendVerdict: false,
  requiredHashtag: "finance",
  noHistoryHint:
    "No historical uploads data yet. Prefer clear 'what happened and why' market explainers with a balanced opinion and no advice.",
  fallback: {
    title: "What Moved The Market Today 📈",
    description:
      "A quick look at what moved the market today and why it matters.\n\nFollow for daily market updates.\n\n📲 CONTENT SOURCE/CREDIT: @creator\n(Respective Owner)\nDM FOR CREDIT OR REMOVAL\n\nDisclaimer: Educational content only, not financial advice.\n\n#shorts #finance #stockmarket #investing",
    tags: ["finance", "stock market", "investing", "market update", "shorts", "money"],
  },
};

export const CONTENT_THEMES: Record<string, ContentTheme> = {
  tech: techTheme,
  stories: storiesTheme,
  humor: humorTheme,
  infoonspot: infoOnSpotTheme,
  finance: financeTheme,
};
