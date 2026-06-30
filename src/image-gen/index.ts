import sharp from "sharp";
import fs from "fs";
import { InfographicContent } from "../types";
import { InfographicRenderer } from "../infographic-renderer";
import { pipelineLogger } from "../utils/logger";
import { config } from "../config";
import { FreeLlmApiClient } from "../ai/freellmapi";
import { parseAiJson } from "../utils/json";

const CANVAS_W = 1080;
const CANVAS_H = 1920;

export class PollinationsImageGenerator {
  private freellmapi: FreeLlmApiClient | null = null;
  private renderer: InfographicRenderer;

  constructor() {
    if (config.ai.provider === "freellmapi") {
      this.freellmapi = new FreeLlmApiClient();
    }
    this.renderer = new InfographicRenderer();
  }

  private parseContentJSON(
    raw: string,
  ): InfographicContent & { visualContext?: string } {
    const obj = parseAiJson<Record<string, unknown>>(raw);

    // Patch missing required fields rather than failing outright
    if (!obj.title) obj.title = "TECH LIST";
    if (!obj.titleAccent) obj.titleAccent = "TOOLS";
    if (!Array.isArray(obj.items) || (obj.items as unknown[]).length === 0) {
      pipelineLogger.warn(
        `AI JSON missing items. Full object keys: ${Object.keys(obj).join(", ")}`,
        "PollinationsImageGenerator",
      );
      throw new Error("AI JSON has no items array — cannot build infographic");
    }

    return obj as unknown as InfographicContent & { visualContext?: string };
  }

  private buildExtractionPrompt(ocrHint: string): string {
    return `Analyze this post image carefully — read ALL text and note every item, logo, and visual element.${ocrHint}

Return ONLY a raw JSON object — no markdown, no explanation, nothing else before or after.

{
  "title": string,
  "titleAccent": string,
  "subtitle": string,
  "items": [
    {
      "number": number,
      "title": string,
      "description": string,
      "icon": string,
      "tag": string,
      "platform": string
    }
  ],
  "tipLeft": string,
  "tipRight": string,
  "visualContext": string
}

Rules:
- title: main heading, max 40 chars (ALL CAPS preferred)
- titleAccent: yellow keyword/phrase, max 20 chars (ALL CAPS)
- subtitle: one-line description, max 60 chars (omit if absent)
- Reproduce EVERY item — do not skip or merge any
- Each item:
    number: 1-based index
    title: tool/concept name, max 28 chars
    description: what it does + key feature, max 75 chars
    icon: single relevant emoji
    tag: one-word badge like "Free", "Paid", "Open Source", "Popular" (omit if unknown)
    platform: short platform list like "Web • macOS" or "Linux • Windows" (omit if unknown)
- tipLeft: best overall pick or verdict, max 90 chars (omit if absent)
- tipRight: pro tip or recommendation, max 90 chars (omit if absent)
- visualContext: describe logos/visual style in the post, max 120 chars (omit if none)
- Return ONLY the JSON object starting with { and ending with }`;
  }

  private buildSimpleExtractionPrompt(ocrHint: string): string {
    return `Look at this image and list all items/topics you see in it.${ocrHint}

Return ONLY this JSON (no markdown fences, no explanation):
{"title":"LIST","titleAccent":"TOOLS","items":[{"number":1,"title":"Item name","description":"Brief description","icon":"🔧"}]}

Replace the example with real content from the image. Include ALL items visible. Start response with { and end with }.`;
  }

