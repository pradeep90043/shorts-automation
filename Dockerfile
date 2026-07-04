FROM node:20-slim

# Install system dependencies: FFmpeg + Chromium + fonts + Python3
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
    ca-certificates \
    wget \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install demucs for vocal extraction (music removal)
# --break-system-packages is needed for modern pip on Debian/Ubuntu
RUN pip3 install --no-cache-dir demucs --break-system-packages || pip3 install --no-cache-dir demucs

# Install yt-dlp
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Tell Puppeteer to use the system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Copy production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy pre-compiled JavaScript dist and assets
COPY dist/ ./dist/
COPY assets/ ./assets/

# Create writable dirs
RUN mkdir -p temp output logs

# Copy env (will be overridden by docker-compose env_file or -e flags)
COPY .env .env
COPY cookies.txt* ./

EXPOSE 3000

CMD ["node", "dist/index.js"]
