#!/usr/bin/env python3
"""
fetch_reels.py — list a user's recent Instagram Reels via the private mobile API.

Auth strategy (tried in order, first success wins):
  1. browser-cookie3  → reads live sessionid directly from Chrome/Firefox on
                        this machine (no manual export ever needed).
  2. cookies.txt      → Netscape-format file passed as second CLI arg (fallback
                        for headless/Docker environments where no browser exists).

Outputs one JSON object per line: {"shortcode": "...", "url": "..."}

Usage:
    python3 fetch_reels.py <username> [path/to/cookies.txt] [max_count]
"""

import sys
import json
import urllib.request
import urllib.parse
import urllib.error
import time
import os

# ── Instagram mobile app identity ────────────────────────────────────────────
APP_ID   = "936619743392459"
USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Mobile/15E148 Instagram/334.0.0.42.95 "
    "(iPhone14,3; iOS 17_5; en_US; en-US; scale=3.00; 1284x2778; 647227942)"
)

# Persist user_id resolutions so we only hit /web_profile_info/ once per username.
CACHE_FILE = "/app/logs/user_id_cache.json"
# Fallback cache path when not running in Docker
LOCAL_CACHE_FILE = os.path.join(os.path.dirname(__file__), "..", "logs", "user_id_cache.json")

# ─────────────────────────────────────────────────────────────────────────────

def load_id_cache() -> dict:
    for path in [CACHE_FILE, LOCAL_CACHE_FILE]:
        try:
            with open(path, "r") as fh:
                return json.load(fh)
        except Exception:
            pass
    return {}


def save_id_cache(cache: dict) -> None:
    for path in [CACHE_FILE, LOCAL_CACHE_FILE]:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as fh:
                json.dump(cache, fh)
            return
        except Exception:
            pass


def load_cookies_from_browser() -> dict:
    """
    Try to load Instagram session cookies directly from the local browser DB.
    Uses browser-cookie3 which reads Chrome/Firefox SQLite stores without
    requiring any manual export — works as long as the user is logged in to
    Instagram in their browser on this machine.

    Returns {} if browser-cookie3 is not installed or reading fails.
    """
    try:
        import browser_cookie3  # type: ignore

        # Try Chrome first, then Firefox
        for loader, name in [
            (browser_cookie3.chrome, "chrome"),
            (browser_cookie3.firefox, "firefox"),
        ]:
            try:
                jar = loader(domain_name=".instagram.com")
                cookies: dict = {c.name: c.value for c in jar}
                if cookies.get("sessionid"):
                    print(f"INFO: Loaded Instagram session from {name} browser cookies.", file=sys.stderr)
                    return cookies
            except Exception as exc:
                print(f"WARN: Could not load {name} cookies: {exc}", file=sys.stderr)

        print("WARN: browser-cookie3 found no sessionid in Chrome or Firefox.", file=sys.stderr)
        return {}
    except ImportError:
        print("WARN: browser-cookie3 not installed; skipping browser auth.", file=sys.stderr)
        return {}


def parse_netscape_cookies(path: str) -> dict:
    """Return a {name: value} dict from a Netscape-format cookies.txt file."""
    cookies: dict = {}
    try:
        with open(path, "r", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) >= 7:
                    cookies[parts[5]] = parts[6]
    except Exception as exc:
        print(f"WARN: could not parse cookies.txt: {exc}", file=sys.stderr)
    return cookies


def load_cookies_from_env() -> dict:
    """
    Read sessionid (and optional csrftoken) from environment variables.
    Set INSTAGRAM_SESSION_ID in .env — lasts ~90 days, no manual export needed.
    """
    session_id = os.environ.get("INSTAGRAM_SESSION_ID", "").strip()
    if not session_id:
        return {}
    cookies: dict = {"sessionid": session_id}
    csrf = os.environ.get("INSTAGRAM_CSRF_TOKEN", "").strip()
    if csrf:
        cookies["csrftoken"] = csrf
    print("INFO: Using INSTAGRAM_SESSION_ID from environment.", file=sys.stderr)
    return cookies


