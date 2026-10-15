/**
 * Web research for a topic: search, fetch a few pages, keep readable text. Network access is injected (`fetchText`) so
 * the parsing is testable offline. Everything is capped: the box is small and the free LLM has a small context.
 */
export interface Source {
  n: number;
  url: string;
  title: string;
  text: string;
  /** a date found in the page (YYYY-MM-DD or as written), when there is one */
  date?: string;
}

export interface ResearchResult {
  topic: string;
  sources: Source[];
  /** the text handed to the LLM and used by the number guard: "[1] title (date)\n text" blocks */
  text: string;
}

export type FetchText = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<string>;

const decode = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ");

/** Results of DuckDuckGo's HTML endpoint: title, the real target url (unwrapped from the /l/?uddg= redirect) and snippet. */
export function parseDuckDuckGoHtml(html: string): { title: string; url: string; snippet: string }[] {
  const out: { title: string; url: string; snippet: string }[] = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|$)/g;
  for (const m of html.matchAll(re)) {
    let href = decode(m[1]);
    const u = /[?&]uddg=([^&]+)/.exec(href);
    if (u) href = decodeURIComponent(u[1]);
    if (href.startsWith("//")) href = "https:" + href;
    const snip = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/.exec(m[3]);
    out.push({
      title: decode(m[2].replace(/<[^>]+>/g, "")).trim(),
      url: href,
      snippet: snip ? decode(snip[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "",
    });
  }
  return out.filter((r) => /^https?:\/\//i.test(r.url));
}

/** Readable text of an HTML page: scripts, styles, nav and tags removed, whitespace collapsed. */
export function extractReadableText(html: string): string {
  let t = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  t = decode(t).replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  // keep paragraphs that read like sentences (menus and cookie banners are short fragments)
  return t.split("\n").map((l) => l.trim()).filter((l) => l.split(/\s+/).length >= 6).join("\n");
}

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
/** First publication-looking date in the page: meta tags first, then "12 Oct 2026" / "October 12, 2026" / 2026-10-12. */
export function findDate(html: string): string | undefined {
  const meta = /(?:article:published_time|datePublished|pubdate|og:updated_time)["'][^>]*?(?:content=|:)\s*["']?(\d{4}-\d{2}-\d{2})/i.exec(html);
  if (meta) return meta[1];
  const iso = /\b(20\d{2}-[01]\d-[0-3]\d)\b/.exec(html);
  if (iso) return iso[1];
  const dmy = new RegExp(`\\b([0-3]?\\d)\\s+(${MONTHS})[a-z]*\\.?,?\\s+(20\\d{2})\\b`, "i").exec(html);
  if (dmy) return `${dmy[1]} ${dmy[2]} ${dmy[3]}`;
  const mdy = new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+([0-3]?\\d),?\\s+(20\\d{2})\\b`, "i").exec(html);
  if (mdy) return `${mdy[2]} ${mdy[1]} ${mdy[3]}`;
  return undefined;
}

/** Only public http(s) pages: never localhost, private ranges or file/ftp URLs (research must not reach the box's network). */
export function isSafePublicUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === "::1" || h.startsWith("[")) return false;
  return true;
}

const SKIP_HOSTS = /(youtube\.com|youtu\.be|instagram\.com|facebook\.com|tiktok\.com|pinterest\.|twitter\.com|x\.com|reddit\.com)$/i;

export interface ResearchOptions {
  maxPages?: number;
  maxCharsPerPage?: number;
  totalChars?: number;
}

export async function researchTopic(topic: string, fetchText: FetchText, opts: ResearchOptions = {}): Promise<ResearchResult> {
  const maxPages = opts.maxPages ?? 5;
  const perPage = opts.maxCharsPerPage ?? 3500;
  const total = opts.totalChars ?? 14000;

  let results: { title: string; url: string; snippet: string }[] = [];
  try {
    const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(topic)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; research/1.0)" },
    });
    results = parseDuckDuckGoHtml(html);
  } catch {
    results = [];
  }
  const sources: Source[] = [];
  const seenHosts = new Set<string>();
  let used = 0;
  for (const r of results) {
    if (sources.length >= maxPages || used >= total) break;
    if (!isSafePublicUrl(r.url)) continue;
    const host = new URL(r.url).hostname.replace(/^www\./, "");
    if (SKIP_HOSTS.test(host) || seenHosts.has(host)) continue;
    seenHosts.add(host);
    try {
      const html = await fetchText(r.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; research/1.0)" } });
      const text = extractReadableText(html).slice(0, Math.min(perPage, total - used));
      if (text.split(/\s+/).length < 40) continue; // an error page, a paywall stub or a video page
      sources.push({ n: sources.length + 1, url: r.url, title: r.title, text, date: findDate(html) });
      used += text.length;
    } catch {
      /* one unreachable page must not fail the research */
    }
  }
  // the search snippets are still facts from named pages when no page could be read
  if (!sources.length) {
    for (const r of results.slice(0, maxPages)) {
      if (r.snippet.split(/\s+/).length >= 8) sources.push({ n: sources.length + 1, url: r.url, title: r.title, text: r.snippet });
    }
  }
  const text = sources.map((s) => `[${s.n}] ${s.title}${s.date ? ` (${s.date})` : ""} - ${s.url}\n${s.text}`).join("\n\n");
  return { topic, sources, text };
}
