# MeetingNotes — Design Spec

**Date:** 2026-04-17
**Status:** Approved, ready for implementation planning
**Target platform:** macOS (Apple Silicon, optimized for M5)

## 1. Purpose

A local-first desktop application that records business meetings via Audio Hijack, transcribes them with speaker diarization, identifies speakers against a persistent roster, and produces structured summaries with action items — all using local models served through LM Studio (plus a small Python sidecar for diarization).

The output is intended to stand on its own as meeting notes for business use: enough detail that a reader who wasn't there can understand what was discussed, what was decided, and what needs to happen next.

## 2. Scope

**In scope:**
- Trigger Audio Hijack recording from the app (AppleScript)
- Watch the Audio Hijack output folder and auto-process any new MP3s (whether recorded via the app or directly in Audio Hijack)
- Transcribe audio via LM Studio's OpenAI-compatible `/v1/audio/transcriptions` endpoint
- Speaker diarization via a local Python sidecar (`pyannote.audio`)
- Speaker identification: automatic match against a persistent voice-print roster; manual confirmation/labeling in the UI
- LLM-generated structured meeting summaries with action items
- Export of action items to Apple Reminders and Markdown; Google Tasks stubbed for future
- Model selection via dropdown populated from LM Studio `/v1/models`
- SQLite-indexed meeting library with search, filters, and detail view
- Crash-safe pipeline that resumes from the last completed stage

**Out of scope (for this release):**
- Cloud sync, multi-device sync, multi-user features
- Live/streaming transcription during a recording
- Video input, screen recording
- Editable transcripts (read-only; edit by re-running)
- Integrations beyond Reminders/Markdown (Google Tasks is a stub for later)
- Windows/Linux support

## 3. Users and usage

