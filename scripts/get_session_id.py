"""
Logs in to Instagram using INSTAGRAM_USERNAME + INSTAGRAM_PASSWORD and
prints the sessionid cookie to stdout. Used by the dashboard to auto-populate
the session ID after credentials are saved.

Exit codes:
  0 — success, session ID printed to stdout
  1 — login failed
  2 — rate limited
"""
import os, sys, urllib.parse

try:
    from instagrapi import Client
    from instagrapi.exceptions import (
        TwoFactorRequired, ChallengeRequired, LoginRequired
    )
except ImportError:
    print("ERROR: instagrapi not installed", file=sys.stderr)
    sys.exit(1)

ig_user = os.environ.get("INSTAGRAM_USERNAME", "").strip()
ig_pass = os.environ.get("INSTAGRAM_PASSWORD", "").strip()
totp_secret = os.environ.get("INSTAGRAM_TOTP_SECRET", "").strip()

if not ig_user or not ig_pass:
    print("ERROR: INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD must be set", file=sys.stderr)
    sys.exit(1)

LOG_DIR = os.environ.get("LOG_DIR", "/app/logs" if os.path.exists("/app/logs") else "logs")
session_file = os.path.join(LOG_DIR, f"instagrapi_session_{ig_user}.json")

cl = Client()
cl.delay_range = [1, 3]
try:
    cl.set_app_version("315.0.0.35.109")
    cl.set_user_agent("Instagram 315.0.0.35.109 Android (33/13; 480dpi; 1080x2400; Xiaomi; Redmi Note 11; sweet; qcom; en_US; 563548981)")
except Exception:
    pass

# Optional proxy so even the manual refresh logs in from a residential/mobile IP.
_proxy = os.environ.get("INSTAGRAM_PROXY", "").strip()
if _proxy:
    try:
        cl.set_proxy(_proxy)
    except Exception:
        pass

# Try reusing an existing session first
if os.path.exists(session_file):
    try:
        cl.load_settings(session_file)
        cl.get_timeline_feed()
        session_id = cl.cookie_dict.get("sessionid", "")
        if session_id:
            print(session_id)
            sys.exit(0)
    except Exception:
        try: os.remove(session_file)
        except Exception: pass

try:
    if totp_secret:
        try:
            import pyotp
            cl.login(ig_user, ig_pass, verification_code=pyotp.TOTP(totp_secret).now())
        except ImportError:
            cl.login(ig_user, ig_pass)
    else:
        cl.login(ig_user, ig_pass)
except TwoFactorRequired:
    print("ERROR: 2FA required — set INSTAGRAM_TOTP_SECRET", file=sys.stderr)
    sys.exit(1)
except ChallengeRequired:
    print("ERROR: Instagram challenge required — try logging in from a browser first", file=sys.stderr)
    sys.exit(1)
except LoginRequired:
    print("ERROR: Login failed (LoginRequired)", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    if "429" in str(e) or "rate" in str(e).lower():
        print(f"ERROR: Rate limited: {e}", file=sys.stderr)
        sys.exit(2)
    print(f"ERROR: Login failed: {e}", file=sys.stderr)
    sys.exit(1)

try:
    os.makedirs(os.path.dirname(session_file), exist_ok=True)
    cl.dump_settings(session_file)
except Exception:
    pass

session_id = cl.cookie_dict.get("sessionid", "")
if not session_id:
    print("ERROR: Login succeeded but sessionid cookie not found", file=sys.stderr)
    sys.exit(1)

print(session_id)
