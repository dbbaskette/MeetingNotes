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
npm run check:docs     # links, version badges, site/index.html and LICENSE checks
```

> [!NOTE]
> `npm test` runs Vitest under Electron's own Node, so `better-sqlite3` is built once, for Electron, and tests never rebuild it. If a test reports a native-module version mismatch, run `npm run rebuild:electron`.

## Source layout

```
audio-tap/              Swift CLI helper: Core Audio process-tap recording (swiftc + codesign)
speech-engine/          Swift helper: Apple transcription + pinned SpeakerKit OSS
electron/main/          main process (index.ts, menu.ts, splash.ts)
  recording/            RecordingManager, app enumerator, orphan recovery, recovery inbox, capture test, auto-process
  library/              folder watcher, catalog, ffprobe, dropped-file import, artifact cache
  pipeline/             stage runner, prompts, crash recovery, speech scheduling
    stages/             transcribing · diarizing · merging · identifying · summarizing · extracting
  speech/               native speech helper client, model download and verification, language selection
  speakers/             roster service, voice profiles, review metadata, sample extraction
  llm/                  managed LM Studio / Ollama lifecycle (supervisor)
  lm-studio/            OpenAI-compatible client (thinking strip, re-sample retries)
  ask/                  "Ask your meetings": passage index and answer service
  search/               ripgrep search, facets, owners
  weekly/               Mon–Sun aggregator, narrative prompt, recap, Markdown export
  terminology/          dictionary rules and transcript/notes corrections
  exporters/            apple-reminders · google-tasks · google-doc · markdown · pdf · webhook
  google/               OAuth sign-in and token handling for the Google exporters
  obsidian/             one-way vault sync: rendering, file safety, schema, service
  meeting-detector/     browser-tab URL polling + native-app detector
  menu-bar/             menu-bar item and the global record shortcut
  url-scheme/           meetingnotes:// parser and dispatcher
  permissions/          microphone and system-audio permission status
  ipc/                  channel contracts, argument schemas, handlers, backup guard
  storage/              SQLite repos, migrations, settings and secrets, notes history, trash, Library backup
  logging/              app log, log tail for Diagnostics, renderer error reports
  lib/                  shared pure helpers (paths, slugs, stage machine, ETA, window bounds)
  beta/                 entry point of the separate speech-comparison app (not packaged in MeetingNotes.app)
electron/preload/       CommonJS IPC bridge (index.ts, with a parity test; beta.ts for the comparison app)
electron/shared/        types and pure logic used by both main and renderer
electron/renderer/      React UI (index.html, csp.ts; beta.html for the comparison app)
  src/views/            Library, meeting detail and its panels, Actions, Weekly, Settings, Onboarding
  src/components/       shared components; motion/ holds the animated ones
  src/lib/              renderer logic and hooks
  src/store/            meetings and groups stores
  src/ipc/              typed client for the preload bridge
  src/theme/            design tokens
  src/dev/              in-browser stand-in for the preload bridge, used when the renderer runs without Electron
  src/beta/             UI of the comparison app
scripts/                setup.sh · start.sh · rebuild.sh · doctor.sh · restore-library-backup.ts · fixtures
  ci/                   Tart runner, smoke scripts, check-docs.mjs
  speech-benchmark/     native speech smoke tests and comparison tooling
build/                  icons, entitlements, afterPack trim script
site/                   GitHub Pages landing page (index.html)
macos-goldengate-skill/ the stack-neutral Golden Gate design skill
docs/                   guides, integration docs, release notes, specs and reviews (see docs/README.md)
```

## Packaging & the packaged-app PATH

The app requires Apple silicon/macOS 26+. Source builds require Node 22, Xcode 26+ with the macOS 26 SDK, and FFmpeg/FFprobe. Run `brew install ffmpeg`, `./scripts/setup.sh`, then `npm start`. Setup builds both helpers and the app; it does not alter settings, download speech models, process meetings or package an installer. Prepare speech assets explicitly in the app.

`npm run dist` builds both helpers and Electron, then creates local DMG/ZIP files. There is no Python/PyInstaller environment, Whisper executable/model download or Hugging Face token prerequisite. A clean generated `dist/` prevents removed provider modules from surviving incremental TypeScript builds. Only the capture helper, native speech helper and SDK/model notices are added as resources. The speech-comparison beta is built into `dist/` by the same build but is excluded from the packaged MeetingNotes.app; `npm run beta` runs it from source and `npm run dist:beta` packages it separately under `release/beta/`. macOS minimum is 26.0.

For versioned artifacts without overwriting rollback installers, run component builds and `npx electron-builder --mac --publish never --config.directories.output=release/v1.22.1`. Keep prior release artifacts. Remove only the task-owned unboxed app after verification to avoid LaunchServices duplicates. Existing Apple Development signing is not Developer ID distribution or notarization. Never install/restart a running app as part of building. GitHub releases publish source and notes without binary assets.

Main-process ESM output lives under `dist/electron`; the CommonJS preload compiler
uses the separate `dist/preload` tree with its own module boundary. Type-only
imports still cause TypeScript to emit shared files, so the two compilers must
never share an output directory. Every build imports the emitted shared modules
and Actions repository, and CI launches the built app against a disposable library.

Native physical-device checks: `npm run speech:smoke`, then `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/speech-benchmark/integrated-smoke.mjs`. Prepare Apple assets explicitly first. The integrated check generates AAC speech in a disposable library, uses actual native inference through the full stable pipeline, confirms/trains a voice, saves notes/tasks with fixture LLM responses, and exports Markdown. It never opens private meetings. Synthetic results do not establish real-meeting accuracy or microphone capture quality.

Optional WhisperKit engine: `npm run build && npm run build:speech`, then `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/speech-benchmark/whisperkit-smoke.mjs /absolute/folder`. It downloads the pinned 627 MB model into the folder you pass (never the app's own model folder), verifies every hash, loads the model, transcribes generated speech with and without a vocabulary, and merges the words with SpeakerKit turns. It needs the network and is not part of CI. `swift test --package-path speech-engine` covers the helper's word-timing, language and prompt logic without a model.

The app icon uses a bright tile and bold indigo waveform/chat mark for visibility on dark backgrounds. `npm run build:icons` regenerates its macOS icon family and matching in-app logo from `build/icon-1024.png`.

Electron apps launched from Finder inherit a minimal PATH that excludes Homebrew, so the app resolves `ffmpeg`, `ffprobe`, `lms`, and `ollama` by searching well-known Homebrew paths — the `.dmg` behaves exactly like `npm run dev`. If a binary is missing, the error names the exact `brew install` to run.

Runtime tools: `./scripts/doctor.sh` (read-only health check) and `./scripts/start.sh --status` (read-only diagnostics). App logs: `~/Library/Logs/MeetingNotes/app.log`, surfaced in-app under **Settings → Advanced → Diagnostics**. Full isolated macOS verification uses [the shared Tart runner](../local-ci.md).

The doctor reads the stable settings database at `~/Documents/MeetingNotes/db.sqlite`, follows the configured library and active LLM provider, and never creates a missing database. For deliberate overrides, set `MEETINGNOTES_SETTINGS_DB`, `MEETINGNOTES_LIB`, `LM_STUDIO_URL`; explicit endpoint overrides take precedence over saved settings.
