# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — compile TypeScript (needs devDependencies)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc -p tsconfig.json

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim

# System deps: FFmpeg + Chromium (+ its runtime libs) + fonts + Python3
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    chromium \
    fonts-liberation \
    fonts-noto-core \
    fonts-noto-color-emoji \
    libnss3 \
    libatk-bridge2.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    libxkbcommon0 \
    libxshmfence1 \
    libxfixes3 \
    libxext6 \
    libxcb1 \
    libdrm2 \
    libcups2 \
    libatspi2.0-0 \
    libdbus-1-3 \
    libatk1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    ca-certificates \
    wget \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Python deps (faster-whisper: local transcription, model baked in below; pyotp: unattended 2FA for Instagram auto-login; ddgs + beautifulsoup4: search-engine reel discovery; edge-tts: free TTS for the my-video stickman renderer)
RUN pip3 install --break-system-packages instagrapi shazamio pyotp ddgs beautifulsoup4 faster-whisper numpy edge-tts

# Bake the Whisper model into the image so the VM never downloads it at runtime.
ENV WHISPER_MODEL=base \
    WHISPER_MODEL_DIR=/opt/whisper-models
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8', download_root='/opt/whisper-models')"

# yt-dlp
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Puppeteer -> system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Production node_modules only
COPY package*.json ./
RUN npm ci --omit=dev

# Optional my-video (Remotion/stickman) renderer. Only installed when the git
# submodule is checked out - the [o] globs match nothing otherwise, so the image
# still builds without it. Reuses the ffmpeg + python above, plus the apt libs for
# Chromium; Remotion fetches its own chrome-headless-shell at build time (the
# supported setup - system Chromium isn't guaranteed to work as a Remotion browser)
# so renders never download anything at runtime. Package files are copied first so the ~1 GB
# `npm ci` layer is cached until my-video's dependencies actually change.
# tsx is a devDependency there but its pipeline scripts call it at runtime, and
# `npm ci --omit=dev` would prune it from node_modules - so it is installed globally.
COPY my-vide[o]/package*.json /app/my-video/
RUN if [ -f /app/my-video/package.json ]; then \
      cd /app/my-video && npm ci --omit=dev --no-audit --no-fund && \
      npm install -g --no-audit --no-fund tsx@4 && \
      npx remotion browser ensure && \
      npm cache clean --force; \
    else echo "my-video submodule not present - stickman renderer disabled"; fi
COPY my-vide[o]/ /app/my-video/

# App code (compiled) + static assets
COPY --from=builder /app/dist ./dist
COPY public/dashboard.html ./public/dashboard.html
COPY scripts/ ./scripts/
COPY assets/ ./assets/

RUN mkdir -p temp output logs

# NOTE: secrets are NOT baked into the image. .env is provided at runtime via
# docker-compose `env_file:`, and cookies.txt via a bind mount.

EXPOSE 3000 3002

CMD ["node", "dist/index.js"]
