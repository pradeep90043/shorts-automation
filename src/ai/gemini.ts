import { config } from "../config";

// Tried in order; rotating active models multiplies the effective daily budget for this
// emergency fallback (only spent when FreeLLMAPI has already failed).
const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
  "gemini-2.5-pro",
];

const RATE_LIMIT_STATUSES = new Set([429, 500, 503]);

export class GeminiClient {
  private apiKey: string;

  constructor() {
    this.apiKey = config.ai.geminiApiKey;
  }

  public get enabled(): boolean {
    return !!this.apiKey;
  }

  private async generateWithModel(
    model: string,
    parts: any[],
  ): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({ contents: [{ parts }] }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        const err: any = new Error(
          `Gemini (${model}) request failed with status ${res.status}: ${errText}`,
        );
        err.status = res.status;
        throw err;
      }

      const json = (await res.json()) as any;
      return json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`Gemini (${model}) request timed out after 60 seconds`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Tries each model in order; only advances to the next on a rate-limit (429). */
  private async generateWithRotation(parts: any[]): Promise<string> {
    let lastErr: any;
    for (const model of MODELS) {
      try {
        return await this.generateWithModel(model, parts);
      } catch (err: any) {
        lastErr = err;
        if (!RATE_LIMIT_STATUSES.has(err.status)) throw err;
        // else: this model's daily quota is exhausted — try the next one
      }
    }
    throw lastErr;
  }

  public async generateText(prompt: string): Promise<string> {
    return this.generateWithRotation([{ text: prompt }]);
  }

  public async generateVision(
    prompt: string,
    imageBase64: string | string[],
    mimeType: string | string[],
  ): Promise<string> {
    const images = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
    const mimeTypes = Array.isArray(mimeType)
      ? mimeType
      : Array(images.length).fill(mimeType);

    const imageParts = images.map((base64, idx) => ({
      inlineData: {
        mimeType: mimeTypes[idx] || "image/jpeg",
        data: base64,
      },
    }));

    return this.generateWithRotation([{ text: prompt }, ...imageParts]);
  }
}