def resolve_cookies(cookies_path: str | None) -> dict:
    """
    Returns an authenticated cookies dict, trying in order:
      1. INSTAGRAM_SESSION_ID env var  — set once in .env, lasts ~90 days
      2. Live browser cookies           — Chrome/Firefox via browser-cookie3
      3. cookies.txt file               — manual Netscape export fallback
    """
    # 1. Env var (preferred — works everywhere, no browser needed)
    env_cookies = load_cookies_from_env()
    if env_cookies.get("sessionid"):
        return env_cookies

    # 2. Browser cookies (auto, no export needed when browser is logged in)
    browser_cookies = load_cookies_from_browser()
    if browser_cookies.get("sessionid"):
        return browser_cookies

    # 3. cookies.txt fallback
    if cookies_path and os.path.isfile(cookies_path):
        file_cookies = parse_netscape_cookies(cookies_path)
        if file_cookies.get("sessionid"):
            print("INFO: Using cookies.txt for auth.", file=sys.stderr)
            return file_cookies
        else:
            print("WARN: cookies.txt has no sessionid — may be expired.", file=sys.stderr)
    else:
        if cookies_path:
            print(f"WARN: cookies.txt not found at '{cookies_path}'", file=sys.stderr)

    return {}


def build_request(url: str, cookies: dict) -> urllib.request.Request:
    """Return a prepared Request with mobile headers and session cookies."""
    important = ["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did"]
    cookie_header = "; ".join(f"{k}={cookies[k]}" for k in important if k in cookies)

    headers = {
        "User-Agent":    USER_AGENT,
        "Accept":        "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "X-IG-App-ID":  APP_ID,
        "X-IG-WWW-Claim": "0",
        "Cookie":        cookie_header,
    }
    if "csrftoken" in cookies:
        headers["X-CSRFToken"] = cookies["csrftoken"]

    return urllib.request.Request(url, headers=headers)


def fetch_json(req: urllib.request.Request, timeout: int = 15) -> dict:
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_user_id(username: str, cookies: dict, cache: dict) -> str | None:
    """Resolve a username → numeric user ID. Uses a persistent cache to avoid
    redundant API calls on subsequent runs."""
    if username in cache:
        return cache[username]

    url = f"https://www.instagram.com/api/v1/users/web_profile_info/?username={urllib.parse.quote(username)}"
    try:
        data = fetch_json(build_request(url, cookies))
        user_id: str = data["data"]["user"]["id"]
        cache[username] = user_id
        save_id_cache(cache)
        return user_id
    except Exception as exc:
        print(f"WARN: could not resolve user_id for @{username}: {exc}", file=sys.stderr)
        return None


def get_reels_via_clips(user_id: str, cookies: dict, max_count: int) -> list[dict]:
    """Fetch reels using the /api/v1/clips/user/ endpoint (mobile feed)."""
    results: list[dict] = []
    max_id = ""
    while len(results) < max_count:
        params = {"target_user_id": user_id, "page_size": "12"}
        if max_id:
            params["max_id"] = max_id
        url = "https://i.instagram.com/api/v1/clips/user/?" + urllib.parse.urlencode(params)
        try:
            data = fetch_json(build_request(url, cookies))
        except urllib.error.HTTPError as exc:
            print(f"WARN: clips API returned HTTP {exc.code}: {exc.reason}", file=sys.stderr)
            break
        except Exception as exc:
            print(f"WARN: clips API error: {exc}", file=sys.stderr)
            break

        items = data.get("items", [])
        if not items:
            break

        for item in items:
            media = item.get("media", item)
            code = media.get("code") or media.get("shortcode") or ""
            if code and not any(r["shortcode"] == code for r in results):
                owner = media.get("user", {}) or {}
                results.append({
                    "shortcode": code,
                    "url": f"https://www.instagram.com/reel/{code}/",
                    "like_count": media.get("like_count") or 0,
                    "play_count": media.get("play_count") or media.get("view_count") or 0,
                    "comment_count": media.get("comment_count") or 0,
                    "owner_username": owner.get("username") or "",
                })
            if len(results) >= max_count:
                break

        # Pagination
        paging = data.get("paging_info", {})
        if not paging.get("more_available"):
            break
        max_id = paging.get("max_id", "")
        if not max_id:
            break
        time.sleep(0.5)  # be polite between pagination calls

    return results


def get_reels_via_feed(user_id: str, cookies: dict, max_count: int) -> list[dict]:
    """Fallback: fetch via /api/v1/feed/user/{id}/ and filter for clips."""
    results: list[dict] = []
    url = f"https://i.instagram.com/api/v1/feed/user/{user_id}/?count=20"
    try:
        data = fetch_json(build_request(url, cookies))
    except Exception as exc:
        print(f"WARN: feed API error: {exc}", file=sys.stderr)
        return results

    for item in data.get("items", []):
        # Only include actual reels (media_type=2 clips)
        if item.get("media_type") != 2 or not item.get("product_type") == "clips":
            continue
        code = item.get("code") or ""
        if code and not any(r["shortcode"] == code for r in results):
            owner = item.get("user", {}) or {}
            results.append({
                "shortcode": code,
                "url": f"https://www.instagram.com/reel/{code}/",
                "like_count": item.get("like_count") or 0,
                "play_count": item.get("play_count") or item.get("view_count") or 0,
                "comment_count": item.get("comment_count") or 0,
                "owner_username": owner.get("username") or "",
            })
        if len(results) >= max_count:
            break

    return results


