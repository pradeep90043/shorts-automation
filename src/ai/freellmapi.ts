import { config } from "../config";

export class FreeLlmApiClient {

  public async generateChat(messages: any[]): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const res = await fetch("https://text.pollinations.ai/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: messages,
          jsonMode: messages.some(m => {
            if (typeof m.content === 'string') return m.content.includes("JSON");
            if (Array.isArray(m.content)) return m.content.some((c: any) => c.type === 'text' && c.text && c.text.includes("JSON"));
            return false;
          })
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error(`Pollinations API failed with status ${res.status}`);
      }

      const text = await res.text();
      return text;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`Pollinations request timed out after 60 seconds`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async generateGeminiDirect(prompt: string, imageBase64?: string, mimeType?: string): Promise<string> {
    if (!config.ai.geminiApiKey) {
      throw new Error("GEMINI_API_KEY is not configured for fallback.");
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.ai.geminiApiKey}`;
    
    let parts: any[] = [{ text: prompt }];
    if (imageBase64 && mimeType) {
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: imageBase64
        }
      });
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Direct Gemini API failed with status ${res.status}: ${errText}`);
    }

    const json = await res.json() as any;
    return json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  public async generateText(prompt: string): Promise<string> {
    try {
      // Primary for Text: FreeLLMAPI
      return await this.generateChat([{ role: "user", content: prompt }]);
    } catch (err: any) {
      console.warn(`[FreeLLMAPI] Text generation failed: ${err.message}. Falling back to Direct Gemini API...`);
      return await this.generateGeminiDirect(prompt);
    }
  }

  /**
   * Vision request with fallback logic
   */
  public async generateVision(
    prompt: string,
    imageBase64: string,
    mimeType: string,
  ): Promise<string> {
    // Primary for Vision: Direct Gemini API (Pollinations text API cannot process images)
    console.log(`[Vision] Attempting Primary: Direct Gemini API...`);
    return await this.generateGeminiDirect(prompt, imageBase64, mimeType);
  }
}
