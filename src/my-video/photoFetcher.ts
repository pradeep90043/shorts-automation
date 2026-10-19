import { pipelineLogger } from "../utils/logger";

/**
 * Real photos for the stickman "photo" panel, from sources whose licence allows use in a monetised video with a credit:
 * Wikimedia Commons (public domain / CC0 / CC BY / CC BY-SA only) and, when PEXELS_API_KEY is set, Pexels (Pexels License,
 * no attribution required but we still credit). News-agency photos are never fetched: they are not licensed for reuse.
 */
export interface LicensedPhoto { url: string; credit: string; license: string; pageUrl: string; source: "wikimedia" | "pexels" }

const UA = "CodeOrCapBot/1.0 (https://codeorcap.example; pradeep90043@gmail.com)";
const ALLOWED = /^(public domain|pd\b|cc0|cc[- ]by(?:[- ]sa)?\b|cc[- ]by[- ]\d)/i;
const strip = (html: string): string => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function searchWikimedia(query: string): Promise<LicensedPhoto | null> {
  const api = "https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
    action: "query", format: "json", generator: "search", gsrnamespace: "6", gsrsearch: `${query} filetype:bitmap`, gsrlimit: "12",
    prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "1400",
  });
  const data = await getJson(api);
  const pages: any[] = Object.values(data?.query?.pages ?? {}).sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
  for (const pg of pages) {
    const ii = pg.imageinfo?.[0];
    if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime) || (ii.width ?? 0) < 1000 || (ii.height ?? 0) < 600) continue;
    const meta = ii.extmetadata ?? {};
    const license = strip(String(meta.LicenseShortName?.value ?? ""));
    if (!ALLOWED.test(license)) continue;
    if (String(meta.Restrictions?.value ?? "").trim()) continue; // personality / trademark restrictions
    const author = strip(String(meta.Artist?.value ?? "")).slice(0, 50) || "Wikimedia Commons";
    return {
      url: ii.thumburl || ii.url,
      credit: `Photo: ${author} / Wikimedia Commons`.slice(0, 100),
      license: license.slice(0, 40),
      pageUrl: ii.descriptionurl,
      source: "wikimedia",
    };
  }
  return null;
}

export async function searchPexels(query: string): Promise<LicensedPhoto | null> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  const data = await getJson(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape`, { Authorization: key });
  const p = data?.photos?.[0];
  if (!p?.src?.large2x) return null;
  return { url: p.src.large2x, credit: `Photo: ${String(p.photographer ?? "Pexels").slice(0, 50)} / Pexels`, license: "Pexels License", pageUrl: p.url, source: "pexels" };
}

/** Best licensed photo for `query`, or null (never throws: a missing photo must not fail a video). */
export async function findLicensedPhoto(query: string): Promise<LicensedPhoto | null> {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!q) return null;
  for (const [name, fn] of [["Wikimedia", searchWikimedia], ["Pexels", searchPexels]] as const) {
    try {
      const hit = await fn(q);
      if (hit) { pipelineLogger.info(`[Photo] "${q}" -> ${name}: ${hit.credit} (${hit.license})`, "PhotoFetcher"); return hit; }
    } catch (err: any) {
      pipelineLogger.warn(`[Photo] ${name} search for "${q}" failed: ${err?.message ?? err}`, "PhotoFetcher");
    }
  }
  pipelineLogger.info(`[Photo] no licensed photo found for "${q}"`, "PhotoFetcher");
  return null;
}
