import { FreeLlmApiClient } from "../ai/freellmapi";
import { GeminiClient } from "../ai/gemini";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";

export type Ask = (prompt: string) => Promise<string>;

let geminiDownUntil = 0;

/**
 * Plain-text LLM call, hedged like the stickman planner's: FreeLLMAPI first; if it has not answered within `hedgeMs` (or
 * fails) Gemini is asked too and the first non-empty text wins. Text mode: chapters are prose, not JSON.
 * Resolves to "" when no provider is configured or all fail (callers decide what that means).
 */
export function makeAsk(opts: { timeoutMs?: number; hedgeMs?: number } = {}): Ask {
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.AUTO_LONG_LLM_TIMEOUT_MS) || 150_000);
  const hedgeMs = opts.hedgeMs ?? (Number(process.env.AUTO_LONG_HEDGE_MS) || 25_000);
  return async (prompt: string): Promise<string> => {
    const providers: { name: string; ask: () => Promise<string> }[] = [];
    if (config.ai.provider === "freellmapi" || process.env.FREELLMAPI_KEY) {
      providers.push({ name: "FreeLLMAPI", ask: () => new FreeLlmApiClient().generateText(prompt, timeoutMs) });
    }
    if (process.env.GEMINI_API_KEY) {
      providers.push({
        name: "Gemini",
        ask: async () => {
          if (Date.now() < geminiDownUntil) throw new Error("skipped (quota exhausted a moment ago)");
          try {
            return await new GeminiClient().generateText(prompt, { json: false });
          } catch (err: any) {
            if (/status (429|404)|RESOURCE_EXHAUSTED|quota/i.test(String(err?.message))) geminiDownUntil = Date.now() + 10 * 60_000;
            throw err;
          }
        },
      });
    }
    if (!providers.length) return "";
    return new Promise<string>((resolve) => {
      let settled = false, launched = 0, failed = 0;
      let hedge: NodeJS.Timeout | undefined;
      const finish = (t: string) => { if (!settled) { settled = true; if (hedge) clearTimeout(hedge); resolve(t); } };
      const onFail = () => {
        failed++;
        if (hedge) clearTimeout(hedge);
        if (launched < providers.length) launch();
        else if (failed >= providers.length) finish("");
      };
      const launch = () => {
        if (settled || launched >= providers.length) return;
        const p = providers[launched++];
        p.ask().then((t) => (t && t.trim() ? finish(t) : onFail())).catch((err: any) => {
          pipelineLogger.warn(`${p.name} failed for a long-video chapter: ${err.message}`, "AutoLong");
          onFail();
        });
        if (launched < providers.length) hedge = setTimeout(launch, hedgeMs);
      };
      launch();
    });
  };
}
