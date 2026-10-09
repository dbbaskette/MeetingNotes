# Development and packaging

```bash
npm run dev            # vite + electron with HMR
npm test               # full suite under Electron's Node
npm run lint           # whole repository, zero warnings
npm run build          # tsc main + preload (CJS) + vite
npm run smoke:source   # build, then launch against a synthetic library
npm run screenshots    # refresh docs/screenshots (needs `npm run dev:renderer` running)
npm run dist           # full installer: audio-tap + sidecar + app + .dmg + .zip
```

> [!NOTE]
> `npm test` runs Vitest under Electron's own Node, so `better-sqlite3` is built once, for Electron, and tests never rebuild it. If a test reports a native-module version mismatch, run `npm run rebuild:electron`.

## Source layout

```
audio-tap/            Swift CLI helper — CoreAudio Process Tap recording (swiftc + codesign)
electron/main/        main process: pipeline, storage, IPC, watcher, services
  recording/          RecordingManager, AppEnumerator, orphan-recovery, recovery inbox
  library/            watcher, catalog service, ffprobe
  meeting-detector/   browser-tab URL polling + native-app detector
  url-scheme/         meetingnotes:// handler
  exporters/          apple-reminders · google-tasks · google-doc · markdown · pdf · webhook
  llm/                managed LM Studio / Ollama lifecycle
  lm-studio/          OpenAI-compatible client (thinking-strip, re-sample retries)
  whisper/            whisper-server supervisor (lazy spawn, /health probe)
  diarization/        pyannote sidecar supervisor + HTTP client
  weekly/             Mon–Sun aggregator + narrative prompt
  pipeline/stages/    transcribing · diarizing · merging · identifying · summarizing · extracting
  storage/            SQLite repos + migrations
electron/preload/     CJS IPC bridge (with a parity test)
electron/renderer/    React UI (views/ · components/ · lib/ · store/)
sidecar/              Python pyannote diarization sidecar, FastAPI :8765
scripts/              setup.sh · start.sh · rebuild.sh · whisper-server.sh · doctor.sh
docs/                 url-scheme.md · exporters.md · google-setup.md · releases/ · smoke-test · specs
```

## Packaging & the packaged-app PATH

`./scripts/rebuild.sh` (or `npm run dist`) compiles and signs the Swift helper, bundles the Python sidecar with PyInstaller (so end users don't need Python), builds the Electron app, rebuilds `better-sqlite3` against Electron's ABI, and produces `release/MeetingNotes-1.14.9-arm64.dmg` + `.zip` on Apple Silicon. GitHub source releases may intentionally omit these binary assets; build locally when you need an installer. `scripts/rebuild.sh` removes previous DMG/ZIP files; to keep them, run the component build steps and package with a version-specific output directory, for example `npx electron-builder --mac --config.directories.output=release/v1.14.9`.

The app icon uses a bright tile and bold indigo waveform/chat mark for visibility on dark backgrounds. `npm run build:icons` regenerates its macOS icon family and matching in-app logo from `build/icon-1024.png`.

Electron apps launched from Finder inherit a minimal PATH that excludes Homebrew, so the app resolves `ffmpeg`, `ffprobe`, `whisper-server`, `lms`, and `ollama` by searching well-known Homebrew paths — the `.dmg` behaves exactly like `npm run dev`. If a binary is missing, the error names the exact `brew install` to run.

Runtime tools: `./scripts/doctor.sh` (read-only health check) and `./scripts/start.sh --status` (what's running). App logs: `~/Library/Logs/MeetingNotes/app.log`, surfaced in-app under **Settings → Advanced → Diagnostics**. Full isolated macOS verification uses [the shared Tart runner](../local-ci.md).

The doctor reads the stable settings database at `~/Documents/MeetingNotes/db.sqlite`, follows the configured library and active LLM provider, and never creates a missing database. For deliberate overrides, set `MEETINGNOTES_SETTINGS_DB`, `MEETINGNOTES_LIB`, `STT_URL`, or `LM_STUDIO_URL`; explicit endpoint overrides take precedence over saved settings.
