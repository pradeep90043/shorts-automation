# CodeOrCap Shorts Automation
## Production Pipeline Engineering Roadmap

This document outlines the roadmap, priorities, and technical scope for upgrading the linear script-based shorts-automation pipeline into a distributed, event-driven, production-grade AI content factory.

---

## Priority Phases & Implementation Matrix

| Phase | Feature Name | Core Technical Components | Complexity | Business Impact |
| :--- | :--- | :--- | :--- | :--- |
| **Phase 1: Foundation** | 1. Persistent Job State | SQLite / Prisma ORM / SQL schemas | Medium | High (Crash recovery, debugging) |
| | 2. AI Result Caching | SHA-256 media hashing / Cache table | Low | High (Massive cost savings) |
| **Phase 2: Reliability** | 3. Redis Job Queue | BullMQ / Redis / Worker processes | High | High (Parallel jobs, retries) |
| | 4. Event-Driven Loop | Event emitter / Pub-Sub pattern | Medium | Medium (Loose coupling) |
| **Phase 3: AI Quality** | 5. Vision-First OCR | FreeLLMAPI vision / OCR fallback | Medium | High (Accurate text parsing) |
| | 6. Auto Safe Area | Vision AI layout boundaries / Margins | Medium | High (Zero UI text cutoffs) |
| | 7. Semantic Chunking | LLM syntactic parser / Dynamic arrays | Low | High (Improved readability) |
| **Phase 4: UX & Motion** | 8. Timed Captions | Whisper API / Word timestamp parser | High | High (TikTok/Netflix subtitles) |
| | 9. Face/Object Avoidance | OpenCV / YOLO / Bbox overlap filters | High | Medium (Professional framing) |
| | 10. Auto Sound Ducking | FFmpeg `compand` or sidechain filters | Medium | Medium (High-end audio quality) |
| **Phase 5: Strategy** | 11. Multi-Caption A/B | LLM variant prompter / Telegram select | Low | Medium (CTR optimization) |
| | 12. Viral Analyzer | GPT-4o curation / Retention scoring | Medium | High (Better CTR matching) |
| | 13. Analytics Feedback | YouTube API metrics / Vector database | High | High (Self-improving loops) |

---

## Architectural Deep Dive of Priority Tasks

### Phase 1: Database Foundation & Hashing (Prerequisites)
1. **SQLite Database Schema**:
   - Create a `jobs` table to persist pipeline contexts (fields: `id`, `status`, `current_step`, `media_path`, `ocr_result`, `rephrased_caption`, `metadata_json`, `youtube_url`).
   - Create a `cache` table (fields: `hash_key`, `vision_result`, `ocr_result`, `caption`, `created_at`).
2. **AI Cache Logic**:
   - Before running OCR or AI vision, compute a SHA-256 checksum of the downloaded raw image/video.
   - If the hash exists in the cache, retrieve results immediately. Bypass vision and OCR API calls, skipping directly to layout compiling/Remotion.
   - Saves up to 80% on API costs during prompt regeneration loops.

### Phase 2: Distributed Processing with BullMQ & Redis
1. **BullMQ Worker Architecture**:
   - Run a standalone Redis instance.
   - Define a queue named `shorts-pipeline`.
   - Implement dedicated job handlers (workers) for each queue stage:
     - `DownloadWorker` (Instagram/TikTok downloading)
     - `AnalysisWorker` (AI Vision + OCR)
     - `CompileWorker` (Remotion rendering)
     - `ReviewWorker` (Telegram interaction hold)
     - `FinishWorker` (Music mixing + YouTube publishing)
2. **State Recovery**:
   - If a worker crashes or restarts, BullMQ automatically retries the job or picks it up from the last persisted state in Redis/SQLite, eliminating restarts from the beginning.

### Phase 3: Vision-First Text & Safe Area Extraction
1. **Vision-First Parsing**:
   - Instruct the vision model to extract all text on the frame. If confidence is low or characters are blurry, fall back to Tesseract multi-pass OCR.
2. **Safe Area Detection**:
   - The AI identifies focal coordinates (faces, main subjects, UI overlays).
   - Generates a `safeArea` bounding box where Remotion can place text without overlapping visual details.

### Phase 4: Semantic Chunking & Analytics Feedback
1. **Semantic Text Splitter**:
   - Feeds the rephrased caption to the LLM to segment it into natural grammatical phrases (hooks, bodies, calls-to-action) rather than static 4-word cutoffs.
2. **Analytics Loop**:
   - A daily cron job queries the YouTube API for views, watch time, and retention curves of published Shorts.
   - Saves performance metrics back into SQLite and references them as contextual prompt memories for the AI hook generator.

---

## Next Implementation Steps

1. **Step 1**: Initialize SQLite database persistent state and implement SHA-256 media hashing.
2. **Step 2**: Integrate Redis/BullMQ to partition the orchestrator into queue-based workers.
