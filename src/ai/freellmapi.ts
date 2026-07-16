import { config } from '../config';

export class FreeLlmApiClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private visionModel: string;

  constructor() {
    this.baseUrl = config.ai.freellmapiUrl.replace(/\/$/, '');
    this.apiKey = config.ai.freellmapiKey;
    this.model = "auto";
    this.visionModel = "auto";
  }

  public async generateChat(messages: any[], isVision = false): Promise<string> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: isVision ? this.visionModel : this.model,
          messages: messages,
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`FreeLLMAPI request failed with status ${res.status}: ${errText}`);
      }

      const json = await res.json() as any;
      return json.choices?.[0]?.message?.content ?? '';
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
    return this.generateChat([
      { role: 'user', content: prompt }
    ]);
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
