#!/usr/bin/env python3
"""
fetch_reels.py — list a user's recent Instagram Reels via instagrapi.

Auth: INSTAGRAM_USERNAME + INSTAGRAM_PASSWORD env vars (required).
      Set INSTAGRAM_TOTP_SECRET if 2FA is enabled (also needs: pip install pyotp).
Session is saved to logs/instagrapi_session.json and reused on every subsequent
run so Instagram never sees repeated full logins from the same IP.

Outputs one JSON object per line: {"shortcode": "...", "url": "..."}

Usage:
    python3 fetch_reels.py <username> [ignored] [max_count]
    python3 fetch_reels.py --mode hashtag --tags programming,coding --limit 20
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

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Session file — Docker path preferred, local logs/ fallback.
_SESSION_CANDIDATES = [
    "/app/logs/instagrapi_session.json",
    os.path.join(_SCRIPT_DIR, "..", "logs", "instagrapi_session.json"),
]
SESSION_FILE = next(
    (p for p in _SESSION_CANDIDATES if os.path.isdir(os.path.dirname(p))),
    _SESSION_CANDIDATES[-1],
)

_rate_limited = False


def _is_rate_limit(exc: Exception) -> bool:
    """Detect Instagram 429 / throttle errors regardless of instagrapi version."""
    type_name = type(exc).__name__.lower()
    if "throttl" in type_name or "ratelimit" in type_name or "feedback" in type_name:
        return True
    s = str(exc).lower()
    return "429" in s or "too many requests" in s or "please wait" in s or "feedback_required" in s


def fetch_reels_via_rapidapi(identifier: str, mode: str = "channel", limit: int = 10) -> list[dict]:
    """Fetch reels cleanly via RapidAPI without requiring any Instagram login or cookies."""
    rapidapi_key = os.environ.get("RAPIDAPI_KEY") or os.environ.get("RAPIDAPI_INSTAGRAM_KEY") or "8a0fd54a8amsh10bd5cc60f5ac47p1f0069jsn7077defe962b"
    if not rapidapi_key:
        return []
    
    try:
        url = "https://instagram120.p.rapidapi.com/api/instagram/reels"
        headers = {
            "x-rapidapi-host": "instagram120.p.rapidapi.com",
            "x-rapidapi-key": rapidapi_key,
            "Content-Type": "application/x-www-form-urlencoded"
        }
        data = f"username={urllib.parse.quote(identifier.lstrip('@'))}".encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw_body = resp.read().decode("utf-8")
            body = json.loads(raw_body)
            
        results = []
        edges = []
        if isinstance(body, dict):
            res_obj = body.get("result", {})
            if isinstance(res_obj, dict):
                edges = res_obj.get("edges", []) or res_obj.get("items", [])
            elif isinstance(res_obj, list):
                edges = res_obj
            if not edges:
                edges = (body.get("data", {}) or {}).get("items", []) if isinstance(body.get("data"), dict) else (body.get("items") or [])

        for edge in edges:
            if not isinstance(edge, dict):
                continue
            node = edge.get("node", {}) if isinstance(edge.get("node"), dict) else edge
            media = node.get("media", {}) if isinstance(node.get("media"), dict) else node
            code = media.get("code") or media.get("shortcode") or media.get("pk")
            if not code:
                continue
            video_url = ""
            v_versions = media.get("video_versions", [])
            if v_versions and isinstance(v_versions, list):
                video_url = v_versions[0].get("url", "")
            
            results.append({
                "shortcode": str(code),
                "url": f"https://www.instagram.com/reel/{code}/",
                "video_url": video_url,
                "like_count": media.get("like_count", 0) or 0,
                "play_count": media.get("play_count", 0) or media.get("view_count", 0) or 0,
                "comment_count": media.get("comment_count", 0) or 0,
                "owner_username": (media.get("user") or {}).get("username", identifier),
            })
            if len(results) >= limit:
                break
        if results:
            print(f"INFO: RapidAPI retrieved {len(results)} reel(s) for {identifier}", file=sys.stderr)
        else:
            print(f"WARN: RapidAPI returned 0 reels for {identifier}. Body keys: {list(body.keys()) if isinstance(body, dict) else type(body)}", file=sys.stderr)
        return results
    except Exception as exc:
        import traceback
        print(f"WARN: RapidAPI fetch failed for {identifier}: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return []


def get_client(force_login=False):
    """Return an authenticated instagrapi Client, reusing saved session when possible."""
    global _rate_limited

    try:
        from instagrapi import Client
        from instagrapi.exceptions import (
            LoginRequired,
            ChallengeRequired,
            TwoFactorRequired,
            FeedbackRequired,
        )
    except ImportError:
        print(
            "ERROR: instagrapi not installed.\n"
            "  Run: pip install instagrapi",
            file=sys.stderr,
        )
        sys.exit(1)

    ig_user = os.environ.get("INSTAGRAM_USERNAME", "").strip()
    ig_pass = os.environ.get("INSTAGRAM_PASSWORD", "").strip()
    totp_secret = os.environ.get("INSTAGRAM_TOTP_SECRET", "").strip()
    session_id = os.environ.get("INSTAGRAM_SESSION_ID", "").strip()

    if not ig_user and not session_id:
        print(
            "ERROR: INSTAGRAM_USERNAME or INSTAGRAM_SESSION_ID must be set in .env\n",
            file=sys.stderr,
        )
        sys.exit(1)

    # Dynamically suffix the session file path using the logged-in username.
    if ig_user:
        session_file = os.path.join(os.path.dirname(SESSION_FILE), f"instagrapi_session_{ig_user}.json")
    else:
        session_file = os.path.join(os.path.dirname(SESSION_FILE), "instagrapi_session_direct.json")

    cl = Client()
    cl.delay_range = [1, 3]  # 1–3 s random pause between API calls
    try:
        cl.set_app_version("315.0.0.35.109")
        cl.set_user_agent("Instagram 315.0.0.35.109 Android (33/13; 480dpi; 1080x2400; Xiaomi; Redmi Note 11; sweet; qcom; en_US; 563548981)")
    except Exception:
        pass

    # Attempt to reuse a previously saved session.
    session_loaded = False
    if not force_login and os.path.exists(session_file):
        try:
            cl.load_settings(session_file)
            cl.get_timeline_feed()
            session_loaded = True
            print(f"INFO: Loaded valid saved instagrapi session from {session_file}.", file=sys.stderr)
        except Exception as exc:
            session_loaded = False
            if os.path.exists(session_file):
                try: os.remove(session_file)
                except Exception: pass
            print(f"WARN: Saved session file is invalid/expired ({exc}). Removing and re-authenticating...", file=sys.stderr)

    _used_password_login = False

    def _do_login(client: "Client") -> None:
        """Login, injecting a TOTP code when 2FA is configured, or login by session ID."""
        nonlocal _used_password_login
        if session_id:
            try:
                sid = urllib.parse.unquote(session_id)
                client.login_by_sessionid(sid)
                print(f"INFO: Logged in using INSTAGRAM_SESSION_ID ({sid[:15]}...).", file=sys.stderr)
                return
            except Exception as e:
                print(f"WARN: Login by session ID failed: {e}. Falling back to username/password.", file=sys.stderr)
                if not ig_user or not ig_pass:
                    raise e

        if totp_secret:
            try:
                import pyotp
                client.login(ig_user, ig_pass, verification_code=pyotp.TOTP(totp_secret).now())
                _used_password_login = True
                return
            except ImportError:
                print(
                    "WARN: INSTAGRAM_TOTP_SECRET is set but pyotp is not installed — "
                    "logging in without TOTP (install pyotp if 2FA is required).",
                    file=sys.stderr,
                )
        client.login(ig_user, ig_pass)
        _used_password_login = True

    if not session_loaded:
        try:
            _do_login(cl)
        except TwoFactorRequired:
            if os.path.exists(session_file):
                try: os.remove(session_file)
                except Exception: pass
            print(
                "ERROR: 2FA required.\n"
                "  Set INSTAGRAM_TOTP_SECRET=<your_totp_secret> in .env\n"
                "  and install pyotp:  pip install pyotp",
                file=sys.stderr,
            )
            sys.exit(1)
        except ChallengeRequired:
            if os.path.exists(session_file):
                try: os.remove(session_file)
                except Exception: pass
            print(
                "ERROR: Instagram challenge required (suspicious login detected).\n"
                "  Update INSTAGRAM_SESSION_ID in .env with a fresh browser sessionid cookie.",
                file=sys.stderr,
            )
            sys.exit(1)
        except LoginRequired:
            if os.path.exists(session_file):
                try: os.remove(session_file)
                except Exception: pass
            print("ERROR: Instagram login failed (LoginRequired). Update INSTAGRAM_SESSION_ID in .env.", file=sys.stderr)
            sys.exit(1)
        except Exception as exc:
            if os.path.exists(session_file):
                try: os.remove(session_file)
                except Exception: pass
            if _is_rate_limit(exc):
                _rate_limited = True
                print(f"RATE_LIMITED: 429 during login: {exc}", file=sys.stderr)
                sys.exit(2)
            print(f"ERROR: Instagram login failed: {exc}", file=sys.stderr)
            sys.exit(1)

    # Persist session so subsequent runs skip the full login flow.
    try:
        os.makedirs(os.path.dirname(session_file), exist_ok=True)
        cl.dump_settings(session_file)
    except Exception as exc:
        print(f"WARN: Could not save session file: {exc}", file=sys.stderr)

    # If we logged in via password (session was missing or expired), emit the new
    # session ID so Node.js can persist it to the DB automatically.
    if _used_password_login:
        new_sid = cl.cookie_dict.get("sessionid", "")
        if new_sid:
            print(f"SESSION_REFRESHED:{new_sid}", file=sys.stderr)

    return cl


# ── HTTP utility functions (used by hashtag sections-API fallback) ─────────────

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
                "source_hashtag": tag,
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
                    return cookies
        except Exception:
            continue

    return cookies


def fetch_hashtag_reels_with_client(cl: "object", cookies: dict, tag: str, limit: int) -> list[dict]:
    """Fetch top reels for one hashtag using a pre-built instagrapi client (or HTTP fallback)."""
    tag_clean = tag.lstrip("#")
    results: list[dict] = []

    # ── Strategy 1: instagrapi (shared client — no re-login per tag) ─────────
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
        type_name = type(exc).__name__
        if type_name == "LoginRequired" or "login_required" in str(exc).lower():
            raise exc
        print(f"WARN: instagrapi hashtag failed for #{tag_clean}: {exc}", file=sys.stderr)

    # ── Strategy 2: direct POST sections API (requires csrftoken) ────────────
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
    global _rate_limited
    import argparse

    # Support both legacy positional form and new --mode flag form.
    if len(sys.argv) >= 2 and not sys.argv[1].startswith("-"):
        # Legacy: fetch_reels.py <username> [ignored] [max_count]
        username  = sys.argv[1]
        max_count = int(sys.argv[3]) if len(sys.argv) > 3 else 20
        mode      = "channel"
        tag       = None
    else:
        parser = argparse.ArgumentParser(description="Fetch Instagram reels by channel or hashtag")
        parser.add_argument("--mode", choices=["channel", "hashtag"], default="channel")
        parser.add_argument("--username", default=None, help="Instagram username (channel mode)")
        parser.add_argument("--tags", default=None,
                            help="Comma-separated hashtags (hashtag mode; all fetched in one process)")
        parser.add_argument("--tag", default=None, help="Single hashtag — alias for --tags")
        parser.add_argument("--limit", type=int, default=20, help="Max reels per hashtag")
        args = parser.parse_args()
        mode      = args.mode
        username  = args.username
        max_count = args.limit
        raw_tags  = args.tags or args.tag or ""
        tag       = raw_tags

    # Determine dynamic session file name for retries
    ig_user = os.environ.get("INSTAGRAM_USERNAME", "").strip()
    if ig_user:
        session_file = os.path.join(os.path.dirname(SESSION_FILE), f"instagrapi_session_{ig_user}.json")
    else:
        session_file = os.path.join(os.path.dirname(SESSION_FILE), "instagrapi_session_direct.json")

    if mode == "hashtag":
        if not tag:
            print("ERROR: --tag or --tags is required in hashtag mode", file=sys.stderr)
            sys.exit(1)

        # Strategy 0: RapidAPI hashtag fetch
        r_reels = fetch_reels_via_rapidapi(tag, mode="hashtag", limit=max_count)
        if r_reels:
            for r in r_reels:
                print(json.dumps(r))
            sys.exit(0)

        cl = get_client()
        tag_list = [t.strip().lstrip("#") for t in tag.split(",") if t.strip()]
        if not tag_list:
            sys.exit(1)

        reels = []
        seen_codes: set[str] = set()
        cookies: dict = {}  # instagrapi is primary; empty cookies = no sections-API fallback

        for i, tag_name in enumerate(tag_list):
            if i > 0:
                # Polite delay between hashtag calls (3–5 s) — avoids per-minute rate limits
                time.sleep(3 + (i % 3))

            try:
                batch = fetch_hashtag_reels_with_client(cl, cookies, tag_name, max_count)
            except Exception as exc:
                type_name = type(exc).__name__
                if type_name == "LoginRequired" or "login_required" in str(exc).lower():
                    print("WARN: Saved session expired during hashtag fetch — re-logging in...", file=sys.stderr)
                    try:
                        os.remove(session_file)
                    except Exception:
                        pass
                    cl = get_client(force_login=True)
                    batch = fetch_hashtag_reels_with_client(cl, cookies, tag_name, max_count)
                else:
                    raise exc

            for r in batch:
                if r["shortcode"] not in seen_codes:
                    seen_codes.add(r["shortcode"])
                    reels.append(r)
                    print(json.dumps(r))

        if not reels:
            sys.exit(1)

    else:
        # Channel mode — RapidAPI (zero login/zero blocks) -> instagrapi user_clips() fallback
        if not username:
            print("Usage: fetch_reels.py <username> [ignored] [max_count]", file=sys.stderr)
            sys.exit(1)

        # Primary: RapidAPI zero-login instant fetch
        r_reels = fetch_reels_via_rapidapi(username, mode="channel", limit=max_count)
        if r_reels:
            for r in r_reels:
                print(json.dumps(r))
            sys.exit(0)

        cl = get_client()

        def fetch_channel_data(client):
            try:
                # Try private API resolving username first (authenticated, not rate-limited)
                user_pk = client.user_info_by_username_v1(username).pk
            except Exception as exc:
                print(f"DEBUG: private API user_info_by_username_v1 failed: {exc}", file=sys.stderr)
                type_name = type(exc).__name__
                if type_name == "LoginRequired" or "login_required" in str(exc).lower() or _is_rate_limit(exc):
                    raise exc
                try:
                    user_pk = client.user_id_from_username(username)
                except Exception as exc2:
                    raise exc2

            return client.user_clips(user_pk, amount=max_count)

        try:
            medias = fetch_channel_data(cl)
        except Exception as exc:
            type_name = type(exc).__name__
            if type_name == "LoginRequired" or "login_required" in str(exc).lower():
                print("WARN: Saved session expired during channel fetch — re-logging in...", file=sys.stderr)
                try:
                    os.remove(session_file)
                except Exception:
                    pass
                cl = get_client(force_login=True)
                try:
                    medias = fetch_channel_data(cl)
                except Exception as exc2:
                    if _is_rate_limit(exc2):
                        _rate_limited = True
                        print(f"RATE_LIMITED: 429 during re-fetch: {exc2}", file=sys.stderr)
                        sys.exit(2)
                    print(f"ERROR: Fetch failed after re-login: {exc2}", file=sys.stderr)
                    sys.exit(1)
            else:
                if _is_rate_limit(exc):
                    _rate_limited = True
                    print(f"RATE_LIMITED: 429 fetching clips for @{username}: {exc}", file=sys.stderr)
                    sys.exit(2)
                print(f"WARN: Error fetching clips for @{username}: {exc}", file=sys.stderr)
                sys.exit(1)

        for media in medias:
            shortcode = media.code
            print(json.dumps({
                "shortcode": shortcode,
                "url": f"https://www.instagram.com/reel/{shortcode}/",
                "like_count": getattr(media, "like_count", 0) or 0,
                "play_count": getattr(media, "play_count", 0) or getattr(media, "view_count", 0) or 0,
                "comment_count": getattr(media, "comment_count", 0) or 0,
                "owner_username": getattr(getattr(media, "user", None), "username", "") or "",
            }))

        if not medias:
            sys.exit(1)


if __name__ == "__main__":
    main()
