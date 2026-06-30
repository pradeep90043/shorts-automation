import { config } from '../config';

export class FreeLlmApiClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor() {
    this.baseUrl = config.ai.freellmapiUrl.replace(/\/$/, '');
    this.apiKey = config.ai.freellmapiKey;
    this.model = config.ai.freellmapiModel || 'gemini-2.0-flash';
  }

  public async generateChat(messages: any[]): Promise<string> {
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
          model: this.model,
          messages: messages,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`FreeLLMAPI request failed with status ${res.status}: ${errText}`);
      }

      const json = await res.json() as any;
      return json.choices?.[0]?.message?.content ?? '';
    } catch (err: any) {
      if (err.name === 'AbortError') {
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

  public async generateVision(prompt: string, imageBase64: string, mimeType: string): Promise<string> {
    return this.generateChat([
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${imageBase64}`
            }
          }
        ]
      }
    ]);
  }
}
