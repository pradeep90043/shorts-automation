import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const baseUrl = (process.env.FREELLMAPI_URL || "http://92.4.82.192:3001").replace(/\/$/, "");
const apiKey = process.env.FREELLMAPI_KEY;
const testImage = path.join(__dirname, "../temp/gen-1782917009373-675/original.jpg");

if (!apiKey) {
  console.error("Error: FREELLMAPI_KEY is not defined in .env");
  process.exit(1);
}

if (!fs.existsSync(testImage)) {
  console.error(`Error: Test image not found at ${testImage}`);
  process.exit(1);
}

const models = [
  "auto",
  "glm-4.7",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.5-flash"
];

const prompt = `You are a computer vision assistant and growth strategist for a tech/programming YouTube Shorts channel called "CodeOrCap".

Analyze this video frame/image and perform two tasks:

TASK 1: Brand/Watermark/Content Detection
Detect the exact coordinates of any branding, watermarks, profile pictures, usernames/handles, logos, or app overlays of other creators. Also, if this image shows a full Instagram page/embed layout, detect the boundaries of the main content media box. Detect the exact bounding box of any original captions or meme text written on the image. Locate them and return their bounding boxes in normalized coordinates relative to the image size (value between 0.0 and 1.0).
Search for:
- profile picture (e.g. circle image showing a person/logo in top-left or bottom-left)
- profile name / username / handle (e.g. "@username", "username" in top-left or bottom-left)
- watermarks or logos (e.g. Instagram logo, TikTok watermark, other channel logo)
- actions panel (e.g. reels interaction panel on the right with like/comment/share icons)
- main_post_content (e.g. if the image contains a full post layout, comments, or web view headers, detect the bounding box of the central post image/media box itself, excluding headers, comments, likes, and footer chrome)
- original_captions (e.g. the main meme text/caption written on the top or center of the frame in white/black outlines)

If no such elements are present, return an empty array for brandingZones.

TASK 2: YouTube Shorts Metadata & Mood Generation
Based on the content in the image, write high-CTR, scroll-stopping, SEO-optimized metadata and identify the mood of the content.
- title: curiosity-driven, punchy, under 80 chars. Use power words and emojis.
- description: 2-3 sentences explaining the value. End with 5-6 hashtags. Max 400 chars.
- tags: 10-12 specific tags.
- mood: Determine the emotional tone or theme of the content. Choose exactly one of: "funny", "sad", or "other".

TASK 3: Verbatim Text Extraction
Read all text written on the image exactly as it appears verbatim, without correcting spelling, punctuation, or formatting. If there is no text, return an empty string.

TASK 4: Safe Area, Style Selection & Candidate Placement Detection
Evaluate the image layout for dynamic overlay caption placement. Apply ALL of these rules:

STEP 4A — Background Classification
Look at the area where the caption will be placed and classify it:
- "existing_banner" : A solid black or white horizontal banner strip (meme text block) already exists at top or bottom.
- "plain"           : The region is a solid or near-solid color, sky, clouds, blank wall, or simple cartoon background with no fine detail.
- "busy"            : The region contains characters, faces, detailed artwork, motion blur, real video footage, or complex textures.

STEP 4B — Caption Style Selector
Based on the background classification, choose ONE style:

• style2_banner_replace — USE WHEN: existing_banner is detected.
  Rule: Cover ONLY the exact pixel region of the old banner. Reuse its dimensions. No enlargement.
  The old text must be completely hidden — paint the same background color over it before writing new text.

• style1_outline — USE WHEN: backgroundType = "plain".
  Rule: Do NOT draw any rectangle. Render bold white text with a 3px black stroke and drop shadow.
  Perfect for cartoons, memes with solid-color backgrounds.

• style4_gradient — USE WHEN: backgroundType = "busy" AND the content is a real video (live action, people, footage).
  Rule: Render a semi-transparent dark gradient scrim (0% → 60% dark) behind the text. No hard-edged black rectangle.

• style3_black_banner — USE WHEN: backgroundType = "busy" AND the content is a meme or cartoon that genuinely needs a solid black banner.
  Rule: Use ONLY when style1/style2/style4 would make text unreadable. Keep banner height tight to the text.

STEP 4C — Existing Banner Detection (RULE A)
  If a solid black or white HORIZONTAL text-banner strip (meme caption bar, subtitle bar) exists at the very top or bottom of the frame:
  - Set existingBanner = true
  - Set bannerBounds to EXACTLY the pixel-accurate bounding box of ONLY that strip
  - The first entry in safeAreas MUST be this banner (score ≥ 95, reason = "existing banner")
  - NEVER grow the banner height — only use the region that already exists
  - The banner background color will be sampled and matched, not always black

STEP 4D — Protected Regions (RULE B)
  NEVER place captions over ANY of these:
  - Human faces, eyes, mouths
  - Full bodies or characters (animated or real)
  - Hands, arms, gestures
  - Main foreground objects (escalators, machines, animals, vehicles, props)
  - Motion paths and action areas (where movement is happening)
  - Any text that is part of the scene itself

STEP 4E — Safe Area Candidate Scoring (RULE C)
  Score candidates 0-100. Candidates that overlap ANY protectedRegion score 0.
  Prefer: existing banner (95-100) → plain-color top/bottom (70-90) → empty negative space (50-70) → gradient-safe area (30-60)
  Include at least 2-3 candidates.

STEP 4F — Banner Sizing Rules
  - Width: if existingBanner, match the original banner width exactly.
  - If creating a new style1/style4 area: width is text-wrapping width + 40-60px padding on each side (NOT full-width).
  - Height: calculated from rendered text height. Never oversized.
  - Full-width banners ONLY when the original meme already has a full-width banner.

Fields to return:
- backgroundType: "plain" | "busy" | "existing_banner"
- captionStyle: "style1_outline" | "style2_banner_replace" | "style3_black_banner" | "style4_gradient"
- existingBanner: boolean
- bannerBounds: exact bounding box of existing banner or null
- safeAreas: list of up to 5 candidate boxes sorted by score DESC, each with x/y/width/height/score/reason
- protectedRegions: list of protected areas with type, box, description
- recommendedPlacement: one of "existing_banner", "top", "bottom", "left", "right"

TASK 5: Quality Assessment
Evaluate the image quality, text readability, watermark risk, and style format:
- readability: rating from 0 (illegible) to 100 (high contrast, crisp text).
- watermarkRisk: rating from 0 (no handles/branding) to 100 (unwanted handle overlays).
- isStandardMemeStyle: boolean (true if standard black banner meme or infographic layout).
- recommendation: text describing editing recommendations.

Return ONLY a raw JSON object matching this schema — no markdown, no explanation:
{
  "metadata": {
    "title": string,
    "description": string,
    "tags": string[],
    "mood": "funny" | "sad" | "other"
  },
  "brandingZones": [
    {
      "type": "logo" | "watermark" | "handle" | "profile_name" | "main_post_content" | "original_captions",
      "box": {
        "x": number,
        "y": number,
        "width": number,
        "height": number
      },
      "confidence": number,
      "description": string
    }
  ],
  "extractedText": string,
  "backgroundType": "plain" | "busy" | "existing_banner",
  "captionStyle": "style1_outline" | "style2_banner_replace" | "style3_black_banner" | "style4_gradient",
  "existingBanner": boolean,
  "bannerBounds": { "x": number, "y": number, "width": number, "height": number } | null,
  "safeAreas": [
    {
      "x": number,
      "y": number,
      "width": number,
      "height": number,
      "score": number,
      "reason": string
    }
  ],
  "protectedRegions": [
    {
      "type": string,
      "box": { "x": number, "y": number, "width": number, "height": number },
      "description": string
    }
  ],
  "recommendedPlacement": "existing_banner" | "top" | "bottom" | "left" | "right",
  "qualityScore": {
    "readability": number,
    "watermarkRisk": number,
    "isStandardMemeStyle": boolean,
    "recommendation": string
  }
}`;

