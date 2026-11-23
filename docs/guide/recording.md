# Recording a meeting

1. Click **⏺ Record** or press <kbd>⌘R</kbd> from any view — or fire `meetingnotes://record?source=zoom.us` from a Shortcut / `osascript` / Stream Deck — or let auto-detect catch it. Auto-detect is off by default; turn it on under **Settings → Recording → Meeting auto-detect**. A banner then appears when a known meeting URL opens in your browser, or when Zoom, Teams, FaceTime, Slack, Discord or WhatsApp starts producing audio; if no MeetingNotes window has focus, a **Meeting detected** notification appears as well, and clicking it brings the window forward.
2. The **source picker** lists every app currently making sound; recognized meeting apps float to the top with a `MEETING` badge. **Refresh** retains the group and optional **Meeting title**. Choose **Save to group**, optionally enter a title, then pick an app or **All system audio**. Choosing the source starts recording. Titles also work in `meetingnotes://record?...&title=Platform%20planning` and remain separate from the audio-source label.
3. A **live recording row** appears with elapsed time, a VU meter, and Stop.
4. Click **Stop**, then **Confirm stop** — finalized audio is cataloged in Library. If exit cannot be confirmed, keep the controls open and retry Stop.
5. Click **▶ Process**, or explicitly enable **Settings → Processing → Process recordings automatically when capture finishes** (default off). Automation applies only to newly finalized built-in captures, not imports/recovery/history, and respects queue pause and speaker review.

Each recording writes up to three AAC files to the Library's `recordings/` directory (by default `~/Documents/MeetingNotes/recordings/`; mono, always 128 kbps ≈ 60 MB/hour, with no quality setting): the **mixed** file `recording-YYYYMMDD-HHMMSS-<id>.m4a` (used by the pipeline), a `.voice.m4a` microphone stem, and a `.system.m4a` app-audio stem. The live row reports Mic, App, and File health independently so a silent source is distinguishable from a stalled output. When app audio is missing, it offers an explicit restart using **All system audio**. If app audio stops arriving mid-recording (for example when a Bluetooth headset switches between its music and call modes), the recorder reconnects to the app within a second or two; the gap is recorded as silence and noted in the log as `recording:app-audio-stalled`.

If a capture is interrupted, finalized incompletely, or never indexed, open **Needs attention → Capture recovery**. The inbox shows the source, duration, size, and reason, then offers **Recover**, **Trim and recover**, **Show in Finder**, **Delete…**, or **Dismiss**. Recovery creates a new cataloged copy and leaves the original capture untouched. **Delete…** lists the capture's files (combined recording, your microphone, app audio) with their sizes and names, then moves them to the macOS Trash so you can still put them back from Finder. Nothing is deleted if a Library meeting uses one of the files.

## When the audio goes silent

If every source (microphone and app audio) stays silent for two minutes, MeetingNotes asks whether to stop. Recording carries on while it asks. The question appears in the live recording row, in the menu-bar item, and, when no MeetingNotes window has focus, as a notification.

- **Continue recording** keeps going. If it stays silent, the next question waits twice as long (up to 30 minutes), so a quiet meeting is not interrupted every two minutes.
- **Stop now** stops and saves the recording as usual.
- If sound comes back, the question goes away by itself.
- If nobody answers within a minute, the recording is stopped and saved, and a notification says "Stopped automatically after audio went silent".

