#!/bin/bash
# One generated scene: <in.wav> -> $OUT_DIR/<name>.mp3, denoised (when DENOISE=true) and with the silence around the speech trimmed.
# The scene length is the audio length, so long silent tails would be dead air in the video: keep at most ~0.1 s at both ends.
# The silence is trimmed AFTER the denoise: on clean audio the -50 dB threshold finds the real edges of the speech.
set -euo pipefail
in="$1"
name="$(basename "$in" .wav)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
src="$in"
if [ "${DENOISE:-true}" = "true" ]; then
  bash "$(dirname "$0")/voice_denoise.sh" "$in" "$tmp/clean.wav"
  src="$tmp/clean.wav"
fi
TRIM="silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08"
ffmpeg -hide_banner -loglevel error -y -i "$src" -af "$TRIM,areverse,$TRIM,areverse" -ar 44100 -ac 1 -codec:a libmp3lame -q:a 2 "${OUT_DIR:-final}/$name.mp3"
