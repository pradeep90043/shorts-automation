"""
Narration in OmniVoice (k2-fsa/OmniVoice): one audio file per line, in the channel's cloned voice.

Runs on Kaggle (GPU, src/audio/omnivoice/kaggleRunner.ts pushes it as a script kernel with the job embedded in JOB_JSON)
and on GitHub Actions (CPU fallback, .github/workflows/omnivoice-scenes.yml: --job <shard.json> --sample <wav>).

The job: {"tag", "language", "speed", "format", "sample": {"file", "start", "end", "text"},
          "characters": {"<speaker>": "<voice design>"}, "lines": [{"name", "text", "emotion"?, "speaker"?}]}

OmniVoice has no emotion switch, so a line's emotion (src/audio/emotion.ts) becomes its pace. A line spoken by a character
(Storiyum dialogue) uses a designed voice: one anchor clip per character, cloned for all of that character's lines so the
voice stays the same from line to line. Writes <name>.mp3 (or .wav) per line and manifest.json (tag + seconds per line).
"""
import argparse
import json
import os
import subprocess
import sys
import time

JOB_JSON = None  # kaggleRunner.ts replaces this with the job

EMOTION_SPEED = {"neutral": 1.0, "warm": 0.95, "serious": 0.92, "sad": 0.85, "surprise": 1.05, "energetic": 1.08}
# Hindi is spoken at about 13 characters per second (measured on the Voicebox runs, src/my-video/voiceboxNarration.ts);
# a line that comes out far shorter than that was rushed or cut, and is spoken again with a fixed length
CHARS_PER_SEC = 13.0
MIN_FRACTION = 0.55
# what a character's anchor clip says (only its voice matters, not the words)
ANCHOR_TEXT = "नमस्ते, आज मैं आपको अपनी एक बात बताना चाहता हूँ, ध्यान से सुनिए।"


def log(msg):
    print(f"[omnivoice] {msg}", flush=True)


def on_kaggle():
    return os.path.isdir("/kaggle/working")


def find_file(name, root="/kaggle/input"):
    """A dataset file wherever Kaggle mounted the dataset."""
    for dirpath, _, files in os.walk(root):
        if name in files:
            return os.path.join(dirpath, name)
    raise FileNotFoundError(f"{name} not found under {root} (is the voice-samples dataset attached?)")


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def cut_sample(src, start, end, out):
    ffmpeg("-ss", str(start), "-to", str(end), "-i", src, "-vn", "-ac", "1", "-ar", "24000", out)
    return out


TRIM = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08"


def finish(wav, out_path, fmt):
    """Silence around the speech trimmed (the scene lasts as long as its audio), loudness evened out across lines and voices."""
    chain = f"{TRIM},areverse,{TRIM},areverse,loudnorm=I=-16:TP=-1.5:LRA=11"
    if fmt == "mp3":
        ffmpeg("-i", wav, "-af", chain, "-ar", "44100", "-ac", "1", "-codec:a", "libmp3lame", "-q:a", "2", out_path)
    else:
        ffmpeg("-i", wav, "-af", chain, "-ar", "24000", "-ac", "1", out_path)


def duration_of(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout.strip()
    return float(out or 0)


def line_speed(line, base):
    return round(base * EMOTION_SPEED.get(line.get("emotion") or "neutral", 1.0), 3)


def too_short(seconds, text, speed):
    expected = len(text) / CHARS_PER_SEC / speed
    return expected > 1.0 and seconds < expected * MIN_FRACTION, expected


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", help="job JSON file (GitHub); on Kaggle the job is embedded")
    ap.add_argument("--lines", help="a shard of lines (overrides the job's lines)")
    ap.add_argument("--sample", help="the voice sample, already cut (GitHub); on Kaggle it is cut from the dataset")
    ap.add_argument("--out", default="/kaggle/working" if on_kaggle() else "out")
    ap.add_argument("--device", default=None)
    a = ap.parse_args()

    job = JOB_JSON if JOB_JSON is not None else json.load(open(a.job, encoding="utf-8"))
    if a.lines:
        job["lines"] = json.load(open(a.lines, encoding="utf-8"))
    fmt = job.get("format", "mp3")
    base_speed = float(job.get("speed") or 1.0)
    language = job.get("language") or "hi"
    os.makedirs(a.out, exist_ok=True)
    work = "/tmp/omnivoice"
    os.makedirs(work, exist_ok=True)

    if on_kaggle():
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "omnivoice"], check=True)

    import numpy as np
    import soundfile as sf
    import torch
    from omnivoice.models.omnivoice import OmniVoice

    device = a.device or ("cuda" if torch.cuda.is_available() else "cpu")
    t0 = time.time()
    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map=device, dtype=torch.float16 if device == "cuda" else torch.float32)
    sr = model.sampling_rate
    log(f"model on {device} in {time.time() - t0:.0f}s")

    def speak(text, speed, ref, duration=None, instruct=None):
        kw = dict(text=text, language=language, speed=speed)
        if ref:
            kw.update(ref_audio=ref[0], ref_text=ref[1])
        if instruct:
            kw.update(instruct=instruct)
        if duration:
            kw.update(duration=duration)
        audio = model.generate(**kw)[0]
        audio = audio.cpu().numpy() if torch.is_tensor(audio) else np.asarray(audio)
        return audio.squeeze().astype(np.float32)

    sample = job["sample"]
    if a.sample:
        narrator_wav = a.sample
    else:
        narrator_wav = cut_sample(find_file(os.path.basename(sample["file"])), sample.get("start", 0), sample.get("end", 15), f"{work}/narrator.wav")
    voices = {None: (narrator_wav, sample.get("text") or None)}

    for speaker, design in (job.get("characters") or {}).items():
        if not any(l.get("speaker") == speaker for l in job["lines"]):
            continue
        anchor = f"{work}/voice_{speaker}.wav"
        sf.write(anchor, speak(ANCHOR_TEXT, 1.0, None, instruct=design), sr)
        voices[speaker] = (anchor, ANCHOR_TEXT)
        log(f"character voice '{speaker}': {design}")

    manifest = {"tag": job.get("tag"), "device": device, "lines": {}}
    for i, line in enumerate(job["lines"], 1):
        text = line["text"].strip()
        speed = line_speed(line, base_speed)
        ref = voices.get(line.get("speaker")) or voices[None]
        raw = f"{work}/{line['name']}.wav"
        for attempt in (1, 2):
            try:
                audio = speak(text, speed, ref)
                short, expected = too_short(len(audio) / sr, text, speed)
                if short:
                    log(f"{line['name']}: {len(audio) / sr:.1f}s for ~{expected:.1f}s of text, speaking it again at a fixed length")
                    audio = speak(text, speed, ref, duration=round(expected, 2))
                sf.write(raw, audio, sr)
                break
            except Exception as err:  # a single bad generation is retried once; a second failure fails the run
                if attempt == 2:
                    raise
                log(f"{line['name']}: {err}; retrying")
        out_path = os.path.join(a.out, f"{line['name']}.{fmt}")
        finish(raw, out_path, fmt)
        manifest["lines"][line["name"]] = round(duration_of(out_path), 2)
        log(f"[{i}/{len(job['lines'])}] {line['name']} {manifest['lines'][line['name']]}s ({line.get('emotion') or 'neutral'}, {line.get('speaker') or 'narrator'})")

    with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False)
    log(f"done: {len(job['lines'])} lines, {sum(manifest['lines'].values()):.0f}s of audio in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