  // Step 1: AI vision — sees the full post (text + logos + images)
  private async extractContent(
    sourceImagePath: string,
    ocrText?: string,
  ): Promise<InfographicContent & { visualContext?: string }> {
    pipelineLogger.info(
      "Step 1: Analyzing post with AI vision (text + visuals)…",
      "PollinationsImageGenerator",
    );

    const base64 = fs.readFileSync(sourceImagePath).toString("base64");
    const mimeType = sourceImagePath.toLowerCase().endsWith(".png")
      ? "image/png"
      : "image/jpeg";

    const ocrHint =
      ocrText && ocrText.trim().length > 10
        ? `\n\nOCR already extracted this text (use as reference):\n${ocrText.slice(0, 1000)}`
        : "";

    const callAI = async (prompt: string): Promise<string> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (!this.freellmapi)
            throw new Error("FreeLLMAPI client is not initialized");
          return await this.freellmapi.generateVision(prompt, base64, mimeType);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < 2 && /503|unavailable|quota|rate/i.test(msg)) {
            pipelineLogger.warn(
              `AI 503/rate-limit on attempt ${attempt + 1}, waiting 5s…`,
              "PollinationsImageGenerator",
            );
            await new Promise((r) => setTimeout(r, 5000));
          } else throw err;
        }
      }
      return "";
    };

    // Attempt 1: full detailed prompt
    try {
      const rawText = await callAI(this.buildExtractionPrompt(ocrHint));
      const content = this.parseContentJSON(rawText);
      pipelineLogger.info(
        `Content extracted: "${content.title} ${content.titleAccent}" (${content.items.length} items)${content.visualContext ? ` | visuals: ${content.visualContext}` : ""}`,
        "PollinationsImageGenerator",
      );
      return content;
    } catch (err) {
      pipelineLogger.warn(
        `Attempt 1 failed (${err instanceof Error ? err.message : err}) — retrying with simpler prompt`,
        "PollinationsImageGenerator",
      );
    }

    // Attempt 2: simpler prompt, less strict
    const rawText2 = await callAI(this.buildSimpleExtractionPrompt(ocrHint));
    pipelineLogger.info(
      `Attempt 2 raw response (first 300): ${rawText2.slice(0, 300)}`,
      "PollinationsImageGenerator",
    );
    const content = this.parseContentJSON(rawText2);
    pipelineLogger.info(
      `Content extracted (retry): "${content.title} ${content.titleAccent}" (${content.items.length} items)`,
      "PollinationsImageGenerator",
    );
    return content;
  }

  // Step 2: Pollinations → generate AI visual background incorporating post's visual elements
  private async generateBackground(
    content: InfographicContent & { visualContext?: string },
  ): Promise<Buffer> {
    const visualExtra = content.visualContext
      ? `, incorporating visual elements: ${content.visualContext}`
      : "";

    const stylePrompt = [
      `dark cyberpunk infographic background for "${content.title} ${content.titleAccent}"${visualExtra}`,
      "pure black background, neon yellow (#FFB800) glowing rectangular card outlines arranged in a 2-column grid",
      "circuit board grid texture, subtle yellow neon light rays, corner bracket decorations in yellow",
      `${content.items.length} dark card slots with glowing yellow borders, no readable text`,
      "premium tech documentary aesthetic, high contrast, vertical portrait 9:16 format",
      "yellow neon glow emanating from card borders, dark ambient lighting, cinematic",
    ].join(", ");

    const encodedPrompt = encodeURIComponent(stylePrompt);
    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${CANVAS_W}&height=${CANVAS_H}&model=flux&nologo=true&enhance=false`;

    pipelineLogger.info(
      "Step 2: Generating visual background with Pollinations.ai…",
      "PollinationsImageGenerator",
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Pollinations returned HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // Ensure exact canvas dimensions
      return sharp(buf)
        .resize(CANVAS_W, CANVAS_H, { fit: "cover", position: "center" })
        .png()
        .toBuffer();
    } finally {
      clearTimeout(timeout);
    }
  }

  // Step 3: Composite readable text overlay (semi-transparent) over the AI background
  private async compositeTextOverlay(
    background: Buffer,
    content: InfographicContent,
    outputPath: string,
  ): Promise<void> {
    pipelineLogger.info(
      "Step 3: Compositing text overlay…",
      "PollinationsImageGenerator",
    );

    // Render infographic with transparent background so AI image shows through
    const textOverlay = await this.renderer.renderToBuffer(content, true);

    await sharp(background)
      .composite([{ input: textOverlay, blend: "over" }])
      .png()
      .toFile(outputPath);
  }

  public async generate(
    sourceImagePath: string,
    outputPath: string,
    ocrText?: string,
  ): Promise<string> {
    // Always use image vision so Gemini sees logos, images, and visual elements — not just text.
    // OCR text is passed as a hint to speed up text parsing, not as a replacement for vision.
    const content = await this.extractContent(sourceImagePath, ocrText);
    const background = await this.generateBackground(content);
    await this.compositeTextOverlay(background, content, outputPath);

    pipelineLogger.checkpoint(
      "Hybrid image generated",
      true,
      `→ ${outputPath}`,
    );
    return outputPath;
  }
}