A single user (the operator's Mac), running business meetings via Audio Hijack. The user:
1. Clicks Record in the app (or starts Audio Hijack directly)
2. The meeting happens
3. The app processes the MP3 when Audio Hijack finishes writing it
4. The user opens the meeting, identifies any unknown speakers, and reviews the summary
5. The user exports action items to their task manager

## 4. Visual direction

"Clean Studio": light warm neutrals (stone palette), indigo/violet accents, card-based layout with generous whitespace and soft shadows. Professional and polished. Subtle motion on state changes (record pulse, stage transitions). Reference mockup: `mockups/index.html`.

## 5. Architecture

Four cooperating components, each with one clear responsibility:

### 5.1 Electron Renderer (React + Tailwind)
The entire UI. Meeting library, detail view, speaker identification, recording overlay, settings. Talks to the main process only via IPC — no direct access to the filesystem, subprocess APIs, or HTTP clients. State managed via a small store (Zustand); data fetched reactively over IPC.

### 5.2 Electron Main Process (Node.js)
The orchestrator and owner of all side effects:

- **`AudioHijackBridge`** — wraps `osascript` calls to start/stop Audio Hijack and query session state. Defaults to a configured session name (Settings).
- **`LibraryWatcher`** — `chokidar` watcher on `~/Music/Audio Hijack/`. Debounces file-write events; waits for file size to stabilize before enqueueing.
- **`Pipeline`** — persisted state machine driving a meeting from `discovered` to `done`. One meeting processed at a time by default (Whisper is GPU-heavy).
- **`LMStudioClient`** — thin wrapper over LM Studio's OpenAI-compatible API (`/v1/audio/transcriptions`, `/v1/chat/completions`, `/v1/models`). Retries on transient errors; surfaces connection failures explicitly.
- **`DiarizationClient`** — HTTP client for the Python sidecar.
- **`SpeakerRoster`** — persists voice embeddings per known speaker; matches new unknown speakers by cosine similarity.
- **`Storage`** — SQLite index + filesystem artifacts. SQLite is an index only; filesystem is source of truth (see §7).
- **`Exporters`** — pluggable exporter interface with implementations for `AppleReminders`, `Markdown`, and a stub for `GoogleTasks`.

### 5.3 Python Sidecar (`meeting_notes_diarize`)
FastAPI + uvicorn process, spawned by the main process on app startup, shut down on app quit. Single responsibility: speaker diarization.

Endpoints:
- `GET /health` — readiness check
- `POST /diarize` — accepts audio file path (shared filesystem); returns JSON `{ segments: [{start, end, speaker, embedding}], num_speakers }`

Uses `pyannote.audio 3.x`. Hugging Face token read from env or config file. Supervised by the main process (restart up to 3 times with backoff).

### 5.4 LM Studio (external)
User-managed. The app discovers running models via `/v1/models` and presents them in the Settings dropdown. App does not start, stop, or install LM Studio.

### 5.5 Boundary rule
The renderer knows about meetings and their states. It does not know about subprocesses, HTTP, or AppleScript. All side effects live in the main process or the sidecar.

## 6. Data flow (pipeline)

Each meeting flows through a persisted state machine:

```
discovered → transcribing → diarizing → merging → identifying → summarizing → extracting → done
```

Stage transitions are written to `meeting.json` and the SQLite `meetings.pipeline_stage` column **before** work begins, so a crash mid-stage resumes cleanly on next launch.

1. **discovered** — `LibraryWatcher` detects a new `.mp3` (or `AudioHijackBridge` reports session stopped). Creates the meeting folder, symlinks the audio, seeds `meeting.json` from the filename.
2. **transcribing** — `LMStudioClient.transcribe(audio)` → POST `/v1/audio/transcriptions` with `response_format=verbose_json`. Writes `transcript.raw.json`.
3. **diarizing** — `DiarizationClient.diarize(audio)` → writes `diarization.json`. Runs in parallel with transcribing (same audio, no contention).
4. **merging** — pure function: aligns Whisper word timestamps with pyannote segments. Produces `transcript.md` formatted `[Speaker 1 00:00:14] …`. Deterministic, re-runnable.
5. **identifying** — for each local speaker label, compute cosine similarity against every embedding in the roster. If top match ≥ 0.75 → auto-link (confidence stored). Otherwise → keep as `Speaker N` and flag for user. User can confirm/override anytime; confirming persists the embedding to the roster.
6. **summarizing** — builds a prompt from the speaker-labeled transcript, calls LM Studio `/v1/chat/completions`. Prompt asks for sections **Overview, Key Discussion Points, Decisions, Action Items, Follow-ups, Open Questions**, skipping any empty section. Writes `summary.md`.
7. **extracting** — second LLM call, tighter prompt: "extract action items as JSON with owner, text, due_date." Writes `action-items.json`. (Two-pass is more reliable than one mega-prompt.)
8. **done** — visible in library with full detail view.

### 6.1 Re-run semantics
Any stage past `discovered` can be manually re-run from the UI (new model, renamed speaker, etc.). Re-running a stage invalidates all downstream stages and re-runs them automatically.

### 6.2 Concurrency
Default: one pipeline at a time. Queue visible as a chip in the UI ("2 meetings processing…"). Transcribe + diarize within a meeting run concurrently.

### 6.3 Crash recovery
On app launch, `PipelineRecovery` finds every meeting in a non-terminal state and resumes from the last completed stage (assuming any in-progress stage was interrupted and re-runs it).

## 7. Storage layout

### 7.1 Filesystem (source of truth)

```
~/Music/Audio Hijack/                     ← Audio Hijack owns this (untouched)
  Session 2026-04-17 14.32.mp3

~/Documents/MeetingNotes/
  db.sqlite                               ← index + metadata + speaker roster
  meetings/
    2026-04-17-q2-planning-a3f8/          ← slug-<shortid>, stable forever
      meeting.json                        ← source of truth for this meeting
      audio.mp3                           ← symlink → ~/Music/Audio Hijack/…
      transcript.raw.json                 ← whisper segments (word timestamps)
      diarization.json                    ← pyannote segments + embeddings
      transcript.md                       ← merged, speaker-labeled
      summary.md                          ← LLM output
      action-items.json                   ← extracted structured list
      exports/                            ← reminders-synced.json, tasks.md, …
  speakers/
    embeddings/<speaker-id>.npy           ← persisted voice prints
```

### 7.2 SQLite schema (index only)

- `meetings` — `id, slug, title, started_at, duration_s, audio_path, status, pipeline_stage, created_at, updated_at`
- `speakers` — `id, display_name, created_at, notes`
- `meeting_speakers` — `meeting_id, roster_speaker_id, local_label, confidence`
- `action_items` — `id, meeting_id, text, owner_speaker_id, due_date, status, exported_to (JSON)`
- `settings` — `key, value`

### 7.3 Rebuildability
Every meeting can be reconstructed from its folder alone. Deleting `db.sqlite` and re-scanning must yield the same library. Filesystem artifacts are authoritative.

### 7.4 `meeting.json` shape

```json
{
  "id": "a3f8",
  "slug": "2026-04-17-q2-planning-a3f8",
  "title": "Q2 Planning",
  "started_at": "2026-04-17T14:32:00-04:00",
  "audio": { "path": "/Users/.../Session 2026-04-17 14.32.mp3", "duration_s": 2341 },
  "pipeline": { "stage": "done", "errors": [] },
  "speakers": [
    { "label": "Speaker 1", "roster_id": "spk_07", "confidence": 0.91 }
  ],
  "models": { "stt": "whisper-large-v3", "llm": "llama-3.1-8b-instruct" }
}
```

## 8. UI structure

### 8.1 Library (home)
- Top bar: app title, ⏺ Record button (indigo/violet gradient), Settings gear
- Filter row: search, date range, speaker chip filter, status filter
- Meeting list as cards: title, date/duration, speaker avatars, status pill, action-item count. Cards with unidentified speakers show an amber "N speakers to identify" nudge.
- Empty state: friendly illustration + "Hit record or drop an MP3 in `~/Music/Audio Hijack`"

### 8.2 Meeting detail
Three-pane layout:
- **Left rail:** inline-editable title, date, duration, models used, re-run buttons per stage
- **Center:** tabbed — *Summary* (markdown with interactive action-item checkboxes), *Transcript* (speaker-labeled, timestamp click seeks audio), *Audio* (waveform scrubber)
- **Right rail:** Speakers panel (avatar, snippet, autocomplete "Who is this?" for unknowns, edit pencil for knowns). Export panel: Apple Reminders, Markdown, Google Tasks (greyed, "coming soon").

### 8.3 Recording overlay
Minimal modal: live elapsed timer, animated waveform, Audio Hijack session indicator, Stop button. On stop, closes and navigates to the detail view as processing begins.

### 8.4 Settings
Model dropdowns (from LM Studio `/v1/models`), STT language, summary prompt tweaks (collapsed), library paths, exporter toggles, Audio Hijack session name, speaker roster management (list, rename, delete, merge).

### 8.5 Keyboard shortcuts
- `⌘R` record/stop · `⌘F` search library · `⌘,` settings
- `J/K` move between meetings in list view
- `Space` play/pause in detail view

### 8.6 Processing feedback
- Thin top-of-window progress bar during active pipeline stages
- Stage name toast ("Transcribing… 47%")
- Error banners dismissible with a Retry button

## 9. Integration details

### 9.1 Audio Hijack control
`osascript` subprocess calls to a named session. Commands: `start session "<name>"`, `stop session "<name>"`, `get session state "<name>"`. Failure on any command surfaces as an error toast with the user-actionable hint.

### 9.2 LM Studio client
- Base URL from Settings (default `http://localhost:1234`)
- `/v1/models` on startup and every 30 s for Settings population
- `/v1/audio/transcriptions` with `model`, `file` (multipart), `response_format=verbose_json`
- `/v1/chat/completions` with `model`, `messages`, `temperature=0.2` for summary; `temperature=0` for action-item extraction (structured output)
- Timeout: 10 min for transcription; 2 min for chat calls; 5 s for `/v1/models`
- Retries: 3 with exponential backoff for 5xx and connection errors; fail fast on 4xx

### 9.3 Diarization sidecar protocol
- `POST /diarize` with JSON `{ "audio_path": "/abs/path.mp3" }`
- Response: `{ "segments": [{"start": float, "end": float, "speaker": "SPEAKER_00", "embedding": [float…]}], "num_speakers": int }`
- Embeddings are 512-dim float vectors (pyannote default)
- Shared-fixture contract test ensures Node and Python don't drift

### 9.4 Speaker matching
Cosine similarity between a meeting's per-speaker averaged embedding and each roster embedding. Threshold ≥ 0.75 auto-links. User confirmation updates the roster embedding via running-average update (`new = 0.7 * old + 0.3 * observed`).

## 10. Error handling and resilience

- **LM Studio unreachable** — pipeline parks at affected stage; top-of-app banner with Retry. Auto-resumes on reconnect.
- **Model missing in LM Studio** — Settings flags selected model in red; pipeline error specifies which model is missing.
- **Sidecar crash** — supervisor restarts up to 3× with backoff, then surfaces an error. Sidecar logs at `~/Library/Logs/MeetingNotes/diarize.log`.
- **Audio Hijack failure** — Record button shows error toast; library watcher still functions so manual-drop workflow works.
- **Corrupted/empty MP3** — `ffprobe` validation before pipeline; reject with a clear error; no meeting folder created.
- **App crash mid-pipeline** — resume-from-last-completed-stage on next launch.
- **Disk full / write error** — surface immediately; never silently drop data.

### 10.1 Observability
- Structured JSON-lines logs at `~/Library/Logs/MeetingNotes/app.log` (rotated)
- In-app "Activity" drawer shows last 50 pipeline events

## 11. Testing strategy

- **Unit (Vitest)** — heavy coverage of pure functions: transcript/diarization merger, action-item parser, cosine-similarity matcher, slug generator, filename→auto-title parser, stage-transition validator. Target 90%+ on `lib/` pure modules.
- **Integration (Vitest + mocks)** — `LMStudioClient` and `DiarizationClient` tested against captured JSON fixtures. Pipeline tested end-to-end with a tiny sample MP3 and mocked clients. Crash-recovery test: kill mid-stage, reopen, assert resume behavior.
- **Sidecar (pytest)** — audio-in-JSON-out contract, embedding determinism, error-envelope shape.
- **Contract tests** — shared `samples/short-meeting.mp3` with expected output schema; both sides assert against it.
- **Manual smoke-test checklist** (`docs/testing.md`) — record a 2-min meeting, process, verify each artifact, identify a speaker, re-run summary, export to Reminders. Runs before every release.
- **No UI component tests initially** — renderer is deliberately thin; add Playwright e2e if complexity grows.

## 12. Performance expectations (M5)

- Whisper-large-v3 via LM Studio: ~0.2× realtime → 1 hr meeting ≈ 12 min transcribe
- Pyannote diarization: ~0.05× realtime → 1 hr ≈ 3 min
- Summary (8B-class LLM): seconds
- Transcribe + diarize run concurrently per meeting; LLM stages after

## 13. Project structure

```
MeetingNotes/
  package.json
  electron/
    main/                   ← main process (TypeScript)
      index.ts
      pipeline/
      audio-hijack/
      lm-studio/
      diarization/
      storage/
      speakers/
      exporters/
      supervisor/
    preload/                ← IPC bridge
    renderer/               ← React app (Vite)
      src/
        components/
        views/
        store/
        ipc/
  sidecar/
    meeting_notes_diarize/
      app.py                ← FastAPI
      diarize.py            ← pyannote wrapper
      pyproject.toml
  samples/                  ← fixture audio + expected outputs
  docs/
    superpowers/specs/
    testing.md
  mockups/                  ← HTML design references
```

## 14. Dependencies

### 14.1 Runtime
- **Node.js 20+** (Electron 30+)
- **Python 3.11+** with `pyannote.audio`, `fastapi`, `uvicorn`, `torch` (MPS)
- **LM Studio** (user-installed) with at least one Whisper model and one chat LLM
- **Audio Hijack** (user-installed)
- **Hugging Face token** for pyannote model download

### 14.2 Key npm packages (provisional)
`electron`, `react`, `tailwindcss`, `zustand`, `better-sqlite3`, `chokidar`, `zod` (validation), `openai` (LM Studio client), `vitest`, `playwright` (later)

## 15. Open questions deferred to implementation

These are acknowledged and intentionally deferred; they don't block a plan:
- Exact prompt text for summarization and action-item extraction (to be iterated during implementation)
- Whether to bundle a venv installer or require `pip install` (lean toward a first-run setup wizard)
- App distribution format (dmg vs. unpackaged for personal use)

## 16. Non-goals / explicitly rejected

- Building our own STT or diarization models (use LM Studio + pyannote)
- Hosting a background service independent of the app (app-lifetime sidecar is simpler)
- Multi-user or multi-tenant design
- Real-time transcription during the recording
