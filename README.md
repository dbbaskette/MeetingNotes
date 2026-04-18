# MeetingNotes

Local-first meeting notes for macOS. Drop a recording from Audio Hijack into a watched folder, pick which ones to process, and MeetingNotes transcribes, diarizes, identifies speakers, summarises, and extracts action items — all on your machine. No cloud, no uploads, no API keys at inference time.

## Why

Meeting-transcription tools either ship your audio to a SaaS, lock you into their recorder, or only do half the job. MeetingNotes runs the whole pipeline locally:

- **Transcription** via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (Metal-accelerated on Apple Silicon)
- **Diarization** via [pyannote 3.1](https://github.com/pyannote/pyannote-audio) in a Python sidecar
- **Speaker identification** by matching voice embeddings against a roster you build over time
- **Summarisation + action items** via any chat LLM loaded in [LM Studio](https://lmstudio.ai)
- **Export** to Apple Reminders or Markdown

You bring the recorder ([Audio Hijack](https://rogueamoeba.com/audiohijack/), paid, recommended) and the models. MeetingNotes orchestrates everything else.

## Status

Alpha. Tested on macOS 14+ / Apple Silicon. 93 tests green. The pipeline is end-to-end functional, the UI is workable; rough edges in error-state polish and multi-meeting concurrency.

## Quick start

```bash
git clone https://github.com/dbbaskette/MeetingNotes.git
cd MeetingNotes

brew install whisper-cpp ffmpeg

# Single interactive setup: deps, sidecar venv, model, HF token, .app build.
./scripts/setup.sh

# One command to run everything.
./scripts/start.sh
```

`start.sh` launches the STT server, auto-opens LM Studio if installed, exports the HF token, health-checks the stack, and opens the packaged `.app`. Use `start.sh --dev` for hot-reload development.

## Catalog, then process

New in this build: MeetingNotes no longer auto-processes every MP3 it finds. The watcher catalogs files as **pending** and leaves them for you to trigger.

```
● 4 pending   ● 1 processing   ● 27 done          Process all pending →
```

Each card shows its state with a color-coded inset:

| State | Treatment | Action |
| --- | --- | --- |
| pending | amber left bar + `▶ Process` button | click to run one, or checkbox for bulk |
| processing | indigo shimmer + animated stage chip | — |
| done | muted, action-item count badge | click to open |
| failed | coral left bar + `↻ Retry` button | click to re-run from transcribe |

Hover any pending card to reveal a checkbox; select several and a sticky action bar rises from the bottom: `3 selected    [Cancel]  [▶ Process 3 meetings]`.

## How it works

```
Audio Hijack ──MP3──▶ ~/Music/Audio Hijack
                              │
                              ▼ chokidar watcher
                         status='pending'
                              │
                              ▼ user clicks Process
                       ┌──────────────┐
                       │  Pipeline    │
                       │              │
                       │  transcribe ─┼──▶ whisper-server (8080)
                       │  diarize ────┼──▶ pyannote sidecar (8765)
                       │  merge       │
                       │  identify ───┼──▶ speaker roster (cosine)
                       │  summarise ──┼──▶ LM Studio (1234)
                       │  extract ────┼──▶ LM Studio (1234)
                       └──────┬───────┘
                              ▼
                  ~/Documents/MeetingNotes/meetings/<slug>/
                    ├── audio.mp3 (symlink)
                    ├── transcript.md
                    ├── summary.md
                    └── meeting.json
```

Transcribing and diarizing run in parallel; the rest are sequential. Each meeting is one row in SQLite at `~/Documents/MeetingNotes/db.sqlite` and one folder under `meetings/`. Crash-safe: if the app dies mid-pipeline, recovery resumes `status='processing'` meetings on next launch; `status='failed'` waits for an explicit user retry.

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
./scripts/start.sh                  # production: STT server + LM Studio + .app
./scripts/start.sh --dev            # development: STT server + `npm run dev`
./scripts/start.sh --status         # what's running
./scripts/start.sh --stop           # stop STT server

./scripts/whisper-server.sh daemon  # start STT server in background
./scripts/whisper-server.sh status
./scripts/whisper-server.sh stop
./scripts/whisper-server.sh install # interactive model picker
./scripts/whisper-server.sh models  # list installed

./scripts/doctor.sh                 # read-only health check
```

Whisper-server logs: `~/Library/Logs/MeetingNotes/whisper-server.log`.
App logs: `~/Library/Logs/MeetingNotes/app.log`.

### `doctor.sh`

Checks binaries (node, python3, ffmpeg, whisper-server), filesystem (library dirs, Audio Hijack folder), sidecar (venv, HF token cache, HF model cache), services (whisper-server reachable, LM Studio reachable + loaded models, diarization sidecar), and native modules (better-sqlite3 loadability under Node).

## Configuration

Settings live in SQLite at `~/Documents/MeetingNotes/db.sqlite` (table `settings`). Edit in the app's Settings view, or via `setup.sh`, or directly:

| Key | Default | What it does |
| --- | --- | --- |
| `lmStudioUrl` | `http://localhost:1234` | chat/LLM endpoint |
| `sttUrl` | `http://127.0.0.1:8080` | whisper-server endpoint |
| `sttModel` | `whisper-1` | informational; actual model is whichever whisper-server started with |
| `llmModel` | `''` | model id for summarization/extraction (must be loaded in LM Studio) |
| `audioHijackSessionName` | `Meeting` | the AH session the app starts/stops via AppleScript |
| `libraryPath` | `~/Documents/MeetingNotes` | where meetings, db, and embeddings live |
| `audioWatchPath` | `~/Music/Audio Hijack` | folder watched for MP3 drops |
| `sttLanguage` | `en` | passed to Whisper |
| `exporterApple` | `true` | enable Apple Reminders exporter |
| `exporterMarkdown` | `true` | enable Markdown exporter |

### Hugging Face token

pyannote's diarization model is *gated* on Hugging Face. One-time setup:

1. Accept the license at https://huggingface.co/pyannote/speaker-diarization-3.1 (and `.../segmentation-3.0`).
2. Create a **fine-grained** token at https://huggingface.co/settings/tokens with scope "Read access to contents of all public gated repos you can access".
3. Paste it when `setup.sh` prompts. It's saved to `~/.cache/huggingface/token` (chmod 600).

After that, the model is cached at `~/.cache/huggingface/hub/` and inference needs neither the token nor the network.

## Packaging

`npm run dist` (or `setup.sh`'s last step) builds two artifacts:

1. **Sidecar PyInstaller bundle** — embeds Python + pyannote + torch into `sidecar/dist/meeting-notes-diarize/`. End users don't need Python installed. The supervisor prefers the source-tree `.venv` when present (fast dev iteration), otherwise spawns the bundled binary.
2. **`.app` via electron-builder** — ships the sidecar bundle as an `extraResource`, rebuilds `better-sqlite3` against Electron's ABI, produces `release/mac-arm64/MeetingNotes.app` plus a `.dmg` and `.zip`.

```bash
npm run sidecar:bundle              # just the Python bundle (~10 min, 1.5 GB)
npm run dist                        # bundle + .app + DMG + ZIP
npx electron-builder --mac --dir    # faster rebuild for dev (.app only, no DMG)
```

## Development

```bash
npm run dev                # vite + electron with HMR
npm test                   # vitest, 93 tests
npm run lint
npm run build              # tsc main + tsc preload (CJS) + vite
```

`pretest` and `posttest` automatically rebuild `better-sqlite3` against the right runtime, so `npm test` (Node) and `npm run dev` (Electron) don't fight over the native binding.

### Source layout

```
electron/main/        main process: pipeline, storage, IPC, watcher, services
electron/preload/     preload bridge (CJS, IPC surface with parity test)
electron/renderer/    React UI
sidecar/              Python (pyannote) diarization sidecar, FastAPI on 8765
  serve.py            PyInstaller entrypoint
  meeting_notes_diarize/
  scripts/
scripts/              setup.sh · start.sh · whisper-server.sh · doctor.sh
docs/                 manual smoke-test checklist and planning docs
```

## Security

- Electron sandbox locked down: `contextIsolation: true`, `nodeIntegration: false`. Preload compiled to CJS; exposes a typed API surface only.
- All IPC request payloads are zod-validated (stages, statuses, embedding length/finiteness, settings key whitelist).
- AppleScript strings escaped for both `\` and `"`; AH session name goes through a multi-line `tell` block, not one-liner interpolation.
- All SQLite calls use parameter binding via `better-sqlite3`. FKs + WAL enabled.
- HF token saved to `~/.cache/huggingface/token` with `chmod 600`.
- Diarization sidecar supervisor probes `/health` before spawning; detects `EADDRINUSE`; refuses to kill an externally-owned instance at shutdown.

## Licence

MIT — see [LICENSE](LICENSE).

## Acknowledgements

- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — fast local Whisper inference
- [pyannote-audio](https://github.com/pyannote/pyannote-audio) — speaker diarization
- [LM Studio](https://lmstudio.ai) — local LLM runtime with an OpenAI-compatible API
- [Audio Hijack](https://rogueamoeba.com/audiohijack/) — the recorder we orchestrate around
