import { config } from "../config";

export class FreeLlmApiClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private visionModel: string;

  constructor() {
    this.baseUrl = config.ai.freellmapiUrl.replace(/\/$/, "");
    this.apiKey = config.ai.freellmapiKey;
    this.model = config.ai.freellmapiModel || "auto";
    this.visionModel = config.ai.freellmapiVisionModel || "gemini-2.5-flash";
  }

  public async generateChat(messages: any[], timeoutMs = 120_000, modelOverride?: string): Promise<string> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs); // configurable timeout

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: modelOverride || this.model,
          messages: messages,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(
          `FreeLLMAPI request failed with status ${res.status}: ${errText}`,
        );
      }

      const json = (await res.json()) as any;
      return json.choices?.[0]?.message?.content ?? "";
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`FreeLLMAPI request timed out after 60 seconds`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async generateText(prompt: string): Promise<string> {
    return this.generateChat([{ role: "user", content: prompt }]);
  }

  /**
   * Vision request with a longer timeout (120s) and one auto-retry on timeout / 5xx.
   * Large base64 images often take 60-90s on a cold Gemini endpoint.
   */
  public async generateVision(
    prompt: string,
    imageBase64: string,
    mimeType: string,
  ): Promise<string> {
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

    // First attempt with 120s timeout using visionModel
    try {
      return await this.generateChat(messages, 120_000, this.visionModel);
    } catch (firstErr: any) {
      console.warn(`[FreeLLMAPI] Vision request failed using model ${this.visionModel}: ${firstErr?.message || firstErr}. Falling back to "${this.model}" model.`);
      try {
        // Fallback to auto/default model (this.model) with 90s window
        return await this.generateChat(messages, 90_000, this.model);
      } catch (secondErr: any) {
        console.error(`[FreeLLMAPI] Fallback to "${this.model}" model also failed: ${secondErr?.message || secondErr}`);
        throw firstErr;
      }
    }
  }
}
