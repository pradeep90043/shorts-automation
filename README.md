# CodeOrCap YouTube Shorts Automation System

An enterprise-grade, fully automated, local-first pipeline to transform code screenshots sent via Telegram into highly engaging, branded YouTube Shorts.

## 🚀 Overview

This application acts as a complete background content factory. You send a code snippet or tech screenshot to your personal Telegram bot, and it automatically processes, cleans, layouts, brands, writes high-CTR titles, adds background music, renders in 1080x1920 (9:16) format with cinematic motions, and uploads it to YouTube Shorts.

```
Telegram Bot
     │ (Image Received)
     ▼
Image Analysis ──► Margins, orientation & sizing detected
     │
Branding Detection ──► Scans outer 10% edges and text coordinates for watermark markers
     │
Branding Removal ──► Shaves off headers/status bars. Bypasses and flags for manual review if in-content
     │
OCR Extraction ──► Extracts text from screenshot via local Tesseract OCR
     │
9:16 Layout Generator ──► Centers screenshot on premium cyber-grid background
     │
Branding Application ──► Overlays CodeOrCap logo, watermark, and tech-glow footer
     │
AI Metadata Engine ──► Requests viral Title, Description, and tags via Claude/Agy CLI
     │
FFmpeg Renderer ──► Synthesizes 30 FPS HD MP4 video with smooth Ken Burns zoom
     │
Audio Mixer ──► Overlay royalty-free ambient loops with 1.5s fade-in/out transitions
     │
YouTube Uploader ──► Publishes directly to YouTube Shorts via OAuth2 Data API
```

---

## 🛠 Tech Stack & Architecture

- **Runtime:** Node.js (v18+ or v20+) with TypeScript
- **Image Manipulation:** [Sharp](https://sharp.pixelplumbing.com/) (super fast native image resizing and compositing)
- **OCR Engine:** [Tesseract.js](https://tesseract.projectnaptha.com/) (fully local JS port, no external binary dependencies)
- **Video & Audio Rendering:** [FFmpeg](https://ffmpeg.org/) (native command-line binding for sub-second video assembly)
- **Telegram Wrapper:** [Telegraf](https://telegraf.js.org/) (modern bot framework)
- **YouTube API Client:** [Google APIs Node.js Client](https://github.com/googleapis/google-api-javascript-client) (OAuth2 file upload)
- **AI Engine:** Claude CLI or Antigravity (`agy`) CLI integration

### Architectural Patterns (SOLID)
- **Single Responsibility (SRP):** Each step of the pipeline lives in its own directory with a dedicated class (e.g. `OcrService`, `BrandingRemover`, `VideoRenderer`).
- **Open/Closed (OCP):** The branding detection and removal systems allow registering new detectors and removers without modifying core services.
- **Dependency Injection (DIP):** Major services implement standard interfaces defined in `src/types/index.ts`. Mock engines can be seamlessly swapped in for local testing.

---

## 📁 Directory Structure

```
shorts-automation/
├── src/
│   ├── ai/                 # AI Metadata generation (Claude / agy / fallback)
│   ├── assets/             # Branding graphic assets (logo, watermark)
│   ├── branding/           # Brand overlay service (compositing logo & custom footer)
│   ├── branding-detector/  # Modular watermark/username detection
│   ├── branding-remover/   # Header/footer cropping & manual review router
│   ├── config/             # Environment variables and configurations
│   ├── image-analysis/     # Sizing and border margin analyzer
│   ├── layout/             # 9:16 Canvas builder with cyber background
│   ├── music/              # Royalty-free music selector and audio mixer
│   ├── ocr/                # Tesseract OCR parser
│   ├── renderer/           # FFmpeg video render engine (fade/zoom effects)
│   ├── telegram/           # Telegram Bot router and downloader
│   ├── types/              # Domain entities and contracts
│   ├── utils/              # Loggers and initializers
│   ├── youtube/            # YouTube API uploader
│   ├── index.ts            # Application bootstrap entrypoint
│   └── orchestrator.ts     # Pipeline workflow orchestrator
├── temp/                   # Session folders for ongoing rendering
├── output/                 # Rendered MP4 shorts
├── logs/                   # Error and combined run logs
├── tsconfig.json           # TS Compiler options
└── package.json            # Script targets and dependencies
```

---

## 🛡 Robust Error Handling & Manual Review Loop

If the bot detects a watermark embedded directly in the screenshot's content area (where cropping would cause severe visual distortion), the pipeline is **held for manual review**:

1. The bot logs a checkpoint warning.
2. It persists the current pipeline state into `temp/gen-[id]/context.json`.
3. It sends a message to the user:
   > ⚠️ **Branding Removal Alert:**
   > Automated branding removal bypassed to prevent artifacts: _Embedded middle watermark detected, flagged for manual review_
   >
   > The pipeline has been held for **manual review**.
   > To proceed using the original image, reply with:
   > `/approve gen-1719...`
4. When the user sends `/approve [ID]`, the bot loads the state from the JSON file, marks branding removal as bypassed-approved, and resumes the layout and video rendering automatically.

---

## 🔮 Extensibility Guide (Future Modules)

This system is built with future expansions in mind. Here is how you can implement them:

### 1. Instagram / X / LinkedIn Uploaders
Define a new service interface in `src/types/index.ts`:
```typescript
export interface ISocialUploader {
  upload(videoPath: string, metadata: VideoMetadata): Promise<string>;
}
```
Create `src/instagram/index.ts` or `src/x/index.ts` using the platform's API (e.g. Graph API for Instagram) and trigger them alongside the `YouTubeService` in `src/orchestrator.ts`.

### 2. AI Voiceovers
Integrate a Text-To-Speech (TTS) tool or local model (e.g. Whisper / ElevenLabs API).
- Pass the OCR text or an AI-summarized transcript to the TTS service.
- Generate an audio file `voiceover.mp3`.
- In `src/music/index.ts`, modify the FFmpeg filter graph to merge three streams: video, voiceover (high volume, 1.0), and background music (low volume, 0.1).

### 3. Multi-Image & Video Input Support
- **Multi-Image:** Modify the Telegram Bot to detect media groups (albums) and compile their download paths into an array in `PipelineContext`. Update `LayoutGenerator` and `VideoRenderer` to stitch multiple images together into a video sequence (using FFmpeg slideshow filters).
- **Video Input:** Update `VideoRenderer` to take an input MP4, resize it to 1080x1920, apply blur overlays for vertical margins, and overlay branding without looping.

---

## 📄 License

MIT License. Designed and Built for **CodeOrCap**.
