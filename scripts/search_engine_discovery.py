#!/usr/bin/env python3
"""
scripts/search_engine_discovery.py — Discovers public Instagram Reels via search engines
without requiring any Instagram login, account, cookies, or proxies.

Usage:
    python3 scripts/search_engine_discovery.py --profile codeorcap --limit 10
    python3 scripts/search_engine_discovery.py --keywords "python,javascript,reactjs" --limit 10
"""

import sys
import json
import re
import time
import argparse
import urllib.parse
import urllib.request

REEL_REGEX = re.compile(r"instagram\.com/reel/([A-Za-z0-9_-]+)")

NICHE_KEYWORDS = {
    # tech/AI info + claim verification
    "codeorcap": [
        "tech fact check",
        "tech myth busted",
        "ai facts did you know",
        "chatgpt tips",
        "ai tools explained",
        "cybersecurity facts",
        "programming myths",
        "software engineer facts",
        "machine learning explained",
        "tech explained",
    ],
    # any story: movies, series, cartoons, anime, short films
    "storiyum": [
        "short film story",
        "anime story",
        "cartoon story",
        "movie scene explained",
        "web series clip",
        "anime edit",
        "story time",
        "moral story",
    ],
    # news / what is happening now
    "infoonspot": [
        "breaking news today",
        "latest news update",
        "tech news today",
        "ai news update",
        "trending news now",
        "current affairs today",
        "viral news",
    ],
    # funny / satire / sarcasm
    "prompt_gag": [
        "sarcasm reels",
        "satire comedy",
        "dry humor",
        "relatable memes",
        "funny sarcastic",
        "office humor",
        "savage roast",
        "deadpan comedy",
    ],
}


# Never re-source our own channels' reels (a "tech fact check" query returns @codeorcap itself).
OWN_BRAND_TERMS = ["codeorcap", "code or cap", "storiyum", "stori_yum", "infoonspot", "info onspot", "promptgag", "prompt_gag", "prompt gag"]

# News goes stale in days; restrict search-engine results to the past week ("d"/"w"/"m"/"y").
RECENCY = {"infoonspot": "w"}


def is_own_brand(*texts: str) -> bool:
    blob = " ".join(t for t in texts if t).lower()
    return any(term in blob for term in OWN_BRAND_TERMS)


def search_via_ddgs(keyword: str, max_results: int = 10, timelimit: str | None = None) -> list[dict]:
    """Search DuckDuckGo via the ddgs library."""
    try:
        from ddgs import DDGS
    except ImportError:
        try:
            from duckduckgo_search import DDGS
        except ImportError:
            print("WARN: neither ddgs nor duckduckgo_search is installed", file=sys.stderr)
            return []

    reels = []
    seen = set()
    queries = [
        f"site:instagram.com/reel/ {keyword}",
        f"site:instagram.com/reel/ \"{keyword}\"",
    ]

    for q in queries:
        try:
            ddgs = DDGS()
            results = list(ddgs.text(q, max_results=max_results, timelimit=timelimit))
            for item in results:
                href = item.get("href", "")
                if is_own_brand(item.get("title", ""), item.get("body", "")):
                    continue
                m = REEL_REGEX.search(href)
                if m:
                    shortcode = m.group(1)
                    if shortcode not in seen:
                        seen.add(shortcode)
                        reels.append({
                            "shortcode": shortcode,
                            "url": f"https://www.instagram.com/reel/{shortcode}/",
                            "like_count": 0,
                            "play_count": 0,
                            "comment_count": 0,
                            "owner_username": "",
                            "title": item.get("title", ""),
                            "source": "search_engine_ddgs",
                            "query": keyword,
                        })
            if reels:
                break
        except Exception:
            continue

    return reels


def search_via_bing_html(keyword: str, max_results: int = 10) -> list[dict]:
    """Fallback search using Bing HTML scraper if DDGS yields 0."""
    try:
        from bs4 import BeautifulSoup
        import base64
    except ImportError:
        print("WARN: beautifulsoup4 is not installed", file=sys.stderr)
        return []

    reels = []
    seen = set()
    query = f"site:instagram.com/reel/ {keyword}"
    url = f"https://www.bing.com/search?q={urllib.parse.quote(query)}"
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    }

    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=8) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
            soup = BeautifulSoup(html, "html.parser")
            for a in soup.find_all("a", href=True):
                href = a["href"]
                # Decode Bing /ck/a?!...&u=a1<base64> redirects
                match = re.search(r"u=a1([A-Za-z0-9_-]+)", href)
                target_url = href
                if match:
                    try:
                        b64 = match.group(1).replace("-", "+").replace("_", "/")
                        b64 += "=" * (-len(b64) % 4)
                        target_url = base64.b64decode(b64).decode("utf-8", errors="ignore")
                    except Exception:
                        pass
                if is_own_brand(a.get_text(strip=True)):
                    continue
                m_code = REEL_REGEX.search(target_url)
                if m_code:
                    shortcode = m_code.group(1)
                    if shortcode not in seen:
                        seen.add(shortcode)
                        reels.append({
                            "shortcode": shortcode,
                            "url": f"https://www.instagram.com/reel/{shortcode}/",
                            "like_count": 0,
                            "play_count": 0,
                            "comment_count": 0,
                            "owner_username": "",
                            "title": a.get_text(strip=True),
                            "source": "search_engine_bing",
                            "query": keyword,
                        })
                        if len(reels) >= max_results:
                            break
    except Exception:
        pass

    return reels


def discover_reels(keywords: list[str], limit: int = 10, timelimit: str | None = None) -> list[dict]:
    """Iterate through keywords until limit reels are discovered."""
    all_reels = []
    seen_codes = set()

    for kw in keywords:
        if len(all_reels) >= limit:
            break

        # 1. Primary: DDGS
        batch = search_via_ddgs(kw, max_results=limit, timelimit=timelimit)

        # 2. Fallback: Bing HTML
        if not batch:
            batch = search_via_bing_html(kw, max_results=limit)

        for r in batch:
            if r["shortcode"] not in seen_codes:
                seen_codes.add(r["shortcode"])
                all_reels.append(r)
                if len(all_reels) >= limit:
                    break

        # Polite interval between queries
        time.sleep(1.0)

    return all_reels


def main():
    parser = argparse.ArgumentParser(description="Search Engine Instagram Reel Discovery")
    parser.add_argument("--profile", type=str, default="", help="Profile key (e.g. codeorcap, storiyum)")
    parser.add_argument("--keywords", type=str, default="", help="Comma-separated keywords")
    parser.add_argument("--limit", type=int, default=10, help="Maximum reels to discover")
    args = parser.parse_args()

    kw_list = []
    timelimit = None
    if args.keywords:
        kw_list = [k.strip() for k in args.keywords.split(",") if k.strip()]
    elif args.profile:
        p_key = args.profile.lower().strip()
        p_key = p_key.replace("-", "_")
        if p_key == "promptgag":
            p_key = "prompt_gag"
        if p_key not in NICHE_KEYWORDS:
            print(f"WARN: unknown profile '{p_key}', using codeorcap keywords", file=sys.stderr)
        kw_list = NICHE_KEYWORDS.get(p_key, NICHE_KEYWORDS["codeorcap"])
        timelimit = RECENCY.get(p_key)
    else:
        kw_list = NICHE_KEYWORDS["codeorcap"]

    reels = discover_reels(kw_list, limit=args.limit, timelimit=timelimit)

    for r in reels:
        print(json.dumps(r))

    if not reels:
        sys.exit(1)


if __name__ == "__main__":
    main()