async function runTest() {
  const imageBase64 = fs.readFileSync(testImage).toString("base64");
  const mimeType = "image/jpeg";

  const results: any[] = [];
  console.log(`Starting FreeLLMAPI Vision Analysis on: ${path.basename(testImage)}\n`);

  for (const model of models) {
    console.log(`=> Running test for model: ${model}...`);
    const startTime = Date.now();
    let success = false;
    let responseText = "";
    let latency = 0;
    let errorMsg = "";

    try {
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`,
              },
            },
          ],
        },
      ];

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
        }),
      });

      latency = Date.now() - startTime;

      if (!res.ok) {
        throw new Error(`Status ${res.status}: ${await res.text()}`);
      }

      const json = await res.json() as any;
      responseText = json.choices?.[0]?.message?.content ?? "";
      success = true;
      console.log(`   [SUCCESS] Latency: ${latency}ms`);
    } catch (err: any) {
      latency = Date.now() - startTime;
      errorMsg = err.message || String(err);
      console.log(`   [FAILED] Latency: ${latency}ms - Error: ${errorMsg}`);
    }

    // Try parsing as JSON to check if model conformed to output schema
    let isValidJson = false;
    let parsedData: any = null;
    if (success && responseText) {
      try {
        const cleanJson = responseText.replace(/```json|```/g, "").trim();
        parsedData = JSON.parse(cleanJson);
        isValidJson = true;
      } catch (_) {}
    }

    results.push({
      model,
      success,
      latency,
      isValidJson,
      responseText,
      parsedData,
      errorMsg,
    });

    // Sleep 12 seconds between models to avoid rate limit/concurrency spikes on the free API endpoint
    if (models.indexOf(model) < models.length - 1) {
      console.log("   Waiting 12 seconds before the next model request...");
      await new Promise((resolve) => setTimeout(resolve, 12000));
    }
  }

  // Generate markdown report
  let md = `# FreeLLMAPI Vision Model Analysis Report\n\n`;
  md += `This report compares different FreeLLMAPI models for analyzing video frames to identify the best model for coordinates detection, text extraction, and metadata generation.\n\n`;
  md += `* **Test Image:** \`${path.basename(testImage)}\`\n`;
  md += `* **Timestamp:** ${new Date().toLocaleString()}\n\n`;

  md += `## Summary Table\n\n`;
  md += `| Model | Status | Latency | Valid JSON Output | Extracted Text | Detected Banner | Recommended Placement |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

  for (const r of results) {
    const status = r.success ? "✅ Success" : `❌ Failed (${r.errorMsg})`;
    const latencySec = (r.latency / 1000).toFixed(2) + "s";
    const validJson = r.isValidJson ? "✅ Yes" : "❌ No";
    const extText = r.parsedData?.extractedText ? `"${r.parsedData.extractedText.slice(0, 40)}..."` : "N/A";
    const bannerDet = r.parsedData?.existingBanner ? "Yes" : "No";
    const recPlace = r.parsedData?.recommendedPlacement || "N/A";

    md += `| **${r.model}** | ${status} | ${latencySec} | ${validJson} | ${extText} | ${bannerDet} | ${recPlace} |\n`;
  }

  md += `\n## Detailed Output Comparison\n\n`;

  for (const r of results) {
    md += `### Model: \`${r.model}\`\n\n`;
    if (!r.success) {
      md += `* **Error:** \`${r.errorMsg}\`\n\n`;
    } else {
      md += `* **Latency:** ${(r.latency / 1000).toFixed(2)}s\n`;
      md += `* **Valid JSON Schema:** ${r.isValidJson ? "Yes" : "No"}\n\n`;
      md += `#### Raw Response:\n\`\`\`json\n${r.responseText.trim()}\n\`\`\`\n\n`;
      if (r.isValidJson && r.parsedData) {
        md += `#### Key Extracted Fields:\n`;
        md += `* **Verbatim Text:** \`"${r.parsedData.extractedText}"\`\n`;
        md += `* **Recommended Placement:** \`${r.parsedData.recommendedPlacement}\`\n`;
        md += `* **Caption Style:** \`${r.parsedData.captionStyle}\`\n`;
        md += `* **Metadata Title:** \`"${r.parsedData.metadata?.title}"\`\n`;
        md += `* **Metadata Description:** \`"${r.parsedData.metadata?.description}"\`\n`;
        md += `* **Branding Zones Count:** \`${r.parsedData.brandingZones?.length ?? 0}\`\n`;
      }
    }
    md += `---\n\n`;
  }

  // Save report to the artifacts directory
  const reportPath = "/Users/apple/.gemini/antigravity-cli/brain/2c72ba4b-85ba-4ebf-abf3-6be0400c5154/vision_model_comparison.md";
  fs.writeFileSync(reportPath, md, "utf8");
  console.log(`Report successfully generated and saved to: ${reportPath}`);
}

runTest().catch(console.error);
