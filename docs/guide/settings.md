# Settings and storage

Speech uses **Apple transcription + SpeakerKit**, set up under **Settings → Processing**. It is the only speech engine, including on upgrades. Apple silicon/macOS 26+ is required. The [comparison beta](speech-beta.md) is a separate development app with its own copied library; it never writes results or profiles back.

**Settings:** searchable Recording, Processing, Organization, Integrations, Storage, and Advanced sections keep routine controls separate from endpoints and diagnostics. Text saves when you leave a field, with visible save/error status. Storage paths use explicit Choose/Apply controls, require a restart, and do not relocate existing files. See [Settings and recovery guide](../usability-improvements.md).

| Section | What is in it |
| --- | --- |
| **Recording** | Meeting auto-detect, **When audio goes silent**, **Menu bar and shortcut**, Permissions |
| **Processing** | Native speech setup and **STT Language**, **Automatically match known voices**, **Generate notes before naming every voice**, **Process recordings automatically when capture finishes**, **Notes template by group**, **Summary detail level**, **Model thinking / reasoning effort** |
| **Organization** | **Dictionary**, **Appearance**, **Your name**, **You are…**, the **Speakers** roster |
| **Integrations** | **Obsidian sync**, **Webhook exporter**, **Google account** |
| **Storage** | **Library path**, storage locations, **Back up Library**, **Extra watch folder** |
| **Advanced** | **Summary provider (LLM lifecycle)**, **LM Studio URL**, **LLM Model**, context length, Diagnostics |

**Speakers:** **Settings → Organization → Speakers** lists everyone you have identified, ten at a time, with a **Find a speaker…** filter. Each row has rename, **Merge into…**, and **Voiceprints**. Expanding **Voiceprints** shows when the native voiceprint was last confirmed and from which source, and **Undo last voiceprint change** reverts the most recent change. Undo affects future voice matching only; names already assigned in meetings stay as they are.

**Secrets:** the webhook bearer token, the Google client secret and the Google refresh token are encrypted with the macOS keychain (Electron `safeStorage`) before they are written to the settings table. The window only ever receives a mask for a saved value. A secret cannot be saved while keychain encryption is unavailable.

**Settings → Storage → Back up Library** previews size and missing files, then creates a private local backup of the actual library and canonical settings databases, meeting audio (including external capture stems), notes, groups, speakers, and terminology. Model caches are excluded. Backup requires idle recording/processing/sync and protects writes while copying; checksummed manifests validate the result. A changed file inventory requires a fresh preview. Restore only into a new destination with the supplied script, never over a live Library. See [backup, privacy, restore, and rollback](../library-backup.md).

**Setup & health:** read-only readiness links to those sections; an explicitly confirmed disposable eight-second test verifies capture without adding a meeting. Processing includes explicit native asset preparation/cancel/retry. There is no speech-engine selector, Whisper management, custom STT endpoint or HF-token setup. LLM setup and capture permissions remain. See [capture, processing and delivery guide](../reliable-capture-processing.md).

**Native storage:** `<library>/voice-profiles/` holds model-tagged confirmed profiles, separate from legacy `<library>/speakers/embeddings/`. Verified public model files use `~/Library/Application Support/MeetingNotes/speech-models/<revision>/`; Apple language assets are managed by macOS. Neither upgrade nor setup bulk-reprocesses old meetings. Library backups include voice profiles; asset caches can be re-downloaded.

**Notes history:** the Notes tab's **Notes & action-item history…** compares and restores the latest 20 saved versions. Regeneration and re-extraction preserve existing notes/tasks before replacing them; restore includes completion status, ownership, due dates, and export markers while leaving the transcript/audio unchanged.

**Obsidian:** open **Settings → Integrations → Obsidian sync → Configure…**, select the root of an existing vault, then **Preview sync → Enable and sync**. MeetingNotes creates a dedicated `MeetingNotes/` folder with `Meetings.md`, a three-view `Meetings.base`, `Browse.md`, and canonical files in `Notes/`. Groups are properties, so moving a meeting between groups does not duplicate or move its note. Enable Obsidian's built-in Bases plugin for group/date views; the link-only index works without plugins. Startup resumes pending work; **Sync pending / retry failed** leaves unchanged exports alone. Use **Recheck all notes** for a full scan.

Sync is one-way and runs while MeetingNotes is open. Write annotations under **Personal notes**; edits to generated text, task checkboxes, or `mn_` properties pause that note until reviewed. **Configure…** shows progress, errors, comparison, retry, and backup-before-replace controls. Existing notes are retained when sync is disabled or the source meeting is removed. A vault's own cloud/Git sync may distribute exported content outside this Mac. See [setup, preservation, limits, and rollback](../obsidian-sync.md).

Settings live in SQLite (`~/Documents/MeetingNotes/db.sqlite`, table `settings`), in that location even when the Library path points elsewhere. Edit them in the app's **Settings** view. Rows for settings that no longer exist (for example `speechProvider`, `sttUrl` and `sttModel`) are ignored, not deleted.

## Full settings reference

Every key in the `Settings` interface ([`settings-repo.ts`](../../electron/main/storage/settings-repo.ts)), with its default. The last group is state the app keeps for itself; it has no control in Settings.

