# Development and packaging

```bash
npm run dev            # vite + electron with HMR
npm test               # full suite under Electron's Node
npm run lint           # whole repository, zero warnings
npm run build          # tsc main + preload (CJS) + vite
npm run build:speech   # Apple/SpeakerKit Swift helper; Xcode 26+ SDK
npm run smoke:source   # build, then launch against a synthetic library
npm run screenshots    # refresh docs/screenshots (needs `npm run dev:renderer` running)
npm run dist           # capture + native speech + app + DMG/ZIP
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
  weekly/             Mon–Sun aggregator + narrative prompt
  pipeline/stages/    transcribing · diarizing · merging · identifying · summarizing · extracting
  storage/            SQLite repos + migrations
electron/preload/     CJS IPC bridge (with a parity test)
electron/renderer/    React UI (views/ · components/ · lib/ · store/)
scripts/              setup.sh · start.sh · rebuild.sh · doctor.sh
docs/                 url-scheme.md · exporters.md · google-setup.md · releases/ · smoke-test · specs
```

## Packaging & the packaged-app PATH

The app requires Apple silicon/macOS 26+. Source builds require Node 22, Xcode 26+ with the macOS 26 SDK, and FFmpeg/FFprobe. Run `brew install ffmpeg`, `./scripts/setup.sh`, then `npm start`. Setup builds both helpers and the app; it does not alter settings, download speech models, process meetings or package an installer. Prepare speech assets explicitly in the app.

`npm run dist` builds both helpers and Electron, then creates local DMG/ZIP files. There is no Python/PyInstaller environment, Whisper executable/model download or HF-token prerequisite. A clean generated `dist/` prevents removed provider modules from surviving incremental TypeScript builds. Only the capture helper, native speech helper and SDK/model notices are added as resources. macOS minimum is 26.0.

For versioned artifacts without overwriting rollback installers, run component builds and `npx electron-builder --mac --publish never --config.directories.output=release/v1.16.0`. Keep prior release artifacts. Remove only the task-owned unboxed app after verification to avoid LaunchServices duplicates. Existing Apple Development signing is not Developer ID distribution or notarization. Never install/restart a running app as part of building. GitHub releases publish source and notes without binary assets.

Native physical-device checks: `npm run speech:smoke`, then `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/speech-benchmark/integrated-smoke.mjs`. Prepare Apple assets explicitly first. The integrated check generates AAC speech in a disposable library, uses actual native inference through the full stable pipeline, confirms/trains a voice, saves notes/tasks with fixture LLM responses, and exports Markdown. It never opens private meetings. Synthetic results do not establish real-meeting accuracy or microphone capture quality.

The app icon uses a bright tile and bold indigo waveform/chat mark for visibility on dark backgrounds. `npm run build:icons` regenerates its macOS icon family and matching in-app logo from `build/icon-1024.png`.

Electron apps launched from Finder inherit a minimal PATH that excludes Homebrew, so the app resolves `ffmpeg`, `ffprobe`, `lms`, and `ollama` by searching well-known Homebrew paths — the `.dmg` behaves exactly like `npm run dev`. If a binary is missing, the error names the exact `brew install` to run.

Runtime tools: `./scripts/doctor.sh` (read-only health check) and `./scripts/start.sh --status` (read-only diagnostics). App logs: `~/Library/Logs/MeetingNotes/app.log`, surfaced in-app under **Settings → Advanced → Diagnostics**. Full isolated macOS verification uses [the shared Tart runner](../local-ci.md).

The doctor reads the stable settings database at `~/Documents/MeetingNotes/db.sqlite`, follows the configured library and active LLM provider, and never creates a missing database. For deliberate overrides, set `MEETINGNOTES_SETTINGS_DB`, `MEETINGNOTES_LIB`, `LM_STUDIO_URL`; explicit endpoint overrides take precedence over saved settings.