def _is_rate_limit(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "429" in msg or "rate" in msg or "too many" in msg


def fetch_post(url: str, cookies: dict, body: dict, timeout: int = 20) -> dict:
    """POST application/x-www-form-urlencoded and return parsed JSON."""
    important = ["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did"]
    cookie_header = "; ".join(f"{k}={cookies[k]}" for k in important if k in cookies)
    data = urllib.parse.urlencode(body).encode("utf-8")
    headers = {
        "User-Agent":    USER_AGENT,
        "Accept":        "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "X-IG-App-ID":  APP_ID,
        "X-IG-WWW-Claim": "0",
        "Content-Type":  "application/x-www-form-urlencoded",
        "Cookie":        cookie_header,
    }
    if "csrftoken" in cookies:
        headers["X-CSRFToken"] = cookies["csrftoken"]
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _parse_sections(data: dict, seen: set, limit: int, tag: str) -> list[dict]:
    """Extract reel entries from a hashtag sections API response."""
    results = []
    for section in data.get("sections", []):
        for layout_item in section.get("layout_content", {}).get("medias", []):
            media = layout_item.get("media", {})
            # Only include reels/clips (media_type 2)
            if media.get("media_type") not in (2, None):
                continue
            code = media.get("code") or media.get("shortcode") or ""
            if not code or code in seen:
                continue
            seen.add(code)
            owner = media.get("user", {}) or {}
            results.append({
                "shortcode": code,
                "url": f"https://www.instagram.com/reel/{code}/",
                "like_count": media.get("like_count") or 0,
                "play_count": media.get("play_count") or media.get("view_count") or 0,
                "comment_count": media.get("comment_count") or 0,
                "owner_username": owner.get("username") or "",
            })
            if len(results) >= limit:
                break
        if len(results) >= limit:
            break
    return results


def bootstrap_csrf(cookies: dict) -> dict:
    """Fetch a fresh csrftoken from Instagram's API if not already present."""
    if cookies.get("csrftoken"):
        return cookies

    # Hit the accounts/login/ajax/ endpoint which returns a Set-Cookie with csrftoken
    for url in [
        "https://www.instagram.com/accounts/login/ajax/",
        "https://www.instagram.com/",
        "https://i.instagram.com/api/v1/accounts/current_user/?edit=true",
    ]:
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "*/*",
                    "X-IG-App-ID": APP_ID,
                    "Cookie": f"sessionid={cookies.get('sessionid', '')}",
                },
            )
            import http.cookiejar
            jar = http.cookiejar.CookieJar()
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
            opener.open(req, timeout=8)
            for cookie in jar:
                if cookie.name == "csrftoken" and cookie.value:
                    cookies = dict(cookies)
                    cookies["csrftoken"] = cookie.value
                    print(f"INFO: Bootstrapped csrftoken from {url}", file=sys.stderr)
                    return cookies
        except Exception:
            continue

    return cookies


def fetch_hashtag_via_web(cookies: dict, tag: str, limit: int, seen: set) -> list[dict]:
    """Fallback: use Instagram web explore endpoint (GET, no CSRF needed)."""
    tag_clean = tag.lstrip("#")
    tag_enc = urllib.parse.quote(tag_clean, safe="")
    results = []
    # Instagram web hashtag page returns JSON when __a=1 is appended
    for url in [
        f"https://www.instagram.com/explore/tags/{tag_enc}/?__a=1&__d=dis",
        f"https://www.instagram.com/explore/tags/{tag_enc}/?__a=1",
    ]:
        try:
            data = fetch_json(build_request(url, cookies))
            edges = (
                data.get("data", {}).get("recent", {}).get("sections", []) or
                data.get("graphql", {}).get("hashtag", {}).get("edge_hashtag_to_media", {}).get("edges", [])
            )
            # Handle GraphQL edges format
            for edge in edges:
                node = edge.get("node", edge)
                code = node.get("shortcode") or node.get("code") or ""
                if not code or code in seen:
                    continue
                seen.add(code)
                results.append({
                    "shortcode": code,
                    "url": f"https://www.instagram.com/reel/{code}/",
                    "like_count": node.get("edge_liked_by", {}).get("count") or node.get("like_count") or 0,
                    "play_count": node.get("video_view_count") or node.get("play_count") or 0,
                    "comment_count": node.get("edge_media_to_comment", {}).get("count") or node.get("comment_count") or 0,
                    "owner_username": node.get("owner", {}).get("username") or "",
                })
                if len(results) >= limit:
                    break
            if results:
                break
        except Exception as exc:
            print(f"WARN: web hashtag fallback error for #{tag_clean}: {exc}", file=sys.stderr)
            continue
    return results