| Key | Default | What it does |
| --- | --- | --- |
| `summaryProvider` | `external` | LLM runtime: `lm-studio`, `ollama`, or `external`. Managed modes spawn the runtime, auto-load `llmModel`, and shut it down after 10 idle minutes. `external` = you run the server at `lmStudioUrl`. A healthy externally-started server is adopted (never killed) in any mode. |
| `lmStudioUrl` | `http://localhost:1234` | Chat/LLM endpoint (used only in `external` mode; managed modes use ports 1234 / 11434). |
| `llmModel` | `qwen/qwen3.5-9b` | Model id for notes and action-item extraction. Auto-loaded on first use in managed modes. |
| `llmContextLength` | `0` | Managed LM Studio context at the next model load: model default (0), 8192, 16384, or 32768. Larger contexts require more memory. A model already loaded with a smaller context is unloaded and reloaded with this one before the next LLM call. |
| `reasoningEffort` | `none` | **Model thinking / reasoning effort**: `none` (sends `enable_thinking: false` and `reasoning_effort: "none"`), `minimal`, `low`, or `default` (no override). |
| `disableThinking` | `true` | Older form of `reasoningEffort`, kept in step with it: `true` when the effort is `none`, `false` otherwise. |
| `summaryDetail` | `detailed` | Notes verbosity: `concise` / `standard` / `detailed`. |
| `sttLanguage` | `en` | Speech language. `en` selects en-US; Apple's API checks locale support. Prepare the assets again after changing it. Changes require idle processing/setup. |
| `autoProcessRecordings` | `false` | **Process recordings automatically when capture finishes.** Applies only to new built-in recordings with usable finalized audio, not imports or recovery. Queue pause and voice review still apply. |
| `autoMatchSpeakers` | `false` | **Automatically match known voices.** Applies strong native voiceprint matches on the next identification run; see [Working with meetings](meetings.md#optional-automatic-voice-matching). |
| `notesFirst` | `false` | **Generate notes before naming every voice.** Processing does not pause for unknown voices; notes use `SPEAKER_00`-style labels that are resolved when you name the voice later. |
| `libraryPath` | `~/Documents/MeetingNotes` | Recordings, meetings, the Library database, voice profiles. Changing it needs a restart and does not move existing files. |
| `audioWatchPath` | `""` | Optional extra folder watched for dropped audio. `<library>/recordings` and the legacy `~/Music/MeetingNotes` are always watched. |
| `theme` | `system` | UI appearance: `system` / `light` / `dark`. |
| `userName` | `""` | Your name, used to label your own voice in transcripts. Blank shows "You". |
| `userSpeakerId` | `null` | The roster speaker that represents you; pins your action items in Weekly and decides which items are "mine" for exports. Set via Settings → Organization → **You are…**. |
| `autoDetectMeetings` | `{browserTabs:false, nativeApps:false, silenceMs:5000}` | `browserTabs` polls the frontmost browser for meeting URLs; `nativeApps` polls CoreAudio for Zoom, Teams, FaceTime, Slack, Discord and WhatsApp producing audio; `silenceMs` is the sustained-audio threshold that filters out notification beeps. |
| `autoRecordZoom` | `false` | When the native detector fires for Zoom, skip the banner and record immediately. |
| `autoStopOnSilence` | `true` | Ask whether to stop when every audio source has gone silent, and stop if nobody answers. `false` = never ask and never stop a recording for silence. |
| `silencePromptAfterS` | `120` | Seconds of continuous silence before asking. Whole seconds, 30–1800. Doubles after each **Continue recording**, up to 30 minutes. |
| `silenceCountdownS` | `60` | Seconds the question waits before the recording is stopped and saved. Whole seconds, 10–600. |
| `showMenuBarIcon` | `true` | Show the macOS menu-bar item with recording time and start/stop controls. |
| `recordShortcut` | `""` | Global start/stop shortcut, as an Electron accelerator. Empty = none. Recorded under Settings → Recording → **Menu bar and shortcut**; a combination that cannot be registered is refused. |
| `obsidian` | `null` (off) | Vault, owned subfolder, content options, and sync state. Configure through the preview/confirmation flow, not generic settings writes. |
| `exporterWebhook` | `false` | Deliver each finished meeting to the webhook. |
| `webhookUrl` | `""` | Destination (HTTPS, or localhost). |
| `webhookSecret` | `""` | Optional bearer token. Keychain-encrypted; redacted from logs. |
| `webhookTemplate` | `compact` | `compact` / `full` (JSON), `slack-blocks`, `telegram-markdown`. |
| `webhookOwnerFilter` | `mine` | Which action items to include: `mine` (roster ID or normalized owner name) / `all` / `none`. |
| `googleClientId` | `""` | Your own Google OAuth desktop client ID for Tasks/Docs export. |
| `googleClientSecret` | `""` | That client's secret. Keychain-encrypted. |
| `webhookLastResult` | `null` | Time, HTTP status and error of the last webhook delivery, shown on the Webhook exporter card. |
| `googleAccountEmail` | `null` | Connected Google account, for display. `null` = not signed in. |
| `googleRefreshTokenEnc` | `null` | Google refresh token, keychain-encrypted. Never sent to the window. |
| `modelHealthChecks` | `{}` | Cached result of the model health check, per model id. |
| `onboardedAt` | `null` | When first-run setup was finished or skipped. `null` shows setup on the next launch. |
| `windowBounds` | `null` | Last window position and size, restored at launch when it is still on an attached display. |
