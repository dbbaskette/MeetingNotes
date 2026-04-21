# Built-in Audio Capture (Replace Audio Hijack)

**Status:** Design approved 2026-04-20. Ready for implementation planning.
**Tracks:** GitHub issue #3.
**Replaces:** `electron/main/audio-hijack/bridge.ts` and the user's manual Audio Hijack setup.

## Goal

A new MeetingNotes user installs the `.app`, grants two macOS permissions, hits Record, and ends up with an M4A in the library — no Audio Hijack, no BlackHole, no Multi-Output Device, no third-party install of any kind.

## Non-goals

- Stereo capture, channel-as-diarization-prior. Worthwhile but separate.
- Per-tab browser capture. macOS audio APIs don't support it; we fall back to system-audio for browser meetings.
- ScreenCaptureKit fallback for macOS 13.x. Hard floor at 14.2.
- BlackHole-as-fallback. Defeats the whole point.
- Auto-process on stop. Inbox stays as the deliberate gate.
- Real-time transcription during recording.

## Constraints

- **macOS 14.2+ only** (CoreAudio Process Tap API requirement). App refuses to launch the recorder on older macOS with a clear "macOS 14.2 or later required" message.
- Apple Silicon only (already a project constraint).
- The new helper binary is arm64-only (matching the project's existing Apple-Silicon-only constraint), codesigned with the same identity as the Electron app, with the audio-capture entitlement.

## Architecture

```
┌──────────────────────┐    spawn (start)     ┌──────────────────────────┐
│  Electron main proc  │ ───────────────────► │  meeting-notes-tap       │
│                      │                       │  (Swift CLI helper)      │
│  - RecordingManager  │ ◄───── stdout ─────── │                          │
│    (lifecycle, PIDs) │   {"level":-23,...}   │  - CoreAudio Process Tap │
│  - LibraryWatcher    │                       │  - AVAudioEngine.input   │
│    (existing)        │      SIGTERM          │  - Mono mix              │
│                      │ ───────────────────► │  - AAC encode → .m4a     │
└──────────────────────┘    (stop)             └──────────────────────────┘
                                                           │
                                                           ▼
                                              ~/Music/MeetingNotes/
                                              <slug>-YYYYMMDD-HHMM.m4a
                                                           │
                                              (LibraryWatcher detects)
                                                           │
                                                           ▼
                                                Inbox row → Process
```

Helper is a single-purpose Swift CLI. Spawned per recording, killed by SIGTERM on Stop. No long-running daemon. No supervisor. No respawn logic.

## Components

### 1. `meeting-notes-tap` (new Swift binary)

Location in source: `audio-tap/` (new top-level directory, sibling to `sidecar/`).
Bundled into `.app` at `Contents/Resources/bin/meeting-notes-tap`.

**CLI:**

```
meeting-notes-tap --pid <target-pid> --mic --out <path-to-output.m4a>
                  [--system-audio]      # tap whole system instead of one PID
                  [--no-mic]            # don't capture mic (rare)
                  [--idle-stop-seconds N]  # auto-stop after N seconds of silence (default: 14400 = 4h safety)
```

**Behavior:**

- Attaches a CoreAudio Process Tap to the target PID (or system-wide aggregate device if `--system-audio`).
- Opens microphone input via `AVAudioEngine.inputNode`.
- Mixes both sources to a single mono channel.
- Encodes mono audio to AAC inside an M4A container, streamed to `--out` as it captures.
- Writes JSON status events to stdout, one per line:
  - `{"event":"started"}` immediately after Core Audio attaches successfully.
  - `{"event":"level","peak_db":-23.4}` ~10 Hz for VU meter.
  - `{"event":"stopped","bytes":18405632,"duration_s":847.3}` on clean exit.
  - `{"event":"error","message":"..."}` on fatal error.
- Writes structured errors to stderr (one line, prefixed `ERR `).
- Watches parent PID. If parent dies, finalizes the M4A and exits 0 (orphan recovery covered below).
- Auto-stops if it sees `--idle-stop-seconds` of silence (default 4 hours) — prevents an orphaned helper from running forever after a kernel panic.
- Exits 0 on clean stop (SIGTERM, parent-death, idle), non-zero with an `ERR` line on failure.

**Build:** swiftc with `-target arm64-apple-macos14.2`. Driven from a new `audio-tap/scripts/build.sh`. Wired into `electron-builder` so `npm run dist` produces an `.app` containing the helper at `Contents/Resources/bin/meeting-notes-tap`.

### 2. `RecordingManager` (new TypeScript class)

Location: `electron/main/recording/manager.ts` (new directory).
Replaces all uses of `AudioHijackBridge`.

**Responsibilities:**

- Spawns the helper with the chosen PID and output path.
- Tracks recording state per session: `idle | starting | recording | stopping | error`.
- Parses helper stdout JSON events; forwards `level` events to renderer at 10 Hz; surfaces `started` / `stopped` for UI state transitions.
- On Stop: sends SIGTERM, awaits clean exit (with a 5-second hard-kill fallback).
- On unexpected helper exit while recording: marks state `error`, surfaces last stderr line to UI.
- Records the in-flight output path in `recording_sessions` table (see migration below) so orphan recovery can find it.

**Public API (consumed by IPC handlers):**

```ts
class RecordingManager {
  start(opts: { targetPid: number | 'system'; mic: boolean; titleHint?: string }): Promise<{ sessionId: string }>;
  stop(sessionId: string): Promise<{ outputPath: string; durationS: number }>;
  state(sessionId: string): RecordingState;
  // Emits: 'level' (per session), 'state-change' (per session)
  on(event: 'level', cb: (sessionId: string, peakDb: number) => void): void;
  on(event: 'state-change', cb: (sessionId: string, state: RecordingState) => void): void;
  // Called once at app launch:
  recoverOrphans(): Promise<void>;
}
```

### 3. `AppEnumerator` (new)

Location: `electron/main/recording/app-enumerator.ts`.

Lists currently-running audio-producing processes by querying CoreAudio's process list (`kAudioHardwarePropertyTranslatePIDToProcessObject` + iteration). Implementation route: a tiny additional Swift command (`meeting-notes-tap --list-audio-processes`) that prints JSON, called when the source picker opens. Avoids a second binary while keeping all CoreAudio code in one place.

Output:

```json
[
  {"pid": 12345, "bundle_id": "us.zoom.xos", "name": "Zoom", "is_meeting_app": true},
  {"pid": 23456, "bundle_id": "com.microsoft.teams2", "name": "Microsoft Teams", "is_meeting_app": true},
  {"pid": 34567, "bundle_id": "com.google.Chrome", "name": "Google Chrome", "is_meeting_app": false}
]
```

`is_meeting_app` is a hardcoded allowlist of bundle IDs (Zoom, Teams, FaceTime, Slack, Discord, WhatsApp). Renderer surfaces meeting apps first, then "Chrome / browser meetings" as a recognized fallback, then "All system audio."

### 4. Permissions probe

Location: `electron/main/permissions/audio.ts` (new).

**Two checks:**

- Microphone: `systemPreferences.getMediaAccessStatus('microphone')` (built-in Electron API).
- Audio Capture (Process Tap): no built-in Electron check — perform a probe by spawning the helper with a `--probe-permissions` flag that returns JSON with a verdict (`granted` / `denied` / `not-determined`) without actually starting a recording.

**First-launch flow:** if either permission is missing, show a one-screen explainer modal with two "Grant" buttons. Each opens System Settings via deep link:

- Microphone: `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`
- Audio capture: TBD on first run — Apple's URL for the Audio Capture pane is undocumented. Acceptable fallback: open the top-level Privacy & Security pane, instruct the user where to scroll.

After both grants, the modal dismisses. If the user closes the modal without granting, recording is disabled (Record button shows disabled state with explainer tooltip) until granted.

`SettingsView` gains a "Permissions" section showing current state for both, with a "Recheck" button.

### 5. UI changes

**`RecordButton`:**
- On click, opens a small floating source picker (anchored under the button) populated from `AppEnumerator`.
- Auto-selects the lone audio-producing meeting app if exactly one is running.
- Picker has a "Use system audio (catch all)" option always present.
- After selection, button transitions to "Recording 0:03 ▆▅▆▇▆ ■ Stop" with live elapsed timer + simple VU meter from `level` events.

**`LibraryView`:**
- A `LiveRecordingRow` appears at the top of the library while a session is active. Shows: source app name, elapsed time, VU meter, Stop button. Distinct visual from regular library rows (red dot, indigo gradient border).
- On Stop, the row disappears and the file shows up in Inbox once `LibraryWatcher` ingests it.

**`SettingsView`:**
- Removes "Audio Hijack Session Name" field.
- Renames "Watch path" → "Recordings folder," default `~/Music/MeetingNotes`.
- Adds "Permissions" section with Mic + Audio Capture state + "Recheck" button.
- Adds "Recording quality" section: AAC bitrate dropdown (96 / 128 / 192 kbps, default 128). Mono is hardcoded.

### 6. `LibraryWatcher`

One-line change: filter accepts `\.(mp3|m4a)$` instead of `\.mp3$`. Watch path defaults to `~/Music/MeetingNotes` but the old `~/Music/Audio Hijack` path is also watched for one release so existing AH users don't lose ingest of mid-flight recordings.

### 7. Storage

**Migration v6:**
```sql
-- Track in-flight recordings so we can recover orphans on next launch.
CREATE TABLE IF NOT EXISTS recording_sessions (
  id TEXT PRIMARY KEY,
  helper_pid INTEGER NOT NULL,
  target_pid INTEGER,                -- NULL when system-audio
  target_label TEXT NOT NULL,        -- "Zoom", "All system audio"
  output_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finalized_at TEXT,                 -- NULL until helper exits cleanly
  status TEXT NOT NULL               -- recording | finalized | orphaned | error
);

-- Drop the old setting; preload still defaults it to 'Meeting' for backcompat
-- but the value is no longer read.
-- (No SQL action — settings table is key/value, the dead key is harmless.)
```

`audioHijackSessionName` setting key is left in the DB but no longer consumed; the new `RecordingManager` ignores it. A future migration can clean up.

### 8. `AudioHijackBridge` removal

`electron/main/audio-hijack/bridge.ts` and its test deleted. All call sites switch to `RecordingManager`. The `record:start`, `record:stop`, `record:state` IPC channels keep their names but get new payloads (target PID, session ID, level events).

## Data flow on Record click

1. User clicks Record. Renderer calls `api.recording.listSources()` → opens picker.
2. User picks Zoom. Renderer calls `api.recording.start({ targetPid: 12345, mic: true })`.
3. `RecordingManager.start`:
   - Allocates `sessionId = ulid()`.
   - Computes output path: `~/Music/MeetingNotes/recording-20260420-1923-<sessionId>.m4a`.
   - Inserts `recording_sessions` row with `status='recording'`.
   - Spawns `meeting-notes-tap --pid 12345 --mic --out <path>`.
   - Resolves the start promise on `{"event":"started"}`.
4. Renderer receives `{ sessionId }`, swaps `RecordButton` for live recording state.
5. `LiveRecordingRow` appears in library, ticking elapsed timer + VU meter from `level` events.
6. User clicks Stop. Renderer calls `api.recording.stop({ sessionId })`.
7. `RecordingManager` sends SIGTERM to helper. Helper flushes encoder (~50ms), writes file, emits `{"event":"stopped"}`, exits 0.
8. `RecordingManager` updates `recording_sessions.status='finalized'`, `finalized_at=now`.
9. `LibraryWatcher` (chokidar, debounced 500ms) detects the new `.m4a` and creates a meeting row in Inbox.
10. User clicks Process. From here, existing pipeline.

## Lifecycle edge cases

| Scenario | Behavior |
|----------|----------|
| Normal Stop | SIGTERM → flush → file in Inbox. |
| Quit MeetingNotes mid-recording | App-quit handler sends SIGTERM to all active helpers, awaits up to 5s. Files finalize. |
| MeetingNotes crashes mid-recording | Helper sees parent-death (PID watch via `kqueue`), finalizes its own file, exits. On next MeetingNotes launch, `RecordingManager.recoverOrphans()` scans `recording_sessions` for `status='recording'`, checks if the output file is a valid M4A (via probe), marks `status='finalized'` or `status='orphaned'`. Either way the file is in `~/Music/MeetingNotes` and gets ingested by `LibraryWatcher`. |
| Helper crashes mid-recording | `RecordingManager` notices the unexpected exit, marks session `status='error'`, surfaces last stderr line in a UI toast. Partial file may be salvageable; the orphan-recovery probe attempts to repair it. |
| Target app quits mid-recording | Helper detects `kAudioObjectPropertyOwnedObjects` change (process gone), gracefully stops, finalizes, exits 0. Saved file shows up in Inbox. |
| macOS sleep / lid close | Process tap pauses; on wake it resumes. Mic input may have a brief gap. Acceptable. |
| Idle for >4 hours (silence-only) | Helper auto-stops via `--idle-stop-seconds`. Safety net for orphans the parent-watch missed. |

## Risks / unknowns to verify during implementation

1. **Process Tap permission UX is new** — Apple's prompt copy and the deep-link URL for Audio Capture in System Settings are undocumented at design time. Workaround: probe-via-helper for state; fall back to opening the top-level Privacy pane if no specific URL works.
2. **Browser process trees** — Chrome's audio process is distinct from the main browser process. May need to tap all Chrome PIDs or fall back to system-audio for browser meetings. Implementation will pick the simpler of the two after testing.
3. **Codesigning entitlements** — exact entitlement keys for the audio-capture helper need confirmation from Apple's docs at implementation time. Likely involves `com.apple.security.device.audio-input` plus a Process Tap-specific entitlement.
4. **Orphan recovery file integrity** — if the helper dies hard (SIGKILL, kernel panic), the M4A's `mdat` box may be unfinalized. Need a probe step (AVAsset load test) and possibly an `ffmpeg`-based repair before marking the file ingestable.
5. **Universal binary build pipeline** — adds Xcode/swiftc steps to electron-builder. New territory for this codebase.
6. **Migration story for existing users** — the old `~/Music/Audio Hijack` folder still works (LibraryWatcher watches both paths for one release). After that release lands, drop the dual-watch.
7. **Bundle ID allowlist drift** — new meeting apps (or Zoom changing its bundle ID) require list updates. Acceptable: the list only affects sort order in the picker; an unknown app still appears in the "All running audio apps" tail.

## Testing strategy

- **Unit tests** for `RecordingManager` against a fake helper-process runner (already a pattern in `audio-hijack/bridge.test.ts`).
- **Unit tests** for `AppEnumerator` parsing of the helper's `--list-audio-processes` JSON.
- **Unit tests** for orphan-recovery logic (DB scan + file probe), with fixture M4A files in good and corrupt states.
- **Manual smoke test checklist** (in `docs/manual-smoke-test.md`):
  - Record from Zoom, verify M4A in `~/Music/MeetingNotes`, plays back with both sides audible.
  - Record from a browser Meet call, same.
  - Record system audio (no app picked), same.
  - Quit app mid-recording, verify file is finalized and shows in Inbox on relaunch.
  - Force-kill app (SIGKILL) mid-recording, verify orphan recovery on relaunch.
  - Deny mic permission, verify clear error and Settings deep-link works.
  - First-run on a fresh user: permissions explainer appears, both deep-links open the right panes.

## Implementation order (rough)

1. Swift helper (`meeting-notes-tap`) — recording + permission probe + process listing, tested via direct CLI invocation.
2. `electron-builder` config + `audio-tap/scripts/build.sh` to bundle universal binary.
3. `RecordingManager` + IPC plumbing + DB migration.
4. Permissions probe + first-run modal.
5. UI: source picker, live recording row, settings panel updates.
6. Delete `AudioHijackBridge`.
7. Manual smoke test pass.
