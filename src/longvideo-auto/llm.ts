import { FreeLlmApiClient } from "../ai/freellmapi";
import { GeminiClient } from "../ai/gemini";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";

/** `maxTokens`: the most the answer may need (a one-line rewrite ~300); without it the client default applies. */
export type Ask = (prompt: string, opts?: { maxTokens?: number; model?: string }) => Promise<string>;

let geminiDownUntil = 0;

let healthCache: { at: number; reason: string | null } | null = null;
/**
 * Readiness probe: one tiny prompt through the same hedged providers. Returns why the LLMs are unusable right now, or null when
 * one answered. A video started while every provider is down burns 15+ minutes and a retry attempt before failing (2026-10-16),
 * so the worker waits instead. Cached: 5 min when healthy, 2 min when down.
 */
export async function llmDownReason(): Promise<string | null> {
  const ttl = healthCache?.reason ? 2 * 60_000 : 5 * 60_000;
  if (healthCache && Date.now() - healthCache.at < ttl) return healthCache.reason;
  let reason: string | null = null;
  try {
    const text = await makeAsk({ timeoutMs: 45_000, hedgeMs: 10_000 })("Reply with the single word OK.", { maxTokens: 16 });
    if (!text.trim()) reason = "no LLM provider answered a health probe";
  } catch (err) {
    reason = `LLM health probe failed: ${err instanceof Error ? err.message : err}`;
  }
  healthCache = { at: Date.now(), reason };
  return reason;
}

/**
 * Plain-text LLM call, hedged like the stickman planner's: FreeLLMAPI first; if it has not answered within `hedgeMs` (or
 * fails) Gemini is asked too and the first non-empty text wins. Text mode: chapters are prose, not JSON.
 * Resolves to "" when no provider is configured or all fail (callers decide what that means).
 */
export function makeAsk(opts: { timeoutMs?: number; hedgeMs?: number } = {}): Ask {
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.AUTO_LONG_LLM_TIMEOUT_MS) || 150_000);
  const hedgeMs = opts.hedgeMs ?? (Number(process.env.AUTO_LONG_HEDGE_MS) || 25_000);
  return async (prompt: string, askOpts?: { maxTokens?: number; model?: string }): Promise<string> => {
    const providers: { name: string; ask: () => Promise<string> }[] = [];
    if (config.ai.provider === "freellmapi" || process.env.FREELLMAPI_KEY) {
      providers.push({ name: "FreeLLMAPI", ask: () => new FreeLlmApiClient().generateText(prompt, timeoutMs, askOpts?.maxTokens, askOpts?.model) });
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
