import { pipelineLogger } from "../utils/logger";

/**
 * Real photos for the stickman "photo" panel, from sources whose licence allows use in a monetised video with a credit:
 * Wikimedia Commons (public domain / CC0 / CC BY / CC BY-SA only) and, when PEXELS_API_KEY is set, Pexels (Pexels License,
 * no attribution required but we still credit). News-agency photos are never fetched: they are not licensed for reuse.
 */
export interface LicensedPhoto { url: string; credit: string; license: string; pageUrl: string; source: "wikimedia" | "pexels" }

/** The app already has a Pexels key (video/pexelsService.ts): same variable names, same fallback. */
const pexelsKey = (): string => (process.env.PEXELS_API_KEY || process.env.PIXELS_API_KEY || process.env.PEXEL_API_KEY || "").trim();

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
  const key = pexelsKey();
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

// ── short licensed video clips ─────────────────────────────────────────────────────────────────────────────────
export interface LicensedClip extends Omit<LicensedPhoto, "source"> { source: "wikimedia" | "archive" | "nasa" | "pexels"; bytes?: number }
const MAX_CLIP_BYTES = 60 * 1024 * 1024;

export async function searchWikimediaClip(query: string): Promise<LicensedClip | null> {
  const api = "https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
    action: "query", format: "json", generator: "search", gsrnamespace: "6", gsrsearch: `${query} filetype:video`, gsrlimit: "10",
    prop: "imageinfo", iiprop: "url|size|mime|extmetadata",
  });
  const data = await getJson(api);
  const pages: any[] = Object.values(data?.query?.pages ?? {}).sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
  for (const pg of pages) {
    const ii = pg.imageinfo?.[0];
    if (!ii || !/^video\/(webm|mp4|ogg)/.test(ii.mime) || !ii.size || ii.size > MAX_CLIP_BYTES) continue;
    const meta = ii.extmetadata ?? {};
    const license = strip(String(meta.LicenseShortName?.value ?? ""));
    if (!ALLOWED.test(license) || String(meta.Restrictions?.value ?? "").trim()) continue;
    const author = strip(String(meta.Artist?.value ?? "")).slice(0, 50) || "Wikimedia Commons";
    return { url: ii.url, credit: `Footage: ${author} / Wikimedia Commons`.slice(0, 100), license: license.slice(0, 40), pageUrl: ii.descriptionurl, source: "wikimedia", bytes: ii.size };
  }
  return null;
}

export async function searchNasaClip(query: string): Promise<LicensedClip | null> {
  const data = await getJson(`https://images-api.nasa.gov/search?media_type=video&q=${encodeURIComponent(query)}`);
  for (const item of (data?.collection?.items ?? []).slice(0, 5)) {
    const nasaId = item?.data?.[0]?.nasa_id;
    if (!nasaId || !item.href) continue;
    const files: string[] = await getJson(item.href).catch(() => []);
    const mp4 = files.find((f) => /~(medium|mobile)\.mp4$/i.test(f)) || files.find((f) => /\.mp4$/i.test(f) && !/~orig/i.test(f));
    if (!mp4) continue;
    return { url: mp4.replace(/^http:/, "https:"), credit: "Footage: NASA", license: "Public domain (NASA)", pageUrl: `https://images.nasa.gov/details/${nasaId}`, source: "nasa" };
  }
  return null;
}

export async function searchArchiveClip(query: string): Promise<LicensedClip | null> {
  const q = `(${query.replace(/[():"]/g, " ")}) AND mediatype:movies AND (licenseurl:*publicdomain* OR collection:(prelinger OR nasa))`;
  const data = await getJson("https://archive.org/advancedsearch.php?" + new URLSearchParams({ q, rows: "6", output: "json", sort: "downloads desc" }) + "&fl%5B%5D=identifier&fl%5B%5D=creator&fl%5B%5D=licenseurl");
  for (const doc of data?.response?.docs ?? []) {
    const meta = await getJson(`https://archive.org/metadata/${doc.identifier}`).catch(() => null);
    const f = (meta?.files ?? []).find((x: any) => /^(MPEG4|h\.264)/i.test(x.format ?? "") && Number(x.size) > 0 && Number(x.size) <= MAX_CLIP_BYTES);
    if (!f) continue;
    const lic = String(doc.licenseurl ?? "");
    const license = /publicdomain/.test(lic) ? "Public domain" : "Public domain (Prelinger/NASA)";
    return {
      url: `https://archive.org/download/${doc.identifier}/${encodeURIComponent(f.name)}`,
      credit: (() => { const who = String(Array.isArray(doc.creator) ? doc.creator[0] : doc.creator ?? "").slice(0, 50); return who && who !== "Internet Archive" ? `Footage: ${who} / Internet Archive` : "Footage: Internet Archive"; })(),
      license, pageUrl: `https://archive.org/details/${doc.identifier}`, source: "archive", bytes: Number(f.size),
    };
  }
  return null;
}

export async function searchPexelsClip(query: string): Promise<LicensedClip | null> {
  const key = pexelsKey();
  if (!key) return null;
  const data = await getJson(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=4&orientation=landscape&size=medium`, { Authorization: key });
  for (const v of data?.videos ?? []) {
    const file = (v.video_files ?? []).filter((f: any) => f.file_type === "video/mp4" && f.width >= 1280 && f.width <= 1920).sort((a: any, b: any) => a.width - b.width)[0];
    if (file) return { url: file.link, credit: `Footage: ${String(v.user?.name ?? "Pexels").slice(0, 50)} / Pexels`, license: "Pexels License", pageUrl: v.url, source: "pexels" };
  }
  return null;
}

/** Best licensed short clip for `query`, or null. Open archives first, then Pexels (key needed). Never throws. */
export async function findLicensedClip(query: string): Promise<LicensedClip | null> {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!q) return null;
  for (const [name, fn] of [["NASA", searchNasaClip], ["Wikimedia", searchWikimediaClip], ["Pexels", searchPexelsClip], ["Archive.org", searchArchiveClip]] as const) {
    try {
      const hit = await fn(q);
      if (hit) { pipelineLogger.info(`[Clip] "${q}" -> ${name}: ${hit.credit} (${hit.license})`, "PhotoFetcher"); return hit; }
    } catch (err: any) {
      pipelineLogger.warn(`[Clip] ${name} search for "${q}" failed: ${err?.message ?? err}`, "PhotoFetcher");
    }
  }
  return null;
}
