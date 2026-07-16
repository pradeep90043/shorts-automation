# Plan: Gemini as AI Fallback Provider

## Context

FreeLLMAPI (primary AI provider) intermittently times out and rate-limits ("All models rate-limited"), which degrades reels to text-only metadata or the hardcoded template. A `GEMINI_API_KEY` is now in `.env` and verified working.

**Test findings (2026-07-17):**
- Reliability: 10/10 calls succeeded, ~1.2s average latency (vs. FreeLLMAPI's 60–120s timeouts when unhealthy)
- Free-tier quota: **~20 requests/day per model, per Google Cloud project** — AI Studio usage counts against the same pool; resets midnight Pacific (~12:30 PM IST)
- Per-model quotas are separate, so rotating models multiplies capacity: `gemini-2.5-flash` → `gemini-2.0-flash` → `gemini-flash-lite-latest`

**Decision: Gemini is a FALLBACK, not primary.** The ~20/day/model budget is only spent when FreeLLMAPI actually fails, which is when it saves a reel from template metadata.

## Implementation steps

### 1. New Gemini client — `src/ai/gemini.ts`
Mirror `FreeLlmApiClient`'s interface so call sites stay simple:
- `generateText(prompt): Promise<string>`
- `generateVision(prompt, imageBase64[], mimeType[]): Promise<string>` — Gemini `inlineData` parts (`{ inlineData: { mimeType, data } }`)
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` with `x-goog-api-key` header
- **Model rotation:** try `gemini-2.5-flash`, on 429 try `gemini-2.0-flash`, then `gemini-flash-lite-latest`; give up after all three
- 60s timeout per attempt; parse `candidates[0].content.parts[0].text`
- Config: read `process.env.GEMINI_API_KEY` (via `config.ai.geminiApiKey` in `src/config/index.ts`); client is null/disabled when unset

### 2. Wire fallback into `src/direct-uploader.ts`
- `runUnifiedAiVision` (~line 189): in the catch path (after the FreeLLMAPI retry loop throws), try `gemini.generateVision(prompt, base64s, mimeTypes)` with the SAME prompt before falling to `generateTextMetadataFallback`. Parse with the existing `parseAiJson` flow so all TASK 1–6 outputs (branding zones, recommendedSettings, mood) survive.
- `generateTextMetadataFallback` (~line 801): after FreeLLMAPI text attempt (incl. its one retry) fails, try `gemini.generateText(prompt)` before the hardcoded template.
- Telegram warnings: only notify the user when BOTH providers fail (move the existing "AI Vision Error" message after the Gemini attempt).
- Log clearly: `"FreeLLMAPI failed — falling back to Gemini (<model>)"` / `"Gemini fallback succeeded"`.

### 3. Config — `src/config/index.ts`
- Add `geminiApiKey: process.env.GEMINI_API_KEY || ""` under `config.ai`.
- No new provider enum value needed (fallback only, not a selectable primary).

### 4. Verification
- `npx tsc --noEmit` + `npm run test:pipeline`
- Unit-style: temporarily point `freellmapiUrl` at a dead port → send a reel → expect log "falling back to Gemini", real metadata (not template), settings review shows AI recommendations
- Quota-exhausted path: with Gemini also 429ing (current state until ~12:30 PM IST), expect graceful degradation to the existing text fallback/template + Telegram warning
- Restore `freellmapiUrl`, send a real reel end-to-end

## Out of scope
- Paid Gemini tier / making Gemini primary
- Replacing FreeLLMAPI
- Caching AI responses across reels
