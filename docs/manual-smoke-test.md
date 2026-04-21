# Manual Smoke Test Checklist

Quick end-to-end verification that nothing is grossly broken after a change.
Run before merging significant feature work or releasing. ~10 min total.

## Prep

- [ ] LM Studio open, a chat model loaded (`qwen/qwen3.5-9b` or similar), local server enabled.
- [ ] HuggingFace token saved at `~/.cache/huggingface/token` (for diarization).
- [ ] Whisper server running (`scripts/whisper-server.sh status` reports Running).
- [ ] Latest `.app` built: `npm run dist` produces `release/mac-arm64/MeetingNotes.app`.

## Pipeline (existing — should still work)

- [ ] Drop a known-good MP3 in `~/Music/MeetingNotes` (or whichever recordings folder is configured).
- [ ] Library shows it in Inbox within ~2s.
- [ ] Click into it → Process. Stages advance: transcribing → diarizing → merging → identifying → awaiting_speaker_id.
- [ ] At `awaiting_speaker_id`, identify a few speakers OR check "Skip speaker ID" → pipeline continues to summarizing → extracting → done.
- [ ] Transcript renders. Summary tab renders properly-styled markdown (headings, bullets — not raw text). Action items show up.
- [ ] Export to Markdown: file save dialog appears, saved file is well-formatted.

## Built-in audio capture (new)

### First-launch permissions

- [ ] On a fresh user account (or after `tccutil reset Microphone com.dbbaskette.meetingnotes` and similar reset of "Screen & System Audio Recording" for the bundle ID), launch the `.app`.
- [ ] PermissionsModal appears with two rows: Microphone and System Audio.
- [ ] Each "Grant" button opens System Settings to the right pane (Microphone goes directly there; System Audio opens Privacy & Security where the user finds "Screen & System Audio Recording").
- [ ] Toggle MeetingNotes on in each pane.
- [ ] Modal closes within ~3 seconds (it polls every 2s).

### Recording

- [ ] Click ⏺ Record. SourcePicker opens within ~1s showing currently-running audio apps.
- [ ] Meeting apps (Zoom, Teams, FaceTime, etc.) appear with a "MEETING" badge first.
- [ ] Browsers / non-meeting apps appear after, then "All system audio (catch-all)" at the bottom.
- [ ] Pick an app (e.g., Music or QuickTime playing audio).
- [ ] LiveRecordingRow appears at the top of the library: red dot pulse, "Recording: <app name>", elapsed timer ticking, VU meter responds to audio.
- [ ] Talk into the mic for ~10 seconds.
- [ ] Click ■ Stop. Row disappears. File appears in `~/Music/MeetingNotes/recording-YYYYMMDD-HHMM-<sessionId>.m4a`.
- [ ] Within ~1s, an Inbox row appears for the new recording.
- [ ] Open the file in QuickTime / `afplay` — both your voice and the app's audio are audible, mixed mono.

### Pipeline on captured audio

- [ ] Process the recorded file through the pipeline. Whisper accepts the .m4a (no codec errors).
- [ ] Transcript is plausible (your voice + app audio surface as different speakers).

### Lifecycle edge cases

- [ ] Click Record → quit MeetingNotes mid-recording (Cmd+Q). On relaunch, the .m4a file is in `~/Music/MeetingNotes/` and shows up in Inbox; the `recording_sessions` row is marked `orphaned` (check via `sqlite3 ~/Library/Application\ Support/MeetingNotes/db.sqlite "SELECT id, status FROM recording_sessions ORDER BY started_at DESC LIMIT 5"`).
- [ ] Force-kill MeetingNotes mid-recording (`pkill -KILL MeetingNotes`). Helper detects parent death within ~1s, finalizes its own .m4a, exits. On relaunch, file is ingested.
- [ ] Quit the target app mid-recording (close Zoom while recording from Zoom). Helper auto-stops within ~1s with `target_exited` event; .m4a finalized and shows in Inbox.

### Permission revocation

- [ ] After granting permissions, revoke "Screen & System Audio Recording" for MeetingNotes in System Settings.
- [ ] Click Record. Recording fails with a clear error (not a silent 0-byte file).

## Known limitations to NOT mark as bugs

- "All system audio (catch-all)" may not work standalone — relies on the same per-PID enumeration as per-app capture.
- `recordingBitrateKbps` setting is exposed in Settings but the helper doesn't yet read it; bitrate is hardcoded at 128 kbps in the helper. Follow-up work.
- Helper standalone (run from a Terminal outside MeetingNotes.app) cannot capture system audio because TCC requires the parent .app's signed identity. The helper only works when spawned by the packaged MeetingNotes.app.
