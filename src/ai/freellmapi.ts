import { config } from '../config';
import { pipelineLogger } from '../utils/logger';
import { RATE_LIMIT_BACKOFF_MS, isRateLimitError, setAiGateLogger, textGate, visionGate } from './aiGate';

setAiGateLogger((m) => pipelineLogger.info(m, 'AI'));

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
    timeoutMs: number,
    maxTokens?: number,
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
          // Without it each free provider applies its own default (about 1,024 tokens): the unified vision answer, a long JSON, was cut
          // off at ~3,100 characters and could not be parsed, so Shorts fell back to weaker metadata (seen 2026-10-20).
          // `maxTokens` is the caller's own need (a one-line rewrite needs ~300, not 4096: a model that loops fills whatever it is given)
          ...(process.env.AI_MAX_TOKENS === "off" ? {} : { max_tokens: maxTokens ?? (Number(process.env.AI_MAX_TOKENS) || 4096) }),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`FreeLLMAPI (${targetUrl}) request failed with status ${res.status}: ${errText}`);
      }

      const json = await res.json() as any;
      if (json.choices?.[0]?.finish_reason === "length") {
        console.warn(`[FreeLLMAPI] the answer was cut off by the token limit (${json.model ?? model})`);
      }
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

  /**
   * Every request takes its turn at the process-wide gate (aiGate.ts): vision one at a time with a gap, text a few at a time, and a
   * rate-limit answer pauses all of them for a while. The free keys are shared by all channels and a burst benches every one of them.
   */
  public async generateChat(messages: any[], isVision = false, timeoutOverrideMs?: number, maxTokens?: number, modelOverride?: string): Promise<string> {
    return (isVision ? visionGate : textGate).run(async () => {
      try {
        return await this.generateChatNow(messages, isVision, timeoutOverrideMs, maxTokens, modelOverride);
      } catch (err: any) {
        if (isRateLimitError(String(err?.message ?? err))) {
          visionGate.backOff(RATE_LIMIT_BACKOFF_MS);
          textGate.backOff(RATE_LIMIT_BACKOFF_MS);
          pipelineLogger.warn(`AI provider said slow down: no new AI request starts for ${Math.round(RATE_LIMIT_BACKOFF_MS / 1000)}s`, 'AI');
        }
        throw err;
      }
    });
  }

  private async generateChatNow(messages: any[], isVision = false, timeoutOverrideMs?: number, maxTokens?: number, modelOverride?: string): Promise<string> {
    // A vision answer normally takes 6-30 s (the stage's median is ~10 s). One still running at 50 s is stuck on a rate-limited or hung free
// provider; waiting 120 s for it cost reels 2-4 minutes each (three attempts). The retry is routed to another provider.
    const timeoutMs = timeoutOverrideMs ?? (isVision ? Number(process.env.AI_VISION_TIMEOUT_MS) || 50000 : 60000);
    const primaryModel = modelOverride || (isVision ? this.visionModel : this.model);

    // TEXT_MODEL_PIN: a model that answers directly, tried first for plain text calls. The dev router otherwise picks a reasoning model
    // (nvidia/nemotron: "Here's a thinking process: ...") whose answers have no JSON and no clean prose. Any failure or empty answer
    // continues with the normal routing below, so the pin can only help.
    const pin = process.env.TEXT_MODEL_PIN;
    if (!isVision && !modelOverride && pin) {
      try {
        const pinned = await this.executeChatRequest(this.baseUrl, this.apiKey, pin, messages, Math.min(timeoutMs, 40_000), maxTokens);
        if (pinned && pinned.trim()) return pinned;
      } catch { /* fall through to the normal routing */ }
    }

    // VISION_MODEL_PIN: the same idea for images: the router sometimes sends a vision request to a slow or hung provider (50 s, then a retry).
    const visionPin = process.env.VISION_MODEL_PIN;
    if (isVision && !modelOverride && visionPin) {
      try {
        const pinned = await this.executeChatRequest(this.baseUrl, this.apiKey, visionPin, messages, Math.min(timeoutMs, 30_000), maxTokens);
        if (pinned && pinned.trim()) return pinned;
      } catch { /* fall through to the normal routing */ }
    }

    try {
      return await this.executeChatRequest(this.baseUrl, this.apiKey, primaryModel, messages, timeoutMs, maxTokens);
    } catch (primaryErr: any) {
      if (this.fallbackUrl && this.fallbackApiKey) {
        const fbModel = isVision ? this.fallbackVisionModel : this.fallbackModel;
        console.warn(`[FreeLLMAPI] Primary endpoint ${this.baseUrl} failed (${primaryErr.message}). Failing over to fallback ${this.fallbackUrl}...`);
        try {
          return await this.executeChatRequest(this.fallbackUrl, this.fallbackApiKey, fbModel, messages, timeoutMs, maxTokens);
        } catch (fallbackErr: any) {
          console.error(`[FreeLLMAPI] Fallback endpoint ${this.fallbackUrl} also failed: ${fallbackErr.message}`);
          throw new Error(`FreeLLMAPI primary (${primaryErr.message}) and fallback (${fallbackErr.message}) both failed.`);
        }
      }
      throw primaryErr;
    }
  }

  public async generateText(prompt: string, timeoutMs?: number, maxTokens?: number, model?: string): Promise<string> {
    return this.generateChat([
      { role: 'user', content: prompt }
    ], false, timeoutMs, maxTokens, model);
  }

  public async generateVision(
    prompt: string,
    imageBase64: string | string[],
    mimeType: string | string[]
  ): Promise<string> {
    const images = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
    const mimeTypes = Array.isArray(mimeType) ? mimeType : Array(images.length).fill(mimeType);

    const ask = (picked: number[]) =>
      this.generateChat([
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...picked.map((idx) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${mimeTypes[idx] || 'image/jpeg'};base64,${images[idx]}` },
            })),
          ],
        },
      ], true);

    const all = images.map((_, i) => i);
    try {
      return await ask(all);
    } catch (err: any) {
      // "Too many images provided. This model supports up to 3 images": the router picked a provider with an image limit. Ask again with
      // that many frames, spread evenly over the clip (first, middle, last), instead of failing the whole analysis.
      const limit = Number(/supports up to (\d+) images?/i.exec(String(err?.message ?? err))?.[1]);
      if (Number.isFinite(limit) && limit >= 1 && limit < images.length) {
        const picked = Array.from({ length: limit }, (_, k) => all[Math.round((k * (images.length - 1)) / Math.max(1, limit - 1))]);
        pipelineLogger.warn(`A provider takes at most ${limit} images: asking again with ${limit} of the ${images.length} frames`, 'AI');
        return ask([...new Set(picked)]);
      }
      throw err;
    }
  }
}
