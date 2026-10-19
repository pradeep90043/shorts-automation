#!/usr/bin/env python3
"""
audit_music_library.py - which tracks of the background-music library does Shazam recognise as a commercial recording?

The pipeline checks every finished Short with Shazam and mutes or strips audio it recognises (AudioClearance). A bed track that
Shazam knows therefore ruins our own Shorts, and a "free" library track that is also registered as a song can bring a Content ID claim.
This runs the same check over the library: a 20 s slice from the 20 s mark (where the mixer starts the music) of every file.

  python3 scripts/audit_music_library.py [--write-blocklist]

--write-blocklist appends the recognised files to assets/music/blocklist.list (MusicService skips them from then on).
"""
import argparse, asyncio, glob, json, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def slice_audio(src, out):
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-ss", "20", "-t", "20", "-i", src, "-vn", "-ac", "1", "-ar", "44100", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) < 1000:
        # a track shorter than 20 s: take it from the start
        subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-t", "20", "-i", src, "-vn", "-ac", "1", "-ar", "44100", out], capture_output=True)
    return os.path.exists(out) and os.path.getsize(out) > 1000


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write-blocklist", action="store_true")
    a = ap.parse_args()
    from shazamio import Shazam
    shazam = Shazam()
    files = sorted(glob.glob(os.path.join(ROOT, "assets", "music", "*", "*")) + glob.glob(os.path.join(ROOT, "assets", "ambient", "*")))
    files = [f for f in files if f.lower().endswith((".mp3", ".m4a", ".aac", ".wav", ".ogg"))]
    hits, errors = [], 0
    with tempfile.TemporaryDirectory() as tmp:
        for i, f in enumerate(files, 1):
            wav = os.path.join(tmp, "s.wav")
            rel = os.path.relpath(f, ROOT)
            if not slice_audio(f, wav):
                print(f"[{i}/{len(files)}] {rel}: could not read"); errors += 1; continue
            try:
                out = await shazam.recognize(wav)
                track = out.get("track") if isinstance(out, dict) else None
            except Exception as e:  # network / rate limit: try once more
                await asyncio.sleep(3)
                try:
                    out = await shazam.recognize(wav); track = out.get("track")
                except Exception as e2:
                    print(f"[{i}/{len(files)}] {rel}: error {e2}"); errors += 1; continue
            if track:
                hits.append({"file": rel, "title": track.get("title"), "artist": track.get("subtitle")})
                print(f"[{i}/{len(files)}] {rel}: RECOGNISED  {track.get('title')} - {track.get('subtitle')}")
            else:
                print(f"[{i}/{len(files)}] {rel}: not recognised")
            await asyncio.sleep(1.2)
    print("\n" + json.dumps({"checked": len(files), "recognised": hits, "errors": errors}, ensure_ascii=False, indent=1))
    if a.write_blocklist and hits:
        bl = os.path.join(ROOT, "assets", "music", "blocklist.list")
        have = open(bl).read().lower() if os.path.exists(bl) else ""
        with open(bl, "a") as fh:
            for h in hits:
                key = os.path.splitext(os.path.basename(h["file"]))[0].lower()
                if key not in have:
                    fh.write(f"# recognised by Shazam as \"{h['title']}\" - {h['artist']} (audit)\n{key}\n")
        print("blocklist updated:", bl)


asyncio.run(main())
