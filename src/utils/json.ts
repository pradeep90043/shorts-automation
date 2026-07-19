import { pipelineLogger } from "./logger";

/**
 * Scans forward from an opening bracket and returns the index of its
 * matching close, ignoring bracket characters that appear inside quoted
 * strings. Returns -1 if the brackets never balance (unterminated JSON).
 */
function findMatchingBracket(
  s: string,
  openIdx: number,
  openCh: string,
  closeCh: string,
): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Best-effort recovery for one named array field (e.g. "brandingZones")
 * directly out of a raw LLM response, independent of whether the rest of
 * the JSON document is well-formed. LLMs writing long free-text fields
 * (voiceover scripts, Hinglish descriptions) routinely emit an unescaped
 * quote or apostrophe elsewhere in the same object; that breaks parsing of
 * the whole response, which previously threw away perfectly valid
 * branding-zone detections along with it. Isolating just this field lets
 * those zones survive even when the surrounding metadata doesn't parse.
 */
export function extractJsonArrayField<T = any>(
  raw: string,
  fieldName: string,
): T[] | null {
  const keyMatch = raw.match(new RegExp(`"${fieldName}"\\s*:\\s*\\[`));
  if (!keyMatch || keyMatch.index === undefined) return null;
  const start = raw.indexOf("[", keyMatch.index);
  if (start === -1) return null;

  const end = findMatchingBracket(raw, start, "[", "]");
  if (end === -1) return null;

  const snippet = raw.slice(start, end + 1);
  try {
    return JSON.parse(snippet) as T[];
  } catch {
    try {
      return JSON.parse(snippet.replace(/,\s*([}\]])/g, "$1")) as T[];
    } catch (err) {
      pipelineLogger.warn(
        `Failed to isolate "${fieldName}" array from a malformed AI response: ${err instanceof Error ? err.message : err}`,
        "JsonParser",
      );
      return null;
    }
  }
}

/**
 * Robustly extracts, cleans, and parses JSON objects or arrays returned by LLMs.
 * Handles common issues like trailing commas and unescaped double quotes in string values.
 */
export function parseAiJson<T>(raw: string): T {
  // 1. Find the boundaries of the JSON content
  const firstBrace = raw.indexOf("{");
  const firstBracket = raw.indexOf("[");

  let startIdx = -1;
  let endIdx = -1;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endIdx = findMatchingBracket(raw, startIdx, "{", "}");
    // Some responses emit two separate top-level JSON values back to back
    // (e.g. a bare zones array followed by "TASK 2" prose and a second
    // object) instead of the single requested object. Matching brackets
    // isolates just the first value; falling back to lastIndexOf only
    // when brackets never balance preserves the old best-effort behavior.
    if (endIdx === -1) endIdx = raw.lastIndexOf("}");
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endIdx = findMatchingBracket(raw, startIdx, "[", "]");
    if (endIdx === -1) endIdx = raw.lastIndexOf("]");
  }

  if (startIdx === -1 || endIdx === -1) {
    throw new Error("AI response does not contain any JSON object or array");
  }

  let s = raw.slice(startIdx, endIdx + 1);

  // Attempt direct parse first
  try {
    return JSON.parse(s) as T;
  } catch (parseErr) {
    pipelineLogger.warn(
      `Initial JSON parse failed. Attempting repair... Error: ${parseErr instanceof Error ? parseErr.message : parseErr}`,
      "JsonParser",
    );
  }

  // 2. Perform repairs:
  // Remove trailing commas before closing braces or brackets
  s = s.replace(/,\s*([}\]])/g, "$1");

  // Repair unescaped double quotes in string fields line-by-line
  const lines = s.split("\n");
  const repairedLines = lines.map((line) => {
    // Match line pattern: "key": "value" with optional trailing comma
    const match = line.match(/^(\s*"[a-zA-Z0-9_]+")\s*:\s*"(.*)"\s*(,?)\s*$/);
    if (match) {
      const [, key, val, comma] = match;
      // Escape any unescaped double quotes inside the string value
      // (?<!\\)" matches " only if it is not preceded by \
      const repairedVal = val.replace(/(?<!\\)"/g, '\\"');
      return `${key}: "${repairedVal}"${comma}`;
    }
    return line;
  });
  s = repairedLines.join("\n");

  try {
    return JSON.parse(s) as T;
  } catch (repairErr) {
    pipelineLogger.error(
      `JSON repair failed. Content attempted to parse:\n${s}`,
      repairErr as Error,
      "JsonParser",
    );
    throw new Error(
      `JSON parsing failed even after repair: ${repairErr instanceof Error ? repairErr.message : repairErr}`,
    );
  }
}
