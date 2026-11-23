# Manual Smoke Test Checklist

Quick end-to-end verification that nothing is grossly broken after a change.
Run before merging significant feature work or releasing.

Paths below use the default Library, `~/Documents/MeetingNotes`. If **Settings → Storage → Library path** points elsewhere, substitute that folder for `<library>`.

## Prep

- [ ] If this release changes the Library, meeting page, recording row or Weekly view, refresh the README screenshots: `npm run dev:renderer` in one terminal, `npm run screenshots` in another.
- [ ] LM Studio or Ollama available with a chat model (`qwen/qwen3.5-9b` or similar), and **Settings → Advanced → LLM Model** set to it.
- [ ] Apple silicon, macOS 26 or newer. **Settings → Processing** shows Apple assets and Speaker models **ready**. **Transcription engine** is **Apple Speech (Built-in)**. There is no token field, and the only download control is **Prepare native speech**.
- [ ] Optional, needs about 1 GB free and a few minutes: choose **WhisperKit Large-v3-Turbo (High accuracy)**. Nothing downloads until you click **Prepare native speech**; the status then goes through download, verification and optimization to **WhisperKit model: ready**. Process a short recording and confirm the meeting's processing details name **WhisperKit large-v3-turbo**. Switch back to Apple Speech, reprocess the same meeting, and confirm the details now name **Apple SpeechTranscriber** and the earlier transcript is in history.
- [ ] Latest installer built: `npm run dist` produces a versioned DMG and ZIP under `release/` (the loose `.app` is removed after packaging).

## Meeting groups

- [ ] In **Organized**, confirm **Ungrouped** appears first, then pinned groups, then the remaining groups alphabetically, including during grouped search. Expand/collapse several sections, restart the app, and verify expansion state persists. A meeting appears only inside its assigned group, never twice in the organized list.
- [ ] Open a group's **⋯** menu and choose **Pin group**. The group shows **Pinned** and moves directly below Ungrouped. **Unpin group** returns it to its alphabetical place.
- [ ] Create a named group using **+ New group**; check its empty section, rename and delete from its **⋯** menu. Confirm the name updates on assigned rows. Use **View** to focus on one group and **All groups** to return.
- [ ] Move an existing meeting from its row or detail view, and move several using bulk selection. Check the section count, filtered list, grouped inline search, Undo, and that audio and notes remain in place. Search results should appear only once under the assigned group; clearing search should restore the prior expand/collapse state.
- [ ] In the move dialog, selecting a destination must **not** move anything until **Move to …** is confirmed. Check the meeting title/current group or bulk preview, a hidden-selection warning where applicable, and the highlighted destination. Searching for a named group must not leave Ungrouped as an unrelated choice; changing the search must clear a prior destination.
- [ ] After a successful bulk move, the moved meetings are deselected. If only some move, only failures remain selected and the toast names the destination and offers Undo. Confirm an all-failed move stays open for retry and an in-progress move cannot be dismissed with Escape or a backdrop click.
- [ ] Start a short recording with **Save to group** selected. Confirm the cataloged meeting belongs to that group. Delete the group and confirm the recording remains in Ungrouped.
- [ ] Switch to **All meetings** and back. Check the organized list and move dialog with a long name and a narrow window; verify keyboard focus, Enter, and Escape. Confirm **Needs attention**, Weekly, and ⌘K still show meetings across groups.

## Pipeline

- [ ] Drop a known-good MP3 into `<library>/recordings/` (or the **Extra watch folder** from Settings → Storage, if one is set).
- [ ] The Library shows it as a new unprocessed meeting in **Ungrouped** within a few seconds.
- [ ] Open it and click **Process recording**. Transcription and voice analysis report progress separately, then the stages advance: merging → identifying. If any voice shows **Needs review** (unknown, similarity below 0.80, or fewer than two diarization segments), processing pauses and the Library row shows `NAME VOICES`.
- [ ] While paused, name a few voices and click **Continue**, or tick **Skip speaker ID step**; the pipeline continues to summarizing → extracting → done.
- [ ] A meeting where every voice is named, at 0.80 similarity or above, with two or more diarization segments, continues automatically without a naming prompt. Confirm the notes use the roster names. A recording with no detected voices also continues without an empty naming prompt. An unnamed voice with under 10 seconds of speech is listed under **brief voices** and does not pause the meeting.
- [ ] The **Transcript** tab renders. The **Notes** tab renders styled Markdown (headings, bullets, not raw text). The **Actions** tab lists the action items.
- [ ] Export to Markdown: the save dialog appears and the saved file is well formatted.

### Cancel a run

- [ ] Start processing a meeting, then click **Cancel processing** on its page. A toast says only this meeting is stopping and its audio is retained. The recording is still playable and can be processed again.
- [ ] Start another and cancel it from the status bar at the bottom of a different view (**Cancel**), and once from the Library queue banner (**Cancel current**). Other queued meetings are not cancelled.

### Notes before names

- [ ] Turn on **Settings → Processing → Generate notes before naming every voice**. Process a recording with an unknown voice: it does not pause, and the notes and action items refer to the voice by its `SPEAKER_00`-style label.
- [ ] Name that voice afterwards. The exact label is replaced in the notes and action items without regenerating them, and **Notes & action-item history…** on the Notes tab has a snapshot from before the change. Turn the setting off again.

### Voiceprints

