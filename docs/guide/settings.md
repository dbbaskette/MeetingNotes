# Settings and storage

**Settings:** searchable Recording, Processing, Organization, Integrations, Storage, and Advanced sections keep routine controls separate from endpoints and diagnostics. Text saves when you leave a field, with visible save/error status. Storage paths use explicit Choose/Apply controls, require a restart, and do not relocate existing files. See [Settings and recovery guide](../usability-improvements.md).

**Settings → Storage → Back up Library** previews size and missing files, then creates a private local backup of the actual library and canonical settings databases, meeting audio (including external capture stems), notes, groups, speakers, and terminology. Model caches are excluded. Backup requires idle recording/processing/sync and protects writes while copying; checksummed manifests validate the result. A changed file inventory requires a fresh preview. Restore only into a new destination with the supplied script, never over a live Library. See [backup, privacy, restore, and rollback](../library-backup.md).

**Setup & health:** read-only readiness links to those sections; an explicitly confirmed disposable eight-second test verifies capture without adding a meeting. Processing Settings includes the shared Whisper download/model picker; custom paths stay in Advanced. See [capture, processing and delivery guide](../reliable-capture-processing.md) for retry history, audio limitations and deferred hardware checks.

**Notes history:** the Notes tab's **Notes & action-item history…** compares and restores the latest 20 saved versions. Regeneration and re-extraction preserve existing notes/tasks before replacing them; restore includes completion status, ownership, due dates, and export markers while leaving the transcript/audio unchanged.

**Obsidian:** open **Settings → Integrations → Obsidian sync → Configure…**, select the root of an existing vault, then **Preview sync → Enable and sync**. MeetingNotes creates a dedicated `MeetingNotes/` folder with `Meetings.md`, a three-view `Meetings.base`, `Browse.md`, and canonical files in `Notes/`. Groups are properties, so moving a meeting between groups does not duplicate or move its note. Enable Obsidian's built-in Bases plugin for group/date views; the link-only index works without plugins. Startup resumes pending work; **Sync pending / retry failed** leaves unchanged exports alone. Use **Recheck all notes** for a full scan.

Sync is one-way and runs while MeetingNotes is open. Write annotations under **Personal notes**; edits to generated text, task checkboxes, or `mn_` properties pause that note until reviewed. **Configure…** shows progress, errors, comparison, retry, and backup-before-replace controls. Existing notes are retained when sync is disabled or the source meeting is removed. A vault's own cloud/Git sync may distribute exported content outside this Mac. See [setup, preservation, limits, and rollback](../obsidian-sync.md).

Settings live in SQLite (`~/Documents/MeetingNotes/db.sqlite`, table `settings`). Edit them in the app's **Settings** view or via `setup.sh`.

## Full settings reference

| Key | Default | What it does |
| --- | --- | --- |
| `summaryProvider` | `external` | LLM runtime: `lm-studio`, `ollama`, or `external`. Managed modes spawn the runtime, auto-load `llmModel`, and idle-shut-down. `external` = you run the server at `lmStudioUrl`. A healthy externally-started server is adopted (never killed) in any mode. |
| `lmStudioUrl` | `http://localhost:1234` | Chat/LLM endpoint (used only in `external` mode; managed modes hardcode 1234 / 11434). |
| `llmModel` | `qwen/qwen3.5-9b` | Model id for summarize/extract. Auto-loaded on first use. |
| `llmContextLength` | `0` | Managed LM Studio context at the next model load: model default (0), 8192, 16384, or 32768. Larger contexts require more memory; already-loaded models are not reloaded automatically. |
| `disableThinking` | `true` | Sends `enable_thinking: false` so reasoning models skip chain-of-thought where they honor it. |
| `summaryDetail` | `detailed` | Summary verbosity: `concise` / `standard` / `detailed`. |
| `sttUrl` | `http://127.0.0.1:8080` | whisper-server endpoint. Plain HTTP loopback URLs at the root path are managed locally on the configured port (HTTP without a port uses 80). Remote, HTTPS, or proxy endpoints are user-managed. Restart the app after changing this URL. |
| `sttModel` | `whisper-1` | Model file loaded when the app spawns whisper-server (`ggml-<name>.bin`); falls back to an auto-pick order if missing. |
| `sttLanguage` | `en` | Passed to Whisper. |
| `libraryPath` | `~/Documents/MeetingNotes` | Meetings, DB, embeddings. |
| `audioWatchPath` | `~/Music/MeetingNotes` | Folder watched for new recordings. |
| `recordingBitrateKbps` | `128` | AAC bitrate (96 / 128 / 192). |
| `theme` | `system` | UI appearance: `system` / `light` / `dark`. |
| `obsidian` | `null` (off) | Vault, owned subfolder, content options, and sync state. Configure through the preview/confirmation flow, not generic settings writes. |
| `userName` | `""` | Your name, substituted into transcripts after speaker-ID. |
| `userSpeakerId` | `null` | The roster speaker that represents you; pins your action items in Weekly. Set via Settings → "You are…". |
| `autoDetectMeetings` | `{browserTabs:false, nativeApps:false, silenceMs:5000}` | `browserTabs` polls the frontmost browser for meeting URLs; `nativeApps` polls CoreAudio for Zoom/Teams/Webex/FaceTime; `silenceMs` debounces beeps. |
| `autoRecordZoom` | `false` | When the native detector fires for Zoom, skip the banner and record immediately. |
| `exporterApple` / `exporterMarkdown` / `exporterWebhook` | `true` / `true` / `false` | Enable each exporter. |
| `webhookUrl` | `""` | Destination (HTTPS, or localhost). |
| `webhookSecret` | `""` | Optional bearer token; redacted from logs. |
| `webhookTemplate` | `compact` | `compact` / `full` (JSON), `slack-blocks`, `telegram-markdown`. |
| `webhookOwnerFilter` | `mine` | Which action items to include: `mine` (roster ID or normalized owner name) / `all` / `none`, for both manual and automatic delivery. |
| `googleClientId` / `googleClientSecret` | `""` | BYO Google OAuth desktop client for Tasks/Docs export. |
