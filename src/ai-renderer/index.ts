import { spawn } from "child_process";
import { InfographicContent } from "../types";
import { InfographicRenderer } from "../infographic-renderer";
import { PollinationsImageGenerator } from "../image-gen";
import { pipelineLogger } from "../utils/logger";

function runClaudeCLI(
  bin: string,
  prompt: string,
  timeoutMs = 240_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-p", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("CLI timed out"));
    }, timeoutMs);

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.includes("{")) {
        reject(new Error(`CLI exited ${code}: ${stderr.slice(0, 300)}`));
      } else {
        resolve(stdout);
      }
    });

    child.on("error", reject);
  });
}

function runAGYCLI(
  bin: string,
  prompt: string,
  timeoutMs = 240_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["ask"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("CLI timed out"));
    }, timeoutMs);

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.includes("{")) {
        reject(new Error(`CLI exited ${code}: ${stderr.slice(0, 300)}`));
      } else {
        resolve(stdout);
      }
    });

    child.on("error", reject);

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

export class AIRenderer {
  public async generateBrandedFrame(
    imagePath: string,
    outputPath: string,
    provider: "claude" | "antigravity" | "freellmapi" = "claude",
    ocrText?: string,
  ): Promise<string> {
    pipelineLogger.info(
      `AI Renderer starting (provider: ${provider})`,
      "AIRenderer",
    );

    if (provider === "freellmapi") {
      const generator = new PollinationsImageGenerator();
      await generator.generate(imagePath, outputPath, ocrText);
      pipelineLogger.checkpoint(
        "AI-generated image background created",
        true,
        `Output: ${outputPath}`,
      );
      return outputPath;
    }

    const content = await this.callAI(imagePath, provider);
    const renderer = new InfographicRenderer();
    await renderer.render(content, outputPath);

    pipelineLogger.checkpoint(
      "AI infographic rendered",
      true,
      `Output: ${outputPath}`,
    );
    return outputPath;
  }

  private async callAI(
    imagePath: string,
    provider: "claude" | "antigravity",
  ): Promise<InfographicContent> {
    const prompt = this.buildPrompt(imagePath);

    pipelineLogger.info(
      `Calling ${provider} CLI for structured infographic content…`,
      "AIRenderer",
    );

    let stdout: string;
    if (provider === "claude") {
      const cliPath = process.env.CLAUDE_CLI_PATH || "claude";
      stdout = await runClaudeCLI(cliPath, prompt, 240_000);
    } else {
      const cliPath = process.env.ANTIGRAVITY_CLI_PATH || "agy";
      stdout = await runAGYCLI(cliPath, prompt, 240_000);
    }

    const content = this.parseJSON(stdout);
    pipelineLogger.info(
      `JSON parsed: "${content.title} ${content.titleAccent}" (${content.items.length} items)`,
      "AIRenderer",
    );
    return content;
  }

  private parseJSON(raw: string): InfographicContent {
    const s = raw
      .replace(/^```json\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new Error(
        `AI did not return valid JSON. Raw output length: ${raw.length}`,
      );
    }
    const obj = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    if (
      !obj.title ||
      !obj.titleAccent ||
      !Array.isArray(obj.items) ||
      obj.items.length === 0
    ) {
      throw new Error(
        "AI JSON missing required fields: title, titleAccent, items",
      );
    }
    return obj as unknown as InfographicContent;
  }

  private buildPrompt(imagePath: string): string {
    return `You are a data extraction assistant for a YouTube Shorts infographic pipeline.

IMAGE: ${imagePath}

Read every piece of text and every item from the image above. Extract the content and return it as a JSON object matching this exact schema. Return ONLY the raw JSON object — no markdown fences, no explanation, nothing else.

SCHEMA:
{
  "title": string,         // Main heading, line 1 — max 40 chars (e.g. "TOP 10 JAVA")
  "titleAccent": string,   // Key phrase, line 2 — max 20 chars (e.g. "CONCEPTS")
  "subtitle": string,      // Optional thin subline — max 60 chars (omit if not present)
  "items": [
    {
      "number": number,        // 1-based sequential index
      "title": string,         // Short label / abbreviation — max 30 chars
      "description": string,   // Full explanation — max 80 chars
      "icon": string           // Optional single emoji (omit if not in source)
    }
  ],
  "tipLeft": string,       // Optional bottom-left callout text — max 100 chars (omit if not present)
  "tipRight": string       // Optional bottom-right callout text — max 100 chars (omit if not present)
}

RULES:
1. Reproduce EVERY item from the image — do not skip or summarize any item
2. Keep item titles short (abbreviation or keyword), put the full text in description
3. If the image is source code (not a list), set title to the language/topic, titleAccent to "CODE", and put each function/method as an item with a short description
4. tipLeft / tipRight are only present if the image has explicit bottom callout boxes
5. Return ONLY the JSON object`;
  }
}
