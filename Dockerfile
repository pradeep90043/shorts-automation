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
    ca-certificates \
    wget \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Python deps (pyotp: unattended 2FA for Instagram auto-login; ddgs + beautifulsoup4: search-engine reel discovery)
RUN pip3 install --break-system-packages instagrapi shazamio pyotp ddgs beautifulsoup4

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