Change the two-minute wait and the one-minute countdown, or turn the whole thing off, under **Settings → Recording → When audio goes silent** (the `autoStopOnSilence`, `silencePromptAfterS` and `silenceCountdownS` settings; [reference](settings.md#full-settings-reference)). A change applies to a recording that is already running. With it turned off, MeetingNotes never asks and never stops a recording for silence.

## Calendar-aware recording

MeetingNotes can use your Mac's calendar to name recordings and suggest who was speaking. It is off by default. Turn it on under **Settings → Recording → Calendar** (the `calendarAware` setting; [reference](settings.md#full-settings-reference)). Turning it on makes macOS ask once for calendar access; the setting shows whether access is granted, and **Setup & health** has a **Calendar** row.

With access granted:

- **Title.** A recording that starts during a calendar event, or up to five minutes before one, is titled after the event. All-day events and events you declined are ignored; if several events overlap, the one that started closest to now is used. A title you type in the source picker, or pass as `title=` in a `meetingnotes://record` URL, always wins.
- **Speaker names.** When you name a voice, the event's attendees appear under **From the calendar invite**. Picking one names that voice; an attendee who is already a saved speaker reuses that speaker. Nothing is assigned automatically.

MeetingNotes keeps the event's title, start and end, recurring-series identifier and the attendees' display names with the meeting. It never stores e-mail addresses, never changes your calendar and never sends calendar data anywhere. It reads whatever calendars the macOS Calendar app shows, including Google and Exchange accounts added there; it does not connect to Google or Microsoft itself.

If you deny access, or turn the setting off, recording works exactly as before and no calendar is read. To allow access later, use **System Settings → Privacy & Security → Calendars**.

## From the menu bar or a shortcut

MeetingNotes shows an item in the macOS menu bar. While recording it displays the elapsed time. Click it to:

- **Record All System Audio** — starts immediately, with your microphone, without opening the window.
- **Choose What to Record…** — brings the window forward and opens the source picker.
- **Stop Recording**, **Pause Processing** / **Resume Processing**, **Open MeetingNotes**, **Quit MeetingNotes**.

While MeetingNotes is asking whether to stop a silent recording, the item counts down beside the elapsed time ("12:05 · stops in 0:45") and its menu starts with **Continue recording** and **Stop now**.

MeetingNotes keeps running in the menu bar when its window is closed, so a recording or processing run continues. Turn the item off in **Settings → Recording → Menu bar and shortcut**.

In the same place you can set a **start/stop shortcut** that works from any app: choose **Record shortcut** and press the combination, for example Control+Shift+R. **Change** records a different one and **Clear** removes it. It starts recording all system audio, or stops the current recording. There is no shortcut by default, and a combination that macOS or another app already uses is refused with a message.

Menu-bar and shortcut actions use the same recorder as the Record button and the `meetingnotes://` URL scheme, so starting while a recording is active is refused the same way.

## Managing recordings

The Library opens in **Organized** view: **Ungrouped** appears first, then pinned groups, then the remaining groups alphabetically, all as expandable sections in the meeting list. Meetings appear only inside their assigned section. Expand a section to browse its meetings, or choose **View** to focus on that group alone; **All groups** returns to the organized list. Use **All meetings** for a flat, sortable list. Status filters and inline search work in either layout; organized search groups matches by their assigned group, while **⌘K** quick search remains global. Use **+ New group** to create a section, and **Move to group…** from a row, meeting detail, or bulk selection to organize older recordings. A meeting belongs to at most one group. Deleting a group only clears assignments; it never deletes meetings or audio.

A group's **⋯** menu has **Prepare next meeting**, **Pin group** / **Unpin group**, **Rename group…** and **Delete group…**. A pinned group shows **Pinned** and stays directly below Ungrouped. **Prepare next meeting** is described in [Working with meetings](meetings.md#progress-search--playback).

Every row and the detail-view header has a **⋯** menu with **Move to group…**, **Rename…**, and **Delete…**. Delete moves the meeting and its files to **Recently deleted** for a 30-day recovery window; the Library can restore it or purge it after retention expires.

New arrivals in **Ungrouped** have a **New** marker until you explicitly choose **Mark new as seen** or group them. The existing backlog is not marked new on upgrade. Inline **Move…** opens the same confirmation flow; its recent destinations never move anything without confirmation. Nonzero group badges reveal unprocessed, in-progress/review, or failed meetings. Keyboard rows open with Enter/Space; visible checkboxes enter selection mode, and Escape clears it outside active dialogs/editors. After a move, Undo restores only rows that have not moved again. Editor Undo still takes precedence. Drilling into a meeting keeps the Library query, expanded groups, loaded rows, and scroll position; relaunch remembers only lightweight browse preferences unless you explicitly save a named filter.