def get_instagrapi_client() -> "object | None":
    """Get an authenticated instagrapi client, loading session from file or env."""
    try:
        from instagrapi import Client  # type: ignore
    except ImportError as exc:
        print(f"WARN: instagrapi not available: {exc}", file=sys.stderr)
        return None

    INSTAGRAPI_SESSION_FILE = None
    for path in ["/app/logs/instagrapi_session.json", os.path.join(os.path.dirname(__file__), "..", "logs", "instagrapi_session.json")]:
        if os.path.isfile(path):
            INSTAGRAPI_SESSION_FILE = path
            break

    cl = Client()
    cl.delay_range = [1, 3]

    # Try loading saved session first
    if INSTAGRAPI_SESSION_FILE:
        try:
            cl.load_settings(INSTAGRAPI_SESSION_FILE)
            cl.get_timeline_feed()  # quick auth check
            print("INFO: instagrapi session loaded from file.", file=sys.stderr)
            return cl
        except Exception:
            pass

    # Fall back to username/password login
    username = os.environ.get("INSTAGRAM_USERNAME", "").strip()
    password = os.environ.get("INSTAGRAM_PASSWORD", "").strip()
    totp_secret = os.environ.get("INSTAGRAM_TOTP_SECRET", "").strip()
    if not username or not password:
        print("WARN: INSTAGRAM_USERNAME/PASSWORD not set — can't use instagrapi.", file=sys.stderr)
        return None

    try:
        verification_code = None
        if totp_secret:
            try:
                import pyotp  # type: ignore
                verification_code = pyotp.TOTP(totp_secret).now()
            except Exception:
                pass
        cl.login(username, password, verification_code=verification_code)
        if INSTAGRAPI_SESSION_FILE:
            os.makedirs(os.path.dirname(INSTAGRAPI_SESSION_FILE), exist_ok=True)
            cl.dump_settings(INSTAGRAPI_SESSION_FILE)
        print(f"INFO: instagrapi logged in as @{username}.", file=sys.stderr)
        return cl
    except Exception as exc:
        print(f"WARN: instagrapi login failed: {exc}", file=sys.stderr)
        return None


def fetch_hashtag_reels_with_client(cl: "object | None", cookies: dict, tag: str, limit: int) -> list[dict]:
    """Fetch top reels for one hashtag using a pre-built instagrapi client (or fallback)."""
    tag_clean = tag.lstrip("#")
    results: list[dict] = []

    # ── Strategy 1: instagrapi (shared client — no re-login per tag) ─────────
    if cl:
        try:
            medias = cl.hashtag_medias_top_v1(tag_clean, amount=limit)
            for media in medias:
                shortcode = getattr(media, "code", None) or str(getattr(media, "pk", ""))
                if not shortcode:
                    continue
                owner_username = ""
                user = getattr(media, "user", None)
                if user:
                    owner_username = getattr(user, "username", "") or ""
                results.append({
                    "shortcode": shortcode,
                    "url": f"https://www.instagram.com/reel/{shortcode}/",
                    "like_count": getattr(media, "like_count", 0) or 0,
                    "play_count": getattr(media, "play_count", 0) or getattr(media, "view_count", 0) or 0,
                    "comment_count": getattr(media, "comment_count", 0) or 0,
                    "owner_username": owner_username,
                    "source_hashtag": tag_clean,
                })
            if results:
                print(f"INFO: instagrapi found {len(results)} top reel(s) for #{tag_clean}", file=sys.stderr)
                return results
        except Exception as exc:
            if _is_rate_limit(exc):
                print(f"RATE_LIMITED: instagrapi #{tag_clean}", file=sys.stderr)
                sys.exit(2)
            print(f"WARN: instagrapi hashtag failed for #{tag_clean}: {exc}", file=sys.stderr)

    # ── Strategy 2: direct POST sections API with CSRF bootstrap ────────────
    tag_enc = urllib.parse.quote(tag_clean, safe="")
    seen: set[str] = set()
    cookies = bootstrap_csrf(cookies)
    sections_url = f"https://i.instagram.com/api/v1/tags/{tag_enc}/sections/"
    for tab in ("top", "recent"):
        if len(results) >= limit:
            break
        body = {"tab": tab, "page": "1", "next_media_ids": "", "surface": "grid", "count": str(limit)}
        try:
            data = fetch_post(sections_url, cookies, body)
            results.extend(_parse_sections(data, seen, limit - len(results), tag_clean))
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                print(f"RATE_LIMITED: hashtag #{tag_clean}", file=sys.stderr)
                sys.exit(2)
            print(f"WARN: sections API {exc.code} for #{tag_clean} [{tab}]: {exc.reason}", file=sys.stderr)
        except Exception as exc:
            if _is_rate_limit(exc):
                print(f"RATE_LIMITED: hashtag #{tag_clean}", file=sys.stderr)
                sys.exit(2)

    return results


