/**
 * Source-creator attribution.
 *
 * The AI used to be asked to write "@<original creator>" without being told who that was, so
 * published descriptions carried placeholders (@original_creator, @unknown) or invented names
 * (@MarvelStudios). The creator handle is now verified (from yt-dlp / the watched account) and the
 * credit block is stamped in code, replacing anything the AI wrote.
 */

const PLACEHOLDER_HANDLES = new Set([
  "unknown", "creator", "original_creator", "originalcreator", "respectiveowner", "respective_owner",
  "owner", "original", "manual_inject", "none", "na", "username", "handle", "your_handle", "channel",
  "search", "source", "user", "account",
]);

/**
 * Returns a clean Instagram-style handle (no @), or undefined when the value is not a real handle:
 * search keywords ("python programming", "search:anime"), numeric uploader ids, placeholders.
 */
export function normalizeCreatorHandle(raw?: string | null): string | undefined {
  if (raw == null) return undefined;
  const h = String(raw).trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9._]{2,30}$/.test(h)) return undefined;
  if (/^\d+$/.test(h)) return undefined; // numeric uploader id, not a handle
  if (/^\.|\.$|\.\./.test(h)) return undefined; // Instagram forbids leading/trailing/double periods
  if (PLACEHOLDER_HANDLES.has(h.toLowerCase())) return undefined;
  return h;
}

export function buildCreditBlock(handle?: string): string {
  const who = handle ? `@${handle}` : "Original creator";
  return `📲 CONTENT SOURCE/CREDIT: ${who}\n(Respective Owner)\nDM FOR CREDIT OR REMOVAL`;
}

const CREDIT_LINE = /content\s*source|credit\s*:|credits?\s+to\b|^\W*(source|via)\s*:/i;
const CREDIT_TRAILER = /^\W*\(?\s*respective\s+owner\s*\)?\W*$|dm\s+(for\s+)?credit/i;
const HASHTAG_ONLY = /^\s*(#[^\s#]+\s*)+$/;

// InfoOnSpot's template opens with "Content taken by this page & for more follow\n@<creator>".
const CREDIT_HEADER = /content\s+taken\s+by\s+this\s+page/i;

/**
 * Idempotent: removes any existing credit lines, rewrites the template's header handle to the
 * verified one (or drops that header when the creator is unknown), then inserts exactly one
 * verified credit block.
 */
export function applyCreditLine(description: string, handle?: string): string {
  const lines = (description || "").split("\n");
  const withHeader: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!CREDIT_HEADER.test(lines[i])) {
      withHeader.push(lines[i]);
      continue;
    }
    // the handle may be on the next non-empty line
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    const hasHandleLine = j < lines.length && /^\s*@\S+\s*$/.test(lines[j]);
    if (handle) {
      withHeader.push(lines[i].trim(), `@${handle}`);
    }
    if (hasHandleLine) i = j; // consume the old handle line either way
  }
  const kept = withHeader.filter((line) => !CREDIT_LINE.test(line) && !CREDIT_TRAILER.test(line));
  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const block = buildCreditBlock(handle);

  const paragraphs = cleaned.split("\n\n");
  let lastTagPara = -1;
  paragraphs.forEach((p, i) => { if (HASHTAG_ONLY.test(p)) lastTagPara = i; });
  if (lastTagPara >= 0) paragraphs.splice(lastTagPara, 0, block);
  else paragraphs.push(block);
  return paragraphs.join("\n\n");
}
