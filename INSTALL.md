# Installation & Setup Guide

Follow this guide to get the CodeOrCap YouTube Shorts Automation pipeline running locally on your system.

---

## 📋 System Prerequisites

1. **Node.js (v18.x or v20.x+):** Ensure you have Node.js installed.
2. **NPM:** Installed automatically with Node.js.
3. **FFmpeg:** Needed for rendering video and mixing audio.
   - **macOS:** Install via Homebrew:
     ```bash
     brew install ffmpeg
     ```
   - **Linux (Ubuntu/Debian):** Install via APT:
     ```bash
     sudo apt update && sudo apt install -y ffmpeg
     ```
   - **Windows:** Download from the [FFmpeg Build website](https://ffmpeg.org/download.html) and add the `/bin` folder to your system's PATH.

---

## 🛠 Project Installation

1. Navigate to the project folder `shorts-automation`:
   ```bash
   cd shorts-automation
   ```

2. Install all npm dependencies:
   ```bash
   npm install
   ```

3. Create your local environment configuration by copying `.env.example`:
   ```bash
   cp .env.example .env
   ```

4. Edit the `.env` file and populate your configurations (see below).

---

## 🤖 Step 1: Telegram Bot Token Setup

1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the instructions to choose a name and username.
3. Copy the HTTP API token provided by BotFather.
4. Add it to your `.env` file:
   ```env
   TELEGRAM_BOT_TOKEN=your_copied_api_token_here
   ```

---

## 🔑 Step 2: YouTube OAuth2 Credentials Setup

To upload directly to YouTube via API, you need Google OAuth2 credentials with the YouTube upload scope.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project.
3. Go to **API Library** and search for **YouTube Data API v3**. Click **Enable**.
4. Go to **OAuth Consent Screen**:
   - Choose **External**.
   - Fill in user support email and developer contact information.
   - Under **Scopes**, click **Add or Remove Scopes** and add:
     `.../auth/youtube.upload`
   - In **Test users**, add the email address of your YouTube channel.
5. Go to **Credentials**:
   - Click **Create Credentials** -> **OAuth client ID**.
   - Application type: **Web application**.
   - Authorized redirect URIs: Add `http://localhost:3000/oauth2callback` (or your preferred redirect).
   - Save your **Client ID** and **Client Secret**.
6. Set these variables in your `.env` file:
   ```env
   YOUTUBE_CLIENT_ID=your_client_id
   YOUTUBE_CLIENT_SECRET=your_client_secret
   ```
7. To obtain the **Refresh Token**, you can run a simple helper script (or use tools like OAuth Playground) to authorize your application once and extract the refresh token. 
   *(Note: If you leave the credentials empty or incomplete, the service will run in **SIMULATED** mode so you can test all other steps of the pipeline without uploading).*

---

## 🧠 Step 3: AI CLI Setup (Optional)

This system integrates with `claude` CLI or `agy` (Antigravity) CLI.

- By default, `AI_PROVIDER` is set to `mock`. This activates a local NLP keywords analyzer that generates highly relevant high-CTR titles and descriptions based on Tesseract OCR results without calling any network APIs.
- To connect to a live LLM CLI:
  1. Set `AI_PROVIDER=claude` or `AI_PROVIDER=antigravity` in `.env`.
  2. Specify the binary paths:
     ```env
     CLAUDE_CLI_PATH=claude
     ANTIGRAVITY_CLI_PATH=agy
     ```
  3. Ensure the selected CLI is installed and configured on your terminal.

---

## 🎵 Step 4: Add Royalty-Free Background Music

By default, the bootstrap loader will programmatically synthesize a 20-second ambient audio sweep using FFmpeg if the music folder is empty.

To use custom tracks:
1. Place any `.mp3`, `.wav`, `.m4a` or `.aac` audio files in the `assets/music/` folder.
2. The pipeline will randomly pick one of these files, lower its volume to the configured percentage (e.g. `MUSIC_VOLUME=0.12`), and fade it in/out for each render.

---

## 🏃 Running the Application

### Development Mode
Runs the application with `ts-node` and watches files for changes:
```bash
npm run dev
```

### Production Mode
Compiles TypeScript to JavaScript and runs the compiled binary:
```bash
# Compile TS to JS
npm run build

# Start server
npm run start
```
