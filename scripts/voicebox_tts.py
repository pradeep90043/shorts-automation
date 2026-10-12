"""
Drives a running Voicebox container (see .github/workflows/voicebox-tts.yml): clones a voice from one sample, then speaks each line.

  python3 scripts/voicebox_tts.py --base http://127.0.0.1:17493 --sample sample.wav --sample-text "..." \
      --lines lines.json --out out --engine chatterbox --voice codeorcap

lines.json is [{"name": "codeorcap_6", "text": "Six."}, ...]; each line becomes out/<name>.wav.
"""
import argparse
import json
import os
import sys
import time

import requests


def wait_health(base, seconds):
    end = time.time() + seconds
    while time.time() < end:
        try:
            if requests.get(f"{base}/health", timeout=5).ok:
                return
        except requests.RequestException:
            pass
        time.sleep(3)
    sys.exit(f"Voicebox did not become healthy within {seconds}s")


def model_entries(base):
    body = requests.get(f"{base}/models/status", timeout=30).json()
    return body.get("models", body) if isinstance(body, dict) else body


def ensure_model(base, engine, wait_seconds):
    """Download the weights of `engine` (all its sizes the API reports) and wait until they are cached."""
    entries = [m for m in model_entries(base) if engine.replace("_", "-") in m["model_name"].replace("_", "-")]
    print("models for engine:", [(m["model_name"], m.get("downloaded")) for m in entries], flush=True)
    if not entries:
        print("all models:", [m["model_name"] for m in model_entries(base)], flush=True)
        sys.exit(f"No model matches engine '{engine}'")
    todo = [m["model_name"] for m in entries if not m.get("downloaded")]
    for name in todo:
        r = requests.post(f"{base}/models/download", json={"model_name": name}, timeout=60)
        print("download", name, r.status_code, r.text[:200], flush=True)
    end = time.time() + wait_seconds
    while todo and time.time() < end:
        time.sleep(10)
        have = {m["model_name"]: m for m in model_entries(base)}
        todo = [n for n in todo if not have.get(n, {}).get("downloaded")]
        print("still downloading:", todo, flush=True)
    if todo:
        sys.exit(f"Models not downloaded in time: {todo}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:17493")
    ap.add_argument("--sample", required=True)
    ap.add_argument("--sample-text", required=True)
    ap.add_argument("--lines", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--engine", default="chatterbox")
    ap.add_argument("--voice", default="cloned-voice")
    ap.add_argument("--language", default="en")
    ap.add_argument("--startup-seconds", type=int, default=240)
    ap.add_argument("--download-seconds", type=int, default=1500)
    a = ap.parse_args()

    lines = json.load(open(a.lines))
    os.makedirs(a.out, exist_ok=True)
    wait_health(a.base, a.startup_seconds)
    ensure_model(a.base, a.engine, a.download_seconds)

    r = requests.post(
        f"{a.base}/profiles",
        json={"name": a.voice, "language": a.language, "voice_type": "cloned", "default_engine": a.engine},
        timeout=60,
    )
    r.raise_for_status()
    profile_id = r.json()["id"]
    with open(a.sample, "rb") as f:
        r = requests.post(
            f"{a.base}/profiles/{profile_id}/samples",
            files={"file": (os.path.basename(a.sample), f, "audio/wav")},
            data={"reference_text": a.sample_text},
            timeout=300,
        )
    r.raise_for_status()
    print("profile", profile_id, "ready", flush=True)

    for line in lines:
        t0 = time.time()
        for attempt in range(1, 4):
            r = requests.post(
                f"{a.base}/v1/audio/speech",
                json={"model": a.engine, "voice": a.voice, "input": line["text"], "response_format": "wav"},
                timeout=900,
            )
            if r.ok:
                break
            print(f"{line['name']}: attempt {attempt} HTTP {r.status_code} {r.text[:400]}", flush=True)
            # The chatterbox download can end with a progress-bar error in the library although the files are complete.
            # Asking again finds them cached, so the model loads without downloading.
            for m in model_entries(a.base):
                if a.engine.replace("_", "-") in m["model_name"].replace("_", "-"):
                    requests.post(f"{a.base}/models/download", json={"model_name": m["model_name"]}, timeout=60)
            time.sleep(45 * attempt)
        if not r.ok:
            sys.exit(f"{line['name']}: HTTP {r.status_code} {r.text[:400]}")
        path = os.path.join(a.out, f"{line['name']}.wav")
        with open(path, "wb") as f:
            f.write(r.content)
        print(f"{line['name']}: {len(r.content)} bytes in {time.time() - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main()
