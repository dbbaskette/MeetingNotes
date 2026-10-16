# Development and packaging

```bash
npm run dev            # vite + electron with HMR
npm test               # full suite under Electron's Node
npm run lint           # whole repository, zero warnings
npm run build          # tsc main + preload (CJS) + vite
npm run build:speech   # Apple/SpeakerKit Swift helper; Xcode 26+ SDK
npm run smoke:source   # build, then launch against a synthetic library
npm run screenshots    # refresh docs/screenshots (needs `npm run dev:renderer` running)
npm run dist           # capture + native speech + legacy sidecar + app + DMG/ZIP
```

> [!NOTE]
> `npm test` runs Vitest under Electron's own Node, so `better-sqlite3` is built once, for Electron, and tests never rebuild it. If a test reports a native-module version mismatch, run `npm run rebuild:electron`.

## Source layout

```
audio-tap/            Swift CLI helper — CoreAudio Process Tap recording (swiftc + codesign)
speech-engine/        Swift Apple transcription + pinned SpeakerKit OSS helper
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

`npm run dist` compiles the capture and native speech helpers, bundles the legacy Python sidecar with PyInstaller, builds Electron and produces `release/MeetingNotes-1.15.0-arm64.dmg` + `.zip`. The regular installer retains legacy fallback for macOS 14.2+; native speech requires Apple Silicon/macOS 26+. Native end users need no Python/Whisper/HF token. Full installer **builders** still need the sidecar build environment, Node dependencies and Xcode 26+ with the macOS 26+ SDK. SDK/model notices accompany the helper. GitHub releases intentionally publish source/notes without binary assets.

For native-only **source development**, use `brew install ffmpeg`, `./scripts/setup.sh --native`, then `npm start` (or `npm run dev`). This skips legacy sidecar, Whisper/HF setup and packaging, builds both Swift helpers and the app, and explicitly selects native speech. Quit the app before running setup against existing settings. Prepare language and speaker assets in the app; setup does not process meetings. Full packaging still includes the legacy fallback.

`scripts/rebuild.sh` also builds both helpers but removes previous top-level DMG/ZIP files. To retain installers, run component build steps and package with a version-specific output, e.g. `npx electron-builder --mac --publish never --config.directories.output=release/v1.15.0`. Existing development signing is not notarization or Developer ID distribution. Do not install/restart a running app as part of a build.

Native physical-device checks: `npm run speech:smoke`, then `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/speech-benchmark/integrated-smoke.mjs`. Prepare Apple assets explicitly first. The integrated check generates AAC speech in a disposable library, uses actual native inference through the full stable pipeline, confirms/trains a voice, saves notes/tasks with fixture LLM responses, and exports Markdown. It never opens private meetings. Synthetic results do not establish real-meeting accuracy or microphone capture quality.

The app icon uses a bright tile and bold indigo waveform/chat mark for visibility on dark backgrounds. `npm run build:icons` regenerates its macOS icon family and matching in-app logo from `build/icon-1024.png`.

Electron apps launched from Finder inherit a minimal PATH that excludes Homebrew, so the app resolves `ffmpeg`, `ffprobe`, `whisper-server`, `lms`, and `ollama` by searching well-known Homebrew paths — the `.dmg` behaves exactly like `npm run dev`. If a binary is missing, the error names the exact `brew install` to run.

Runtime tools: `./scripts/doctor.sh` (read-only health check) and `./scripts/start.sh --status` (what's running). App logs: `~/Library/Logs/MeetingNotes/app.log`, surfaced in-app under **Settings → Advanced → Diagnostics**. Full isolated macOS verification uses [the shared Tart runner](../local-ci.md).

The doctor reads the stable settings database at `~/Documents/MeetingNotes/db.sqlite`, follows the configured library and active LLM provider, and never creates a missing database. For deliberate overrides, set `MEETINGNOTES_SETTINGS_DB`, `MEETINGNOTES_LIB`, `STT_URL`, or `LM_STUDIO_URL`; explicit endpoint overrides take precedence over saved settings.
