#!/usr/bin/env python3
"""
scripts/local_discovery_worker.py — Solution 2 (Residential Local Discovery Worker)

Runs on your local machine (home Wi-Fi) where Instagram does NOT block your session ID.
Scrapes the target accounts for each profile and pushes fresh Reel URLs directly to
your production server: https://shorts-automation.duckdns.org/api/inject-reels

Usage:
    python3 scripts/local_discovery_worker.py --profile codeorcap
    python3 scripts/local_discovery_worker.py --profile storiyum
    python3 scripts/local_discovery_worker.py --all
    python3 scripts/local_discovery_worker.py --all --daemon --interval 14400 # runs every 4h
"""

import sys
import os
import json
import time
import argparse
import urllib.request
import urllib.parse

DEFAULT_SERVER_URL = os.environ.get("PRODUCTION_SERVER_URL", "https://shorts-automation.duckdns.org")

PROFILE_CHANNELS = {
    "codeorcap": [
        "technologybrief",
        "getintoai",
        "protocol.audience",
        "smartfindsig",
        "longliveai",
        "theaitech",
        "weexplainfacts",
    ],
    "storiyum": [
        "gingletooonz8",
        "nammacozyvillage",
        "offo_talks",
        "2d_world_toons",
        "midnight_dossier_",
        "parlegnchai_verse",
        "cozywhispers03",
        "zizi.me5",
        "gramiyastories",
    ],
    "infoonspot": [
        "technologybrief",
        "theaitech",
        "protocol.audience",
    ],
    "promptgag": [
        "9gag",
        "memezar",
        "pubity",
    ],
}


def get_instaloader_context(session_id: str = ""):
    """Initialize Instaloader with residential session cookie."""
    try:
        import instaloader
        L = instaloader.Instaloader(
            download_pictures=False,
            download_videos=False,
            download_video_thumbnails=False,
            download_geotags=False,
            download_comments=False,
            save_metadata=False,
            compress_json=False,
        )
        if session_id:
            L.context._session.cookies.set(
                "sessionid",
                urllib.parse.unquote(session_id),
                domain=".instagram.com",
            )
        return L
    except Exception as e:
        print(f"WARN: Could not init instaloader: {e}", file=sys.stderr)
        return None


def fetch_reels_local(loader, username: str, limit: int = 3) -> list[dict]:
    """Fetch recent reels for an Instagram channel from residential IP."""
    import instaloader
    reels = []
    try:
        print(f"  [@{username}] Fetching profile metadata...")
        profile = instaloader.Profile.from_username(loader.context, username)
        count = 0
        for post in profile.get_posts():
            if post.is_video:
                shortcode = post.shortcode
                reels.append({
                    "shortcode": shortcode,
                    "url": f"https://www.instagram.com/reel/{shortcode}/",
                    "channel": username,
                    "like_count": getattr(post, "likes", 0) or 0,
                    "play_count": getattr(post, "video_view_count", 0) or 0,
                    "caption": (getattr(post, "caption", "") or "")[:200],
                })
                count += 1
                if count >= limit:
                    break
        print(f"  [@{username}] Successfully fetched {len(reels)} reel(s).")
    except Exception as e:
        print(f"  [@{username}] Local fetch error: {e}", file=sys.stderr)
    return reels


def inject_reels_to_server(server_url: str, profile_key: str, reels: list[dict]) -> int:
    """POST discovered reels to production server /api/inject-reels."""
    if not reels:
        return 0
    endpoint = f"{server_url.rstrip('/')}/api/inject-reels"
    payload = json.dumps({
        "profile": profile_key,
        "reels": reels,
    }).encode("utf-8")

    req = urllib.request.Request(
        endpoint,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Inject-Token": os.environ.get("INJECT_REELS_TOKEN", ""),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            injected = data.get("injectedCount", 0)
            print(f"✓ [{profile_key.upper()}] Server acknowledged: Injected {injected} reel(s) into watch queue!")
            return injected
    except Exception as e:
        print(f"❌ Failed to inject reels to {endpoint}: {e}", file=sys.stderr)
        return 0


def run_discovery_round(server_url: str, profiles: list[str], session_id: str = ""):
    """Run a single discovery sweep across specified profiles."""
    print(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] Starting Local Residential Discovery Sweep...")
    loader = get_instaloader_context(session_id)
    if not loader:
        print("ERROR: Instaloader could not be initialized.", file=sys.stderr)
        return

    for p_key in profiles:
        channels = PROFILE_CHANNELS.get(p_key, [])
        print(f"\n--- Processing Profile: [{p_key.upper()}] ({len(channels)} target channels) ---")
        all_reels = []
        for ch in channels:
            reels = fetch_reels_local(loader, ch, limit=2)
            all_reels.extend(reels)
            time.sleep(2)  # polite spacing on home network

        if all_reels:
            inject_reels_to_server(server_url, p_key, all_reels)
        else:
            print(f"  [{p_key.upper()}] No new reels fetched from target channels.")


def main():
    parser = argparse.ArgumentParser(description="Local Discovery Worker (Solution 2)")
    parser.add_argument("--profile", type=str, default="", help="Profile key (e.g. storiyum, codeorcap)")
    parser.add_argument("--all", action="store_true", help="Process all configured profiles")
    parser.add_argument("--server", type=str, default=DEFAULT_SERVER_URL, help="Target production server URL")
    parser.add_argument("--session-id", type=str, default="", help="Instagram sessionid cookie (optional)")
    parser.add_argument("--daemon", action="store_true", help="Run continuously on an interval")
    parser.add_argument("--interval", type=int, default=14400, help="Interval in seconds for daemon mode (default: 4h)")
    args = parser.parse_args()

    session_id = args.session_id or os.environ.get("INSTAGRAM_SESSION_ID", "")
    target_profiles = list(PROFILE_CHANNELS.keys()) if args.all else [args.profile.lower()] if args.profile else ["codeorcap"]

    if args.daemon:
        print(f"Local Discovery Worker started in DAEMON mode (Interval: {args.interval}s)")
        while True:
            run_discovery_round(args.server, target_profiles, session_id)
            print(f"Sleeping for {args.interval} seconds until next sweep...")
            time.sleep(args.interval)
    else:
        run_discovery_round(args.server, target_profiles, session_id)
        print("\nSweep completed.")


if __name__ == "__main__":
    main()
