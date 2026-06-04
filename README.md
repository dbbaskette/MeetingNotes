# MeetingNotes

![MeetingNotes banner](docs/banner.png)

[![Platform](https://img.shields.io/badge/platform-macOS%2014.2%2B-blue)](https://support.apple.com/en-us/HT201260)
[![Architecture](https://img.shields.io/badge/arch-Apple%20Silicon-black)](https://support.apple.com/en-us/HT211814)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Status: 1.0](https://img.shields.io/badge/status-1.0-brightgreen)](#status)
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

- **Recording** via a bundled Swift CLI helper using macOS 14.2+ CoreAudio Process Tap (the API Apple introduced for exactly this) — captures any app's audio + mic into a mixed M4A, plus two sidecar stems (`.voice.m4a`, `.system.m4a`) written for future stem-aware processing
- **Meeting auto-detect** (opt-in) covers both browsers and native apps. The browser watcher polls your frontmost tab for known meeting URLs (Meet, Zoom web, Teams, Whereby, Jitsi, and others). The native-app watcher detects when **Zoom**, **Teams**, **Webex**, or **FaceTime** is hosting a live call and offers a one-click record — or auto-records if you flip the Zoom auto-record toggle in Settings
- **URL scheme** — `meetingnotes://record?source=zoom.us` and friends. Wire it into a Shortcut, an `osascript` line, a calendar hook, or Stream Deck to start recording from anywhere on the system
- **Transcription** via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (Metal-accelerated on Apple Silicon), run against the mixed file with a hallucination filter on top
- **Diarization** via [pyannote 3.1](https://github.com/pyannote/pyannote-audio) in a Python sidecar, on the same mixed file as transcription so timestamps align
- **Speaker identification** by matching voice embeddings against a roster you build over time
- **Summarisation + action items** via any chat LLM in [LM Studio](https://lmstudio.ai) or [Ollama](https://ollama.com), with a managed lifecycle: the app spawns the runtime, auto-loads the model, and shuts it down on idle. Reasoning models welcome — `<think>` blocks are stripped before rendering
- **Weekly view** rolls Mon–Sun meetings into a cached LLM-generated narrative (past weeks only — the current week's narrative is skipped because it would go stale within hours) with grouped open action items and key decisions, exportable to Markdown
- **Export** to Apple Reminders, Markdown (with a markdown editor + live preview built in), or any **HTTPS webhook** — POST a JSON payload to your own automations (n8n, Zapier, a Slack incoming webhook, your team's internal API) with full meeting metadata, summary, and action items. Built-in templates: compact JSON / full JSON / Slack blocks / Telegram markdown

You bring the models. MeetingNotes orchestrates everything else.

## Status

**1.0** — first stable release. Tested on macOS 14.2+ / Apple Silicon. End-to-end pipeline working: built-in recording → transcribe → diarize → speaker-ID gate → summarise → extract → export. The packaged `.dmg` runs the same pipeline as `npm run dev` (Homebrew-installed `ffmpeg`/`ffprobe`/`whisper-server` are resolved by absolute path, not by the minimal Finder PATH). Library refreshes instantly after Stop, browser + native-app meeting detection ship enabled-but-off, and webhook + URL-scheme exporters are first-class. The "All system audio" capture path remains experimental.

## Requirements

- **macOS 14.2 (Sonoma) or later** on Apple Silicon
- ~16 GB RAM minimum (whisper + a 9B LLM)
- An LLM runtime: either [LM Studio](https://lmstudio.ai) or [Ollama](https://ollama.com), with a chat model installed (default: `qwen/qwen3.5-9b`). The app manages the runtime lifecycle for you — it spawns and auto-loads the model on first summarise, and shuts down on idle.
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

`start.sh` exports the HF token, health-checks the stack, and opens the packaged `.app`. Use `start.sh --dev` for hot-reload development. **Whisper-server, the diarization sidecar, and the configured LLM runtime (LM Studio or Ollama) are spawned by the app itself on demand** (first transcription wakes whisper, first diarize wakes the sidecar, first summarise wakes the LLM and auto-loads the model) and shut down automatically after 10 minutes of inactivity to keep RAM low.

**First launch**: a four-step onboarding wizard walks you through macOS permissions, Whisper model install, Hugging Face token, and LLM runtime readiness — every step is skippable. macOS will prompt for two permissions on first record — microphone, then "Screen & System Audio Recording". Grant both; MeetingNotes will appear by name in System Settings → Privacy & Security. If you enable **Watch browser tabs for meeting URLs** in Settings, macOS will also prompt once per browser for Automation access.

## Recording a meeting

1. Click **⏺ Record** in the top right — or fire `meetingnotes://record?source=zoom.us` from a Shortcut / `osascript` / Stream Deck — or, with the meeting-detector enabled in Settings, let MeetingNotes catch it for you: the browser watcher pops an in-library banner when a known meeting URL opens in Chrome / Safari / Arc / Edge / Brave, the native-app watcher does the same when Zoom / Teams / Webex / FaceTime starts a call, and the Zoom auto-record toggle skips the banner entirely.
2. The source picker shows every app currently producing audio. Recognised meeting apps (Zoom, Teams, FaceTime, Slack, Discord, WhatsApp) appear first with a `MEETING` badge. Pick one — or `All system audio` as a catch-all.
3. A live recording row appears at the top of the library with elapsed time, VU meter, and a Stop button.
4. Click **■ Stop** when the meeting ends. The new row appears in your library the instant the file lands — no refresh, no tab-switch needed.
5. Click **▶ Process** to run it through the pipeline.

Each recording writes three files to `~/Music/MeetingNotes/`:

- `recording-<timestamp>-<id>.m4a` — mixed mic + tap, the primary file used by the pipeline (transcribe + diarize)
- `recording-<timestamp>-<id>.voice.m4a` — mic stem only (written for future stem-aware processing; not currently used by the pipeline)
- `recording-<timestamp>-<id>.system.m4a` — tap stem only (same)

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
                       │              │       (M4A → 16 kHz WAV via ffmpeg
                       │              │        once, reused by transcribe
                       │              │        and diarize; soxr resampler
                       │              │        when available)
                       │  transcribe ─┼──▶ whisper-server (8080)
                       │              │       (mixed file, hallucination
                       │              │        filter on output)
                       │  diarize ────┼──▶ pyannote sidecar (8765)
                       │              │       (same WAV as transcribe so
                       │              │        timestamps align)
                       │  merge       │
                       │  identify    │   (voice embeddings vs. roster)
                       │  ▼           │
                       │  awaiting_   │   ◀── pause: name unknown voices
                       │  speaker_id  │       (or check Skip for this meeting)
                       │  ▼           │
                       │  re-merge    │   ◀── transcript.md gets real names
                       │  summarise ──┼──▶ LM Studio (1234) or Ollama (11434)
                       │  extract ────┼──▶ LM Studio (1234) or Ollama (11434)
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

Summaries are structured into Overview, Key Discussion Points, Decisions, Action Items, Follow-ups, and Open Questions, with any sections that have nothing substantive skipped. The opening/closing social small talk (greetings, weekend plans, stock-market chatter, sign-offs) is pulled out of the main outline into a dedicated **Off-topic Conversation** section pinned to the end — it's moved there, not duplicated, so the business sections stay focused on the meeting itself. Summary verbosity is set once in Settings via a **detail level** (concise / standard / detailed) that pins the target length in the prompt rather than letting each local model drift.

### Weekly view

Switch to the **Week** tab for a Mon–Sun rollup: every meeting in the selected week, an LLM-generated narrative summarising what happened (past weeks only), all open action items grouped by owner, and key decisions extracted across the week. The narrative is cached in SQLite (`weekly_summaries` table, keyed by content hash) so re-opening the same week is instant — adding/editing/deleting any meeting in the week invalidates the cache automatically. **Export to Markdown** ships the whole rollup as one file (cancel = copies to clipboard).

For catching up, the rollup goes beyond the headline narrative. A **Themes** section synthesises 3–6 topic threads that run *across* the week's meetings — what was discussed, where it landed, what's still open — each with clickable chips back to its source meetings (the connective tissue you'd otherwise reconstruct by hand). The meetings list itself shows a multi-sentence recap pulled from each meeting's Overview, so it's scannable without opening every one. Themes ride on the same single LLM call as the narrative (no extra round-trip) and are cached alongside it.

Prev/next arrows step through weeks. The structured rollup (meetings list, action items, decisions) paints immediately; for past weeks the Overview card then shows a "drafting from N meetings… [elapsed]" skeleton while the LLM works.

**Current week is intentionally narrative-free.** The structured rollup updates live as new meetings finish processing, but the LLM Overview is gated until the week ends — generating it mid-week would burn 30+ seconds of GPU on a summary that goes stale within hours. The card shows a placeholder explaining this, and the Regenerate button is hidden.

To pin **your** open action items to a "You" group at the top, set Settings → "You are…" to the roster speaker that represents you. The dropdown is populated from speakers you've confirmed in any meeting's Speakers panel — confirm one as yourself first to make it appear.

### Integrations

- **[URL scheme](docs/url-scheme.md)** — `meetingnotes://record?source=zoom.us`, `…?source=ask`, `meetingnotes://stop`. Hook it up from a macOS Shortcut, an `osascript` line, a Stream Deck button, or a calendar-trigger like Hammerspoon to start / stop recordings from anywhere on the system without bringing the app forward.
- **[Webhook exporter](docs/exporters.md)** — when a meeting finishes, MeetingNotes POSTs a JSON payload to the URL you configure in Settings (HTTPS or localhost). Built-in templates for raw JSON (compact / full), Slack blocks, and Telegram markdown — or roll your own downstream in n8n / Zapier / your team's internal API. There's a **Send test payload** button so you can verify the round-trip without waiting for a real meeting.

### Search

`⌘K` (or `Ctrl+K`) anywhere opens a global search palette across titles, summaries, and transcript text. Click-through to the matching meeting.

### Click-to-play transcript

Timestamps in the transcript are clickable — they seek the sticky audio player to that moment and start playback. The player survives tab switches inside the meeting, so you can keep listening while editing the summary.

### Diagnostics & failure recovery

When a run fails, the meeting's detail view shows a **failure banner** with the actual error (e.g. `whisper: not ready…`) and the stage it died in, plus a one-click **Retry** that re-runs from the last safe checkpoint. **Settings → Diagnostics** surfaces the app log (`~/Library/Logs/MeetingNotes/app.log`) in-app with an Errors / Warnings+ / All filter and a "Reveal in Finder" button — no more digging through `~/Library/Logs` to find out what happened.

The managed services (whisper, the diarization sidecar, the LLM runtime) lazy-start on first use and idle-shut-down to free RAM. The whisper supervisor self-heals two cold-start failure modes that previously surfaced as `whisper: not ready within 120000ms`: a process that loads the model but never reports healthy is force-killed and respawned (two attempts), and a startup that races an in-flight idle shutdown now waits for the teardown to finish before respawning.

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
./scripts/start.sh                  # production: opens .app (auto-launches LM Studio if installed)
./scripts/start.sh --dev            # development: `npm run dev`
./scripts/start.sh --status         # what's running (whisper, sidecar, LM Studio reachability)
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

App logs: `~/Library/Logs/MeetingNotes/app.log` — includes interleaved whisper-server, pyannote sidecar, and LLM supervisor output, all tagged by source. Whisper-server logs (when run manually via `whisper-server.sh daemon`): `~/Library/Logs/MeetingNotes/whisper-server.log`.

### `doctor.sh`

Checks binaries (node, python3, ffmpeg, whisper-server), filesystem (library dirs, recordings folder), sidecar (venv, HF token cache, HF model cache), services (whisper-server reachable, LM Studio reachable + loaded models, diarization sidecar), and native modules (better-sqlite3 loadability under Node).

## Configuration

Settings live in SQLite at `~/Documents/MeetingNotes/db.sqlite` (table `settings`). Edit in the app's Settings view, or via `setup.sh`.

| Key | Default | What it does |
| --- | --- | --- |
| `summaryProvider` | `external` | LLM runtime: `lm-studio`, `ollama`, or `external`. With `lm-studio` or `ollama`, the app spawns the runtime, auto-loads `llmModel`, and idle-shuts-down after 10 min. With `external`, you manage the server yourself and it must be reachable at `lmStudioUrl`. The app adopts a healthy externally-started server in any mode (won't kill it on shutdown). |
| `lmStudioUrl` | `http://localhost:1234` | chat/LLM endpoint, only used when `summaryProvider` is `external`. The `lm-studio` and `ollama` modes hardcode their canonical ports (1234 / 11434) instead. |
| `llmModel` | `qwen/qwen3.5-9b` | model id for summarisation/extraction. Auto-loaded into the runtime on first use. |
| `sttUrl` | `http://127.0.0.1:8080` | whisper-server endpoint |
| `sttModel` | `whisper-1` | model file to load when the app spawns whisper-server. Resolved against `~/Library/Application Support/MeetingNotes/whisper-models/ggml-<name>.bin`. If the named model isn't installed, falls back to the auto-pick preference order (medium.en → small.en → large-v3-turbo → ...). |
| `libraryPath` | `~/Documents/MeetingNotes` | meetings, db, embeddings |
| `audioWatchPath` | `~/Music/MeetingNotes` | folder watched for new recordings (also watches `~/Music/Audio Hijack` for one release as a legacy fallback) |
| `recordingBitrateKbps` | `128` | AAC bitrate for new recordings (96 / 128 / 192) |
| `sttLanguage` | `en` | passed to Whisper |
| `userName` | `""` | your name — substituted for `VOICE_YOU` in transcripts after speaker-ID (empty falls back to the literal "You") |
| `userSpeakerId` | `null` | the roster speaker that represents you. When set, the Weekly view pins your own open action items to a "You" group at the top. Picker in Settings → "You are…" — populated by speakers you've confirmed in any meeting's Speakers panel. |
| `autoDetectMeetings` | `{browserTabs: false, nativeApps: false, silenceMs: 1500}` | Object. `browserTabs` polls your frontmost browser for known meeting URLs (Automation prompt per browser on first run). `nativeApps` polls CoreAudio for Zoom / Teams / Webex / FaceTime hosting a live call, with `silenceMs` debounce so notification beeps don't trip it |
| `autoRecordZoom` | `false` | when the native-app detector fires for Zoom (`us.zoom.xos`), skip the banner and start recording immediately. Other apps still go through the banner |
| `onboardedAt` | unset | timestamp the first-run wizard was completed or skipped |
| `exporterApple` | `true` | enable Apple Reminders exporter |
| `exporterMarkdown` | `true` | enable Markdown exporter |
| `exporterWebhook` | `false` | enable the HTTPS webhook exporter — POST `meeting.completed` payloads to `webhookUrl` when the pipeline finishes |
| `webhookUrl` | `""` | destination endpoint. Must be HTTPS unless it's a localhost address |
| `webhookSecret` | `""` | optional bearer token. Sent as `Authorization: Bearer <secret>`. Redacted from logs and the "Send test" preview |
| `webhookTemplate` | `compact` | payload shape — `compact` / `full` are JSON; `telegram-markdown` and `slack-blocks` flatten for those platforms |
| `webhookOwnerFilter` | `all` | which action items to include — `mine` (filter by `userSpeakerId`), `all`, or `none` (summary only) |

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

`./scripts/rebuild.sh` is the one-command build — compiles the Swift helper, bundles the Python sidecar, builds the Electron app, and produces an installable `.dmg` + `.zip`:

```bash
./scripts/rebuild.sh                  # full rebuild (~10 min): audio-tap + sidecar + app + .dmg
./scripts/rebuild.sh --skip-sidecar   # skip the slow PyInstaller step
./scripts/rebuild.sh --skip-audio-tap # skip the Swift helper
./scripts/rebuild.sh --app-only       # both flags above — just the Electron app + packaging (~9 min)

open release/MeetingNotes-1.0.1-arm64.dmg   # install the result
```

Three artifacts get compiled:

1. **Swift helper** — `audio-tap/build/meeting-notes-tap`, codesigned with `com.apple.security.device.audio-input` entitlement.
2. **Sidecar PyInstaller bundle** — embeds Python + pyannote + torch into `sidecar/dist/meeting-notes-diarize/`. End users don't need Python installed. The supervisor prefers the source-tree `.venv` when present (fast dev iteration), otherwise spawns the bundled binary.
3. **`.app` via electron-builder** — ships the helper at `Contents/Resources/bin/meeting-notes-tap` and the sidecar bundle as `extraResources`, rebuilds `better-sqlite3` against Electron's ABI, produces `.dmg` and `.zip` under `release/`.

Individual build commands:

```bash
npm run build:audio-tap              # just the Swift helper (~2 sec)
npm run sidecar:bundle               # just the Python bundle (~10 min, 1.5 GB)
npm run dist                         # everything + .app + DMG + ZIP (npm script equivalent)
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
  meeting-detector/   browser-tab URL polling + native-app detector
                      (Zoom/Teams/Webex/FaceTime via CoreAudio probe)
  url-scheme/         `meetingnotes://record` / `meetingnotes://stop` handler
                      (registered via electron-builder protocols)
  exporters/          apple reminders + markdown + webhook (#79) + templates
  llm/                managed lifecycle for LM Studio / Ollama runtimes
                      (spawn, model auto-load, idle shutdown)
  whisper/            whisper-server supervisor (lazy spawn, /health probe)
  diarization/        pyannote sidecar supervisor + HTTP client
  weekly/             aggregator + LLM prompt for the Mon–Sun rollup
  pipeline/stages/    transcribing, diarizing, merging, identifying,
                      summarising, extracting
  lib/find-ffmpeg.ts  resolves ffmpeg/ffprobe absolute paths so the
                      packaged .app works without relying on shell PATH
  lib/stem-paths.ts   voice/system stem path derivation + hasStems()
  lib/managed-service.ts
                      shared service lifecycle: lazy spawn, health probe,
                      idle shutdown, adopt-existing-daemon, restart budget
electron/preload/     preload bridge (CJS, IPC surface with parity test)
electron/renderer/    React UI
  views/              MeetingDetailView, WeeklyView, OnboardingView, ...
  components/         RecordButton, SourcePicker, LiveRecordingRow, VuMeter,
                      PermissionsModal, InboxRow, LibraryRow, SearchPalette,
                      MeetingRowMenu, MeetingDetectedBanner
sidecar/              Python (pyannote) diarization sidecar, FastAPI on 8765
scripts/              setup.sh · start.sh · rebuild.sh · whisper-server.sh · doctor.sh
docs/                 manual smoke-test checklist + design specs + plans
```

## Packaged-app considerations

Electron apps launched from Finder inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that excludes Homebrew. The app resolves `ffmpeg`, `ffprobe`, `whisper-server`, `lms`, and `ollama` by searching well-known Homebrew install paths (`/opt/homebrew/bin`, `/usr/local/bin`) so that the `.dmg` works the same as `npm run dev`. If a binary isn't found, the error message tells you the exact `brew install` command.

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
- [Ollama](https://ollama.com) — local LLM runtime with auto-managed model loading
- [AudioCap by @insidegui](https://github.com/insidegui/AudioCap) — Process Tap reference implementation that unblocked our audio capture work