def main():
    import argparse

    # Support both legacy positional form and new --mode flag form.
    # If first arg doesn't start with '-', fall back to legacy parsing.
    if len(sys.argv) >= 2 and not sys.argv[1].startswith("-"):
        # Legacy: fetch_reels.py <username> [cookies.txt] [max_count]
        username     = sys.argv[1]
        cookies_path = sys.argv[2] if len(sys.argv) > 2 else None
        max_count    = int(sys.argv[3]) if len(sys.argv) > 3 else 20
        mode         = "channel"
        tag          = None
    else:
        parser = argparse.ArgumentParser(description="Fetch Instagram reels by channel or hashtag")
        parser.add_argument("--mode", choices=["channel", "hashtag"], default="channel")
        parser.add_argument("--username", default=None, help="Instagram username (channel mode)")
        parser.add_argument("--tags", default=None,
                            help="Comma-separated hashtags without # (hashtag mode; all fetched in one process)")
        parser.add_argument("--tag", default=None, help="Single hashtag — alias for --tags with one value")
        parser.add_argument("--cookies", default=None, help="Path to cookies.txt")
        parser.add_argument("--limit", type=int, default=20, help="Max reels per hashtag")
        args = parser.parse_args()
        mode         = args.mode
        username     = args.username
        cookies_path = args.cookies
        max_count    = args.limit
        # --tags takes priority; --tag is a convenience alias
        raw_tags     = args.tags or args.tag or ""
        tag          = raw_tags  # kept for single-tag compat below

    cookies = resolve_cookies(cookies_path)

    if not cookies.get("sessionid"):
        print(
            "ERROR: No sessionid available.\n"
            "  • Make sure you are logged in to Instagram in Chrome or Firefox on this machine.\n"
            "  • Or export cookies.txt with the 'Get cookies.txt LOCALLY' browser extension.",
            file=sys.stderr,
        )
        sys.exit(1)

    if mode == "hashtag":
        if not tag:
            print("ERROR: --tag or --tags is required in hashtag mode", file=sys.stderr)
            sys.exit(1)

        # All tags fetched in ONE process — single instagrapi login, rate-limit-safe delays.
        tag_list = [t.strip().lstrip("#") for t in tag.split(",") if t.strip()]
        if not tag_list:
            sys.exit(1)

        cl = get_instagrapi_client()
        reels = []
        seen_codes: set[str] = set()

        for i, tag_name in enumerate(tag_list):
            if i > 0:
                # Polite delay between hashtag calls (3-5s) — avoids per-minute rate limits
                time.sleep(3 + (i % 3))

            batch = fetch_hashtag_reels_with_client(cl, cookies, tag_name, max_count)
            for r in batch:
                if r["shortcode"] not in seen_codes:
                    seen_codes.add(r["shortcode"])
                    reels.append(r)
                    print(json.dumps(r))

        if not reels:
            sys.exit(1)

    else:
        if not username:
            print("Usage: fetch_reels.py <username> [cookies.txt] [max_count]", file=sys.stderr)
            sys.exit(1)
        cache = load_id_cache()
        user_id = get_user_id(username, cookies, cache)
        if not user_id:
            sys.exit(1)
        reels = get_reels_via_clips(user_id, cookies, max_count)
        if not reels:
            reels = get_reels_via_feed(user_id, cookies, max_count)

        for reel in reels:
            print(json.dumps(reel))

        if not reels:
            sys.exit(1)


if __name__ == "__main__":
    main()
