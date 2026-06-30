import { pipelineLogger } from "./logger";

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
    endIdx = raw.lastIndexOf("}");
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endIdx = raw.lastIndexOf("]");
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
