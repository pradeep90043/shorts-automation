#!/usr/bin/env python3
"""
shazam_identify.py — Identify audio/music from an audio or video file using Shazam.
Usage:
    python3 scripts/shazam_identify.py <audio_or_video_file_path>
Outputs JSON:
    {
      "matched": true,
      "title": "Song Title",
      "artist": "Artist Name",
      "album": "Album Name",
      "genre": "Genre",
      "shazam_url": "https://www.shazam.com/track/...",
      "isrc": "...",
      "raw": { ... }
    }
"""

import sys
import os
import json
import asyncio

async def identify(file_path: str):
    if not os.path.exists(file_path):
        print(json.dumps({"matched": False, "error": f"File not found: {file_path}"}))
        sys.exit(1)

    try:
        from shazamio import Shazam
    except ImportError:
        print(json.dumps({
            "matched": False,
            "error": "shazamio is not installed. Install via: pip install shazamio"
        }))
        sys.exit(1)

    try:
        shazam = Shazam()
        out = await shazam.recognize(file_path)
        track = out.get("track")
        if not track:
            print(json.dumps({"matched": False, "message": "No match found on Shazam"}))
            return

        title = track.get("title")
        subtitle = track.get("subtitle")
        genres = track.get("genres", {}).get("primary")
        url = track.get("url")
        isrc = track.get("isrc")
        images = track.get("images", {})
        
        # Extract album if present in sections
        album = None
        for section in track.get("sections", []):
            if section.get("type") == "SONG":
                for metadata_item in section.get("metadata", []):
                    if metadata_item.get("title", "").lower() == "album":
                        album = metadata_item.get("text")
                        break

        result = {
            "matched": bool(title),
            "title": title,
            "artist": subtitle,
            "album": album,
            "genre": genres,
            "shazam_url": url,
            "isrc": isrc,
            "cover_art": images.get("coverart") or images.get("background"),
        }
        print(json.dumps(result, indent=2))

    except Exception as exc:
        print(json.dumps({"matched": False, "error": str(exc)}))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"matched": False, "error": "Usage: python3 shazam_identify.py <file_path>"}))
        sys.exit(1)

    target_file = sys.argv[1]
    asyncio.run(identify(target_file))