- [ ] Confirm a voice in a meeting (**Confirm this voice**). In **Settings → Organization → Speakers**, find the person and expand **Voiceprints**: the entry shows the confirmation date and its source.
- [ ] Click **Undo last voiceprint change**. The profile reverts; names already assigned in meetings stay unchanged.

## Actions and preparation

- [ ] Open **Actions** (⌘3). It lists open action items across all meeting dates. The Owner, Group (including **Ungrouped**) and date filters narrow the list.
- [ ] Check an item off: it leaves the list and the toast offers **Undo**. **Snooze** moves the due date a week out. **Edit** changes text, owner and due date.
- [ ] In the Library, open a group's **⋯** menu and choose **Prepare next meeting**. The brief lists the group's open actions and, for recent finished meetings, their decisions and open questions. **Copy Markdown** copies it; **Open in Actions** opens the Actions view filtered to that group.

## Built-in audio capture

### First-launch permissions

- [ ] On a fresh user account (or after `tccutil reset Microphone com.dbbaskette.meetingnotes` and a similar reset of "Screen & System Audio Recording" for the bundle ID), launch the `.app`.
- [ ] After the three-step setup (Permissions, Speech, Summary model; each can be skipped), **Permissions needed** appears with two rows, Microphone and System audio, if either is still missing.
- [ ] **Grant** requests microphone access. **Open System Settings** goes to Privacy & Security, where "Screen & System Audio Recording" is.
- [ ] Toggle MeetingNotes on in each pane.
- [ ] The dialog closes within a few seconds (it rechecks every 2 seconds).

### Recording

- [ ] Click ⏺ Record. The source picker opens within about a second showing apps that are currently making sound.
- [ ] Meeting apps (Zoom, Teams, FaceTime, etc.) appear first with a `MEETING` badge.
- [ ] Browsers and other apps appear after, then **All system audio (catch-all)** at the bottom.
- [ ] Pick an app (for example Music or QuickTime playing audio).
- [ ] The live recording row appears at the top of the Library: "Recording: <app name>", an elapsed timer, a level meter that responds to audio, and Mic / App / File indicators.
- [ ] Talk into the mic for about 10 seconds.
- [ ] Click **Stop**, then **Confirm stop**. The row disappears. The file is at `<library>/recordings/recording-YYYYMMDD-HHMMSS-<sessionId>.m4a` (UTC timestamp), with `.voice` and `.system` stems beside it.
- [ ] Within about a second, the new recording appears in the Library as an unprocessed meeting.
- [ ] Open the file in QuickTime or `afplay`: both your voice and the app's audio are audible, mixed mono.
- [ ] ⌘R opens the source picker from the Actions, Weekly and Settings views, not only from the Library.

### When the audio goes silent

- [ ] For a quick check, set **Settings → Recording → When audio goes silent → Ask after** to 1 min and **Then stop after** to 30 s. Start a recording and keep the microphone and the app silent.
- [ ] After a minute the live recording row asks whether to stop and shows a countdown; the menu-bar item shows the countdown too. Recording continues while it asks.
- [ ] **Continue recording** dismisses the question; the next one waits twice as long. Making a sound also dismisses it.
- [ ] Let a countdown run out: the recording is stopped and saved, and a notification says it stopped automatically after the audio went silent.
- [ ] Untick **Ask before stopping a silent recording** and confirm a silent recording is never interrupted. Restore the defaults (2 min, 1 min, on).

### Pipeline on captured audio

- [ ] Process the recorded file. Apple transcription and SpeakerKit accept the `.m4a` (no codec errors).
- [ ] The transcript is plausible (your voice and the app audio surface as different speakers).

### Lifecycle edge cases

- [ ] Click Record, then quit MeetingNotes mid-recording (⌘Q). The app stops the recording before exiting. On relaunch the `.m4a` is in `<library>/recordings/` and cataloged in the Library, and its `recording_sessions` row is `finalized` (check with `sqlite3 ~/Documents/MeetingNotes/db.sqlite "SELECT id, status FROM recording_sessions ORDER BY started_at DESC LIMIT 5"`; with a custom Library path the table is in `<library>/db.sqlite`).
- [ ] Force-kill MeetingNotes mid-recording (`pkill -KILL MeetingNotes`). The helper detects the parent's death within about a second, finalizes its own `.m4a` and exits. On relaunch the row is marked `orphaned` and the recording is either cataloged or offered under **Needs attention → Capture recovery**.
- [ ] Quit the target app mid-recording (close Zoom while recording from Zoom). The helper stops within about a second with a `target_exited` event; the `.m4a` is finalized and appears in the Library.

### Permission revocation

- [ ] After granting permissions, revoke "Screen & System Audio Recording" for MeetingNotes in System Settings.
- [ ] Click Record. Recording fails with a clear error (not a silent 0-byte file).

## Source picker

- [ ] Multiple audible helpers of one app remain separately selectable beneath the app heading. Labels identify each PID; selecting one records that stream, not every sibling.
- [ ] Background processes stay accessible through their disclosure. Older helper binaries retain their named sources.
- [ ] Idle meeting apps still require confirmation. **All system audio** remains available for capturing every stream.

## Known limitations to NOT mark as bugs

- "All system audio (catch-all)" may not work standalone — relies on the same per-PID enumeration as per-app capture.
- Recordings are always 128 kbps AAC. There is no recording-quality setting.
- Helper standalone (run from a Terminal outside MeetingNotes.app) cannot capture system audio because TCC requires the parent .app's signed identity. The helper only works when spawned by the packaged MeetingNotes.app.
