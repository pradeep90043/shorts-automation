#!/bin/bash
# Makes sure ffmpeg and ffprobe exist on a GitHub runner. The ubuntu runner image has no ffmpeg, and a bare `apt-get install` can
# hang for good on a slow mirror or a held dpkg lock: one runner of twenty sat in this step for 18 minutes while the other
# nineteen finished in 5-10, and stalled a whole 20-minute video. Every apt call has a time limit and a retry, and a lock wait.
set -u
APT=(sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o DPkg::Lock::Timeout=60)
have() { command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; }
for attempt in 1 2 3; do
  have && exit 0
  echo "ffmpeg missing: installing (attempt $attempt/3)"
  timeout 150 "${APT[@]}" update -qq || echo "apt update did not finish"
  timeout 240 "${APT[@]}" install -y -qq ffmpeg && have && exit 0
  echo "install failed or timed out; retrying"
  sleep 5
done
echo "could not install ffmpeg after 3 attempts" >&2
exit 1
