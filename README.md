# MeetingNotes

![MeetingNotes banner](docs/banner.png)

[![Platform](https://img.shields.io/badge/platform-macOS%2014.2%2B-blue)](https://support.apple.com/en-us/HT201260)
[![Architecture](https://img.shields.io/badge/arch-Apple%20Silicon-black)](https://support.apple.com/en-us/HT211814)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Status: Alpha](https://img.shields.io/badge/status-alpha-orange)](#status)
[![Electron](https://img.shields.io/badge/electron-30-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

Local-first meeting notes for macOS. Hit Record, pick which app's audio you want to capture (Zoom, Teams, FaceTime, etc.) plus your mic, and MeetingNotes records, transcribes, diarizes, identifies speakers, summarises, and extracts action items — all on your machine. No cloud, no uploads, no API keys at inference time, no third-party recorder to install.

## Screenshots

| Library | Recording in progress |
| --- | --- |
| ![Unified library list — filter chips across every state, progress indicator on in-flight rows, action-items count + speakers on done rows](docs/screenshots/library.png) | ![Live recording row docked above the library — mic + system audio mix, elapsed timer, VU meter, Stop button](docs/screenshots/recording.png) |

| Speaker-ID gate | Summary editor |
| --- | --- |
| ![Detail view parked at the speaker-ID gate — amber banner above the pipeline timeline prompts naming unknown voices before summarise runs](docs/screenshots/speaker-id.png) | ![Finished meeting — pipeline complete, rendered summary with sections, identified speakers, action-items ready to export](docs/screenshots/summary.png) |

## Why

Most meeting-transcription tools either ship your audio to a SaaS, lock you into their recorder, or only do half the job. MeetingNotes runs the whole pipeline locally:

- **Recording** via a bundled Swift CLI helper using macOS 14.2+ CoreAudio Process Tap (the API Apple introduced for exactly this) — captures any app's audio + mic into a mixed M4A plus two sidecar stems (`.voice.m4a`, `.system.m4a`) for stem-aware transcription
- **Meeting auto-detect** (opt-in) watches your frontmost browser tab for known meeting URLs — Meet, Zoom web, Teams, Whereby, Jitsi, and others — and offers to record with one click
- **Transcription** via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (Metal-accelerated on Apple Silicon). With stems present, each stream is transcribed independently: you're always labelled "You", remote speakers get clean per-stream audio
- **Diarization** via [pyannote 3.1](https://github.com/pyannote/pyannote-audio) in a Python sidecar (runs on the system stem only when stems are present)
- **Speaker identification** by matching voice embeddings against a roster you build over time
- **Summarisation + action items** via any chat LLM loaded in [LM Studio](https://lmstudio.ai) or [Ollama](https://ollama.com). Reasoning models welcome — `<think>` blocks are stripped before rendering. The app can either talk to an external server you already run, or spawn `lms server start` / `ollama serve` on demand and shut it down after idle
- **Weekly digest** (Mon–Fri) — a tab that rolls every meeting in the current ISO week into a 2–3 paragraph LLM-synthesised narrative + a meetings list + open action items grouped by owner + key decisions. Cached per week, regenerable, exportable as Markdown
- **Export** to Apple Reminders or Markdown (with a markdown editor + live preview built in)

You bring the models. MeetingNotes orchestrates everything else.

## Status

Alpha. Tested on macOS 14.2+ / Apple Silicon. End-to-end pipeline working: built-in recording → transcribe → diarize → speaker-ID gate → summarise → extract → export. Rough edges in error-state polish and "All system audio" capture path.

## Requirements

- **macOS 14.2 (Sonoma) or later** on Apple Silicon
- ~16 GB RAM minimum (whisper + a 9B LLM)
- A chat-LLM runtime — either [LM Studio](https://lmstudio.ai) or [Ollama](https://ollama.com), with a model installed (default: `qwen/qwen3.5-9b` in LM Studio). MeetingNotes can either talk to it externally (you start it yourself) or manage its lifecycle for you (Settings → "Summary provider" → managed). Default is external for backward compat.
- HuggingFace account with three pyannote model licences accepted (one-time, see below)

## Quick start

```bash
git clone https://github.com/dbbaskette/MeetingNotes.git
cd MeetingNotes

brew install whisper-cpp ffmpeg

# Single interactive setup: deps, sidecar venv, model, HF token, .app build.
./scripts/setup.sh

# One command to launch the stack + the .app.
./scripts/start.sh
```

`start.sh` auto-opens LM Studio if installed, exports the HF token, health-checks the stack, and opens the packaged `.app`. Use `start.sh --dev` for hot-reload development. **All three model services run on demand** — the diarization sidecar (~500 MB), whisper-server (~1.5 GB for `medium.en`), and (in `lm-studio` / `ollama` managed mode) the summarisation LLM. First call wakes the service; 10 minutes of inactivity shuts it down. RAM stays at zero between meetings.

**First launch**: macOS will prompt for two permissions — microphone, then "Screen & System Audio Recording" the first time you click ⏺ Record. Grant both; MeetingNotes will appear by name in System Settings → Privacy & Security. If you enable **Watch browser tabs for meeting URLs** in Settings, macOS will also prompt once per browser for Automation access.

## Recording a meeting

1. Click **⏺ Record** in the top right — or, with **Watch browser tabs for meeting URLs** enabled in Settings, wait for the in-library banner when a known meeting opens in Chrome / Safari / Arc / Edge / Brave and click **Record** from there.
2. The source picker shows every app currently producing audio. Recognised meeting apps (Zoom, Teams, FaceTime, Slack, Discord, WhatsApp) appear first with a `MEETING` badge. Pick one — or `All system audio` as a catch-all.
3. A live recording row appears at the top of the library with elapsed time, VU meter, and a Stop button.
4. Click **■ Stop** when the meeting ends. The recording shows up in your Inbox within a second.
5. Click **▶ Process** to run it through the pipeline.

Each recording writes three files to `~/Music/MeetingNotes/`:

- `recording-<timestamp>-<id>.m4a` — mixed mic + tap, the primary file you play back
- `recording-<timestamp>-<id>.voice.m4a` — mic stem only
- `recording-<timestamp>-<id>.system.m4a` — tap stem only

AAC mono at 128 kbps. A one-hour meeting is ~60 MB for the mixed file plus similar per stem.

### Managing recordings

Every row in the Inbox, Library, and the detail-view header exposes a **⋯** actions menu with **Rename…** and **Delete…**. Delete is a hard delete — it removes the mixed m4a, both stems, the meeting folder (transcript / summary / exports), and the database row.

## How the pipeline works

```
⏺ Record button ──▶ Swift helper (Process Tap + AVAudioEngine)
                              │
                              ▼ writes M4A
                    ~/Music/MeetingNotes/
                              │
                              ▼ chokidar watcher
                       Inbox row (pending)
                              │
                              ▼ user clicks Process
                       ┌──────────────┐
                       │  Pipeline    │
                       │              │
                       │  transcribe ─┼──▶ whisper-server (8080)
                       │              │       (stems present → voice +
                       │              │        system transcribed
                       │              │        separately, voice = "You")
                       │  diarize ────┼──▶ pyannote sidecar (8765)
                       │              │       (system stem only when stems
                       │              │        exist; mixed file otherwise)
                       │  merge       │       (M4A → 16kHz WAV via ffmpeg
                       │  identify ───┼──▶     before STT; soxr when
                       │              │        available for best quality)
                       │  ▼           │
                       │  awaiting_   │   ◀── pause: name unknown voices
                       │  speaker_id  │       (or check Skip for this meeting)
                       │  ▼           │
                       │  re-merge    │   ◀── transcript.md gets real names
                       │  summarise ──┼──▶ LM Studio (1234)
                       │  extract ────┼──▶ LM Studio (1234)
                       └──────┬───────┘
                              ▼
                  ~/Documents/MeetingNotes/meetings/<slug>/
                    ├── audio.m4a (symlink)
                    ├── transcript.raw.json
                    ├── diarization.json
                    ├── transcript.md      (with real speaker names after gate)
                    ├── summary.md
                    └── action-items.json
```

`transcribe` and `diarize` run in parallel; the rest are sequential. Each meeting is one row in SQLite at `~/Documents/MeetingNotes/db.sqlite` and one folder under `meetings/`. Crash-safe: if the app dies mid-pipeline, recovery resumes `status='processing'` meetings on next launch; `status='failed'` waits for explicit retry.

### The speaker-ID gate

After diarize + identify, the pipeline pauses at `awaiting_speaker_id`. The library row turns amber with a `NAME VOICES` chip. In the meeting detail view you'll see each unidentified voice with a **▶ Play sample** button (8-second clip of just that speaker) and a dropdown to either link to an existing roster entry or create a new one. Click **Continue** to proceed to summarize/extract — the transcript gets re-merged with real names baked in.

Don't care for this meeting? Toggle **Skip speaker ID** at the top of the detail view (or before recording finishes, on the row itself). Pipeline runs end-to-end without pausing.

### Summary editor

The Summary tab has three modes — **Preview** (rendered markdown), **Split** (textarea + live preview), **Edit** (full-width textarea). LLM hallucination, formatting tweaks, redactions — fix in place and Save. Edits write to `summary.md` on disk. Re-running summarize from the rerun buttons will overwrite, so don't re-summarize work you've hand-edited.

### Weekly view

The **Weekly** tab in the top bar (next to the MeetingNotes logo) rolls every meeting in an ISO week — Mon → Sun, defaulting to the current week — into a single page:

- **Overview** — a 2–3 paragraph LLM-synthesised narrative covering the week's focus, follow-ups owed, and what's heading into next week. Cached per week; regenerable from the Overview card. Cache invalidates automatically when meetings are added, retitled, or deleted.
- **Meetings** — chronological list with day/time/duration/highlight; click a row to drill into that meeting.
- **Open action items** — grouped by owner. If you've set yourself as a roster speaker (Settings → "You are…"), your own items pin to the top in a "You" group. Otherwise it's plain owner alphabetical.
- **Key decisions** — extracted by the same LLM call as the narrative.

**Navigation**: prev/next arrows step through weeks. Empty weeks show a placeholder rather than running the LLM. The first view of a non-cached week kicks off the LLM call (10–60 s typical on a local model); the page paints the structured rollup immediately while the Overview card shows a skeleton with an elapsed-time counter so you can see progress.

**Export**: top-right Export button opens a save dialog for `weekly-YYYY-Www.md`. Cancel = copies to clipboard instead.

## Setup script

`./scripts/setup.sh` is idempotent — re-run any time to repair an install, change Whisper models, swap the LLM, or rotate the HF token.

```bash
./scripts/setup.sh                              # interactive, all steps
./scripts/setup.sh --model large-v3             # non-interactive model swap
./scripts/setup.sh --skip-npm --skip-sidecar --skip-whisper --skip-hf --skip-dist
                                                # just the LLM/STT config step
```

Eight phases: prereq check, `npm install`, Python sidecar venv, library directories, Whisper model picker, HF-token prompt, LM Studio chat-model picker (lists loaded models via `/v1/models`), and the `.app` build. Each phase has a `--skip-*` flag.

Whisper model picker offers `tiny.en` · `base.en` · `small.en` · `medium.en` (default) · `medium` · `large-v3` · `large-v3-turbo`. Models live under `~/Library/Application Support/MeetingNotes/whisper-models/`.

## Launcher + runtime tools

```bash
./scripts/start.sh                  # production: opens .app (also auto-launches LM Studio)
./scripts/start.sh --dev            # development: `npm run dev`
./scripts/start.sh --status         # what's running
./scripts/start.sh --stop           # stops any leftover whisper-server daemon from prior versions

./scripts/whisper-server.sh install # interactive model picker — installs to ~/Library/Application Support/MeetingNotes/whisper-models
./scripts/whisper-server.sh models  # list installed

# These are still in the script for power users who want to run whisper-server
# manually. The app no longer requires them — it spawns whisper-server itself
# on demand and adopts an existing instance if one is already running.
./scripts/whisper-server.sh daemon  # start STT server in background (manual mode)
./scripts/whisper-server.sh status
./scripts/whisper-server.sh stop

./scripts/doctor.sh                 # read-only health check
```

App logs: `~/Library/Logs/MeetingNotes/app.log`. Whisper-server logs (when run manually): `~/Library/Logs/MeetingNotes/whisper-server.log`.

### `doctor.sh`

Checks binaries (node, python3, ffmpeg, whisper-server), filesystem (library dirs, recordings folder), sidecar (venv, HF token cache, HF model cache), services (whisper-server reachable, LM Studio reachable + loaded models, diarization sidecar), and native modules (better-sqlite3 loadability under Node).

## Configuration

Settings live in SQLite at `~/Documents/MeetingNotes/db.sqlite` (table `settings`). Edit in the app's Settings view, or via `setup.sh`.

| Key | Default | What it does |
| --- | --- | --- |
| `summaryProvider` | `external` | who manages the summarization LLM lifecycle. `external` = you run LM Studio / Ollama yourself (this matches the original behavior). `lm-studio` = MeetingNotes spawns `lms server start` on demand and runs `lms load <llmModel>` to pull the model into VRAM, idle-shutdown after 10 min. `ollama` = MeetingNotes spawns `ollama serve` (Ollama auto-loads/unloads models via `OLLAMA_KEEP_ALIVE`). The Settings UI dims options whose CLI isn't installed. |
| `lmStudioUrl` | `http://localhost:1234` | chat/LLM endpoint for `external` mode. Managed providers use their own ports (`lm-studio` → `:1234`, `ollama` → `:11434`); the `LMStudioClient`'s base URL follows the active provider live. |
| `sttUrl` | `http://127.0.0.1:8080` | whisper-server endpoint |
| `sttModel` | `whisper-1` | model file to load when the app spawns whisper-server. Resolved against `~/Library/Application Support/MeetingNotes/whisper-models/ggml-<name>.bin`. If the named model isn't installed, falls back to the auto-pick preference order (medium.en → small.en → large-v3-turbo → ...). |
| `llmModel` | `qwen/qwen3.5-9b` | model id for summarisation/extraction. In `external` mode it's informational (whatever you've loaded in LM Studio is what gets used); in `lm-studio` managed mode the supervisor runs `lms load <id>` for it; in `ollama` mode it's the model the OpenAI-compat call requests (Ollama lazy-loads). |
| `userSpeakerId` | `null` | the roster speaker that represents you. When set, the Weekly view pins your own open action items to a "You" group at the top. Picker in Settings → "You are…" — populated by speakers you've confirmed in any meeting's Speakers panel. |
| `libraryPath` | `~/Documents/MeetingNotes` | meetings, db, embeddings |
| `audioWatchPath` | `~/Music/MeetingNotes` | folder watched for new recordings (also watches `~/Music/Audio Hijack` for one release as a legacy fallback) |
| `recordingBitrateKbps` | `128` | AAC bitrate for new recordings (96 / 128 / 192) |
| `sttLanguage` | `en` | passed to Whisper |
| `userName` | `""` | your name — used to label the voice stem in transcripts (empty falls back to the literal "You") |
| `autoDetectMeetings` | `false` | poll the frontmost browser tab for meeting URLs and offer to record. Requires granting Automation permission to each browser the first time |
| `exporterApple` | `true` | enable Apple Reminders exporter |
| `exporterMarkdown` | `true` | enable Markdown exporter |

### Hugging Face token

pyannote's diarization models are *gated* on Hugging Face. One-time setup:

1. Accept the licence on all three of:
   - https://huggingface.co/pyannote/speaker-diarization-3.1
   - https://huggingface.co/pyannote/segmentation-3.0
   - https://huggingface.co/pyannote/speaker-diarization-community-1 *(pyannote 3.4+ pulls the PLDA component from this one at runtime)*
2. Create a **fine-grained** token at https://huggingface.co/settings/tokens with scope "Read access to contents of all public gated repos you can access".
3. Paste it when `setup.sh` prompts. It's saved to `~/.cache/huggingface/token` (chmod 600).

After that, the model is cached at `~/.cache/huggingface/hub/` and inference needs neither the token nor the network. The diarization supervisor reads the token from the cache file at launch, so `open MeetingNotes.app` works without going through `start.sh`.

## Packaging

`npm run dist` builds three artifacts:

1. **Swift helper** — `audio-tap/build/meeting-notes-tap`, codesigned with `com.apple.security.device.audio-input` entitlement.
2. **Sidecar PyInstaller bundle** — embeds Python + pyannote + torch into `sidecar/dist/meeting-notes-diarize/`. End users don't need Python installed. The supervisor prefers the source-tree `.venv` when present (fast dev iteration), otherwise spawns the bundled binary.
3. **`.app` via electron-builder** — ships the helper at `Contents/Resources/bin/meeting-notes-tap` and the sidecar bundle as `extraResources`, rebuilds `better-sqlite3` against Electron's ABI, produces `release/mac-arm64/MeetingNotes.app` plus `.dmg` and `.zip`.

```bash
npm run build:audio-tap              # just the Swift helper (~2 sec)
npm run sidecar:bundle               # just the Python bundle (~10 min, 1.5 GB)
npm run dist                         # everything + .app + DMG + ZIP
npx electron-builder --mac --dir     # faster rebuild for dev (.app only, no DMG)
```

## Development

```bash
npm run dev                # vite + electron with HMR
npm test                   # vitest
npm run lint
npm run build              # tsc main + tsc preload (CJS) + vite
```

`pretest` and `posttest` automatically rebuild `better-sqlite3` against the right runtime, so `npm test` (Node) and `npm run dev` (Electron) don't fight over the native binding.

### Source layout

```
audio-tap/            Swift CLI helper for CoreAudio Process Tap recording
  Sources/meeting-notes-tap/
  scripts/build.sh    swiftc + codesign with entitlements
  Info.plist          NSMicrophoneUsageDescription + NSAudioCaptureUsageDescription
electron/main/        main process: pipeline, storage, IPC, watcher, services
  recording/          RecordingManager, AppEnumerator, orphan-recovery
  permissions/        mic state probe via systemPreferences API
  meeting-detector/   browser-tab URL polling (Meet/Zoom/Teams/Whereby/etc.)
  pipeline/stages/    transcribing (stem-aware), diarizing, merging,
                      identifying, summarising, extracting
  lib/stem-paths.ts   voice/system stem path derivation + hasStems()
electron/preload/     preload bridge (CJS, IPC surface with parity test)
electron/renderer/    React UI
  components/         RecordButton, SourcePicker, LiveRecordingRow, VuMeter,
                      PermissionsModal, InboxRow, LibraryRow,
                      MeetingRowMenu, MeetingDetectedBanner
sidecar/              Python (pyannote) diarization sidecar, FastAPI on 8765
scripts/              setup.sh · start.sh · whisper-server.sh · doctor.sh
docs/                 manual smoke-test checklist + design specs + plans
```

## Security

- Electron sandbox locked down: `contextIsolation: true`, `nodeIntegration: false`. Preload compiled to CJS; exposes a typed API surface only.
- All IPC request payloads are zod-validated (stages, statuses, embedding length/finiteness, settings key whitelist).
- The Swift helper is a child of MeetingNotes.app, codesigned with audio-input entitlement; TCC attribution makes the user's grant scoped to MeetingNotes specifically.
- All SQLite calls use parameter binding via `better-sqlite3`. FKs + WAL enabled.
- HF token saved to `~/.cache/huggingface/token` with `chmod 600`.
- Diarization sidecar supervisor probes `/health` before spawning; detects `EADDRINUSE`; refuses to kill an externally-owned instance at shutdown.
- The recording helper auto-stops on parent-process death (kqueue watch on PPID), so an Electron crash can't leave an orphan recorder running indefinitely.

## Licence

MIT — see [LICENSE](LICENSE).

## Acknowledgements

- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — fast local Whisper inference
- [pyannote-audio](https://github.com/pyannote/pyannote-audio) — speaker diarization
- [LM Studio](https://lmstudio.ai) — local LLM runtime with an OpenAI-compatible API
- [AudioCap by @insidegui](https://github.com/insidegui/AudioCap) — Process Tap reference implementation that unblocked our audio capture work
