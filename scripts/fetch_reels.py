#!/usr/bin/env python3
"""
fetch_reels.py — list a user's recent Instagram Reels via the private mobile API.

Uses only Python stdlib (urllib) so no pip installs are needed.
Outputs one JSON object per line: {"shortcode": "...", "url": "..."}

Usage:
    python3 fetch_reels.py <username> <path/to/cookies.txt> [max_count]
"""

import sys
import json
import urllib.request
import urllib.parse
import urllib.error
import time

# ── Instagram mobile app identity ────────────────────────────────────────────
APP_ID   = "936619743392459"
USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Mobile/15E148 Instagram/334.0.0.42.95 "
    "(iPhone14,3; iOS 17_5; en_US; en-US; scale=3.00; 1284x2778; 647227942)"
)

# ─────────────────────────────────────────────────────────────────────────────

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
        print(f"WARN: could not parse cookies: {exc}", file=sys.stderr)
    return cookies


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


def get_user_id(username: str, cookies: dict) -> str | None:
    """Resolve a username → numeric user ID via the web profile info endpoint."""
    url = f"https://www.instagram.com/api/v1/users/web_profile_info/?username={urllib.parse.quote(username)}"
    try:
        data = fetch_json(build_request(url, cookies))
        return data["data"]["user"]["id"]
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
    if len(sys.argv) < 3:
        print("Usage: fetch_reels.py <username> <cookies.txt> [max_count]", file=sys.stderr)
        sys.exit(1)

    username  = sys.argv[1]
    cookies_path = sys.argv[2]
    max_count = int(sys.argv[3]) if len(sys.argv) > 3 else 20

    cookies = parse_netscape_cookies(cookies_path)
    if not cookies.get("sessionid"):
        print("ERROR: No sessionid found in cookies. Login may have expired.", file=sys.stderr)
        sys.exit(1)

    user_id = get_user_id(username, cookies)
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
