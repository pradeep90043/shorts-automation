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
    "codeorcap": [
        "python programming",
        "javascript tips",
        "reactjs tutorial",
        "coding hacks",
        "developer life",
        "learn to code",
        "dsa leetcode",
        "machine learning ai",
        "web development",
        "software engineer tips",
    ],
    "storiyum": [
        "storytelling",
        "short film story",
        "motivational story",
        "inspirational story",
        "moral story",
        "real life stories",
        "emotional story",
        "heartfelt story",
    ],
    "infoonspot": [
        "ai technology",
        "tech news update",
        "future tech tools",
        "ai innovations",
        "new technology 2026",
    ],
    "promptgag": [
        "coding memes",
        "developer humor",
        "tech jokes",
        "programming memes",
        "programmer humor",
    ],
}


def search_via_ddgs(keyword: str, max_results: int = 10) -> list[dict]:
    """Search DuckDuckGo via the ddgs library."""
    try:
        from ddgs import DDGS
    except ImportError:
        try:
            from duckduckgo_search import DDGS
        except ImportError:
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
            results = list(ddgs.text(q, max_results=max_results))
            for item in results:
                href = item.get("href", "")
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


def discover_reels(keywords: list[str], limit: int = 10) -> list[dict]:
    """Iterate through keywords until limit reels are discovered."""
    all_reels = []
    seen_codes = set()

    for kw in keywords:
        if len(all_reels) >= limit:
            break

        # 1. Primary: DDGS
        batch = search_via_ddgs(kw, max_results=limit)

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
    if args.keywords:
        kw_list = [k.strip() for k in args.keywords.split(",") if k.strip()]
    elif args.profile:
        p_key = args.profile.lower().strip()
        kw_list = NICHE_KEYWORDS.get(p_key, NICHE_KEYWORDS["codeorcap"])
    else:
        kw_list = NICHE_KEYWORDS["codeorcap"]

    reels = discover_reels(kw_list, limit=args.limit)

    for r in reels:
        print(json.dumps(r))

    if not reels:
        sys.exit(1)


if __name__ == "__main__":
    main()
