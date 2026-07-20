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


def resolve_cookies(cookies_path: str | None) -> dict:
    """
    Returns an authenticated cookies dict, trying:
      1. Live browser cookies (Chrome → Firefox via browser-cookie3)
      2. cookies.txt file passed as arg
    """
    # 1. Browser (always fresh — preferred)
    browser_cookies = load_cookies_from_browser()
    if browser_cookies.get("sessionid"):
        return browser_cookies

    # 2. cookies.txt fallback
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
                results.append({
                    "shortcode": code,
                    "url": f"https://www.instagram.com/reel/{code}/",
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
            results.append({
                "shortcode": code,
                "url": f"https://www.instagram.com/reel/{code}/",
            })
        if len(results) >= max_count:
            break

    return results


def main():
    if len(sys.argv) < 2:
        print("Usage: fetch_reels.py <username> [cookies.txt] [max_count]", file=sys.stderr)
        sys.exit(1)

    username     = sys.argv[1]
    cookies_path = sys.argv[2] if len(sys.argv) > 2 else None
    max_count    = int(sys.argv[3]) if len(sys.argv) > 3 else 20

    cookies = resolve_cookies(cookies_path)

    if not cookies.get("sessionid"):
        print(
            "ERROR: No sessionid available.\n"
            "  • Make sure you are logged in to Instagram in Chrome or Firefox on this machine.\n"
            "  • Or export cookies.txt with the 'Get cookies.txt LOCALLY' browser extension.",
            file=sys.stderr,
        )
        sys.exit(1)

    cache = load_id_cache()
    user_id = get_user_id(username, cookies, cache)
    if not user_id:
        sys.exit(1)

    # Primary: clips endpoint
    reels = get_reels_via_clips(user_id, cookies, max_count)

    # Fallback: user feed
    if not reels:
        reels = get_reels_via_feed(user_id, cookies, max_count)

    for reel in reels:
        print(json.dumps(reel))

    if not reels:
        sys.exit(1)


if __name__ == "__main__":
    main()
