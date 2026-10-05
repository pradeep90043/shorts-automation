#!/usr/bin/env python3
"""
scripts/transcribe_whisper.py — local speech-to-text with word timestamps (faster-whisper).

Used by src/audio/transcription.ts when no OPENAI_API_KEY is set (or the API call fails).
Writes JSON in the same shape the openai-whisper CLI produced:
    {"text": "...", "segments": [{"start": 0.0, "end": 1.2, "words": [{"word": "hi", "start": 0.0, "end": 0.4}]}]}

Usage:
    python3 scripts/transcribe_whisper.py <audio.wav> <out.json> [--model base]

Env:
    WHISPER_MODEL      model size (default: base)
    WHISPER_MODEL_DIR  where model files live; baked into the Docker image at build time
    WHISPER_THREADS    CPU threads (default: 2, so a render isn't starved)
"""

import argparse
import json
import os
import sys
import wave


def load_pcm16_mono(path: str):
    """Read the 16 kHz mono PCM WAV that transcription.ts extracts with ffmpeg.

    Decoding it ourselves keeps faster-whisper's PyAV decode path out of the picture
    (PyAV releases have broken that path before).
    """
    import numpy as np

    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1 or w.getframerate() != 16000:
            raise ValueError("expected 16 kHz mono 16-bit PCM WAV")
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "base"))
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed", file=sys.stderr)
        return 2

    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        cpu_threads=int(os.environ.get("WHISPER_THREADS", "2")),
        download_root=os.environ.get("WHISPER_MODEL_DIR") or None,
    )
    segments_iter, info = model.transcribe(
        load_pcm16_mono(args.audio),
        word_timestamps=True,
        vad_filter=True,  # skip music-only stretches instead of hallucinating text
        beam_size=1,      # greedy: much cheaper on CPU, fine for subtitle timing
    )

    segments = []
    texts = []
    for seg in segments_iter:
        words = [
            {"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)}
            for w in (seg.words or [])
            if w.word.strip()
        ]
        texts.append(seg.text.strip())
        segments.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip(), "words": words})

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"text": " ".join(t for t in texts if t), "language": info.language, "segments": segments}, f, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
