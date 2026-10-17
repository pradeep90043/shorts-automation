import { config } from '../config';

export class FreeLlmApiClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private visionModel: string;

  private fallbackUrl?: string;
  private fallbackApiKey?: string;
  private fallbackModel: string;
  private fallbackVisionModel: string;

  constructor() {
    let bUrl = (config.ai.freellmapiUrl || "http://localhost:3001").trim().replace(/\/$/, '');
    if (!bUrl.startsWith('http://') && !bUrl.startsWith('https://')) {
      bUrl = `http://${bUrl.includes(':') ? bUrl : `localhost:${bUrl}`}`;
    }
    this.baseUrl = bUrl;
    this.apiKey = config.ai.freellmapiKey;
    this.model = config.ai.freellmapiModel || "auto";
    this.visionModel = config.ai.freellmapiVisionModel || "auto";

    if (config.ai.freellmapiFallbackUrl) {
      let fbUrl = config.ai.freellmapiFallbackUrl.trim().replace(/\/$/, '');
      if (!fbUrl.startsWith('http://') && !fbUrl.startsWith('https://')) {
        fbUrl = `http://${fbUrl.includes(':') ? fbUrl : `localhost:${fbUrl}`}`;
      }
      this.fallbackUrl = fbUrl;
      this.fallbackApiKey = config.ai.freellmapiFallbackKey || this.apiKey;
      this.fallbackModel = config.ai.freellmapiFallbackModel || this.model;
      this.fallbackVisionModel = config.ai.freellmapiFallbackVisionModel || this.visionModel;
    } else {
      this.fallbackModel = "auto";
      this.fallbackVisionModel = "auto";
    }
  }

  private async executeChatRequest(
    targetUrl: string,
    apiKey: string,
    model: string,
    messages: any[],
    timeoutMs: number
  ): Promise<string> {
    const url = `${targetUrl}/v1/chat/completions`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`FreeLLMAPI (${targetUrl}) request failed with status ${res.status}: ${errText}`);
      }

      const json = await res.json() as any;
      return json.choices?.[0]?.message?.content ?? '';
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`FreeLLMAPI (${targetUrl}) request timed out after ${timeoutMs / 1000} seconds`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async generateChat(messages: any[], isVision = false, timeoutOverrideMs?: number): Promise<string> {
    const timeoutMs = timeoutOverrideMs ?? (isVision ? 120000 : 60000);
    const primaryModel = isVision ? this.visionModel : this.model;

    try {
      return await this.executeChatRequest(this.baseUrl, this.apiKey, primaryModel, messages, timeoutMs);
    } catch (primaryErr: any) {
      if (this.fallbackUrl && this.fallbackApiKey) {
        const fbModel = isVision ? this.fallbackVisionModel : this.fallbackModel;
        console.warn(`[FreeLLMAPI] Primary endpoint ${this.baseUrl} failed (${primaryErr.message}). Failing over to fallback ${this.fallbackUrl}...`);
        try {
          return await this.executeChatRequest(this.fallbackUrl, this.fallbackApiKey, fbModel, messages, timeoutMs);
        } catch (fallbackErr: any) {
          console.error(`[FreeLLMAPI] Fallback endpoint ${this.fallbackUrl} also failed: ${fallbackErr.message}`);
          throw new Error(`FreeLLMAPI primary (${primaryErr.message}) and fallback (${fallbackErr.message}) both failed.`);
        }
      }
      throw primaryErr;
    }
  }

  public async generateText(prompt: string, timeoutMs?: number): Promise<string> {
    return this.generateChat([
      { role: 'user', content: prompt }
    ], false, timeoutMs);
  }

  public async generateVision(
    prompt: string,
    imageBase64: string | string[],
    mimeType: string | string[]
  ): Promise<string> {
    const images = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
    const mimeTypes = Array.isArray(mimeType) ? mimeType : Array(images.length).fill(mimeType);

    const imageContentParts = images.map((base64, idx) => ({
      type: 'image_url' as const,
      image_url: {
        url: `data:${mimeTypes[idx] || 'image/jpeg'};base64,${base64}`
      }
    }));

    return this.generateChat([
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...imageContentParts
        ]
      }
    ], true);
  }
}
