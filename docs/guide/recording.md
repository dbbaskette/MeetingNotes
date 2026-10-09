# Recording a meeting

1. Click **⏺ Record** — or fire `meetingnotes://record?source=zoom.us` from a Shortcut / `osascript` / Stream Deck — or let auto-detect catch it (an in-library banner appears when a known meeting URL opens in your browser, or when Zoom / Teams / Webex / FaceTime starts a call).
2. The **source picker** lists every app currently making sound; recognized meeting apps float to the top with a `MEETING` badge. **Refresh** retains the group and optional **Meeting title**. Choose **Save to group**, optionally enter a title, then pick an app or **All system audio**. Choosing the source starts recording. Titles also work in `meetingnotes://record?...&title=Platform%20planning` and remain separate from the audio-source label.
3. A **live recording row** appears with elapsed time, a VU meter, and Stop.
4. Click **■ Stop**, then confirm — finalized audio is cataloged in Library. If exit cannot be confirmed, keep the controls open and retry Stop.
5. Click **▶ Process**, or explicitly enable **Process recordings automatically when recording stops** in Processing Settings (default off). Automation applies only to newly finalized built-in captures, not imports/recovery/history, and respects queue pause and speaker review.

Each recording writes up to three AAC files to the Library's `recordings/` directory (by default `~/Documents/MeetingNotes/recordings/`; mono, 128 kbps ≈ 60 MB/hour): the **mixed** file (used by the pipeline), a `.voice` microphone stem, and a `.system` app-audio stem. The live row reports Mic, App, and File health independently so a silent source is distinguishable from a stalled output. When app audio is missing, it offers an explicit restart using **All system audio**.

If a capture is interrupted, finalized incompletely, or never indexed, open **Needs attention → Capture recovery**. The inbox shows the source, duration, size, and reason, then offers **Recover**, **Trim and recover**, **Finder**, or **Dismiss**. Recovery creates a new cataloged copy and leaves the original capture untouched.

## From the menu bar or a shortcut

MeetingNotes shows an item in the macOS menu bar. While recording it displays the elapsed time. Click it to:

- **Record All System Audio** — starts immediately, with your microphone, without opening the window.
- **Choose What to Record…** — brings the window forward and opens the source picker.
- **Stop Recording**, **Pause/Resume Processing**, **Open MeetingNotes**, **Quit**.

MeetingNotes keeps running in the menu bar when its window is closed, so a recording or processing run continues. Turn the item off in **Settings → Recording → Menu bar and shortcut**.

In the same place you can set a **start/stop shortcut** that works from any app, for example `Control+Shift+R`. It starts recording all system audio, or stops the current recording. There is no shortcut by default, and a combination that macOS or another app already uses is refused with a message.

Menu-bar and shortcut actions use the same recorder as the Record button and the `meetingnotes://` URL scheme, so starting while a recording is active is refused the same way.

## Managing recordings

The Library opens in **Organized** view: **Ungrouped** appears first, followed by alphabetically sorted named groups, all as expandable sections in the meeting list. Meetings appear only inside their assigned section. Expand a section to browse its meetings, or choose **View** to focus on that group alone; **All groups** returns to the organized list. Use **All meetings** for a flat, sortable list. Status filters and inline search work in either layout; organized search groups matches by their assigned group, while **⌘K** quick search remains global. Use **+ New group** to create a section, and **Move to group…** from a row, meeting detail, or bulk selection to organize older recordings. A meeting belongs to at most one group. Deleting a group only clears assignments; it never deletes meetings or audio.

Every row and the detail-view header has a **⋯** menu with **Move to group…**, **Rename…**, and **Delete…**. Delete moves the meeting and its files to **Recently deleted** for a 30-day recovery window; the Library can restore it or purge it after retention expires.

New arrivals in **Ungrouped** have a **New** marker until you explicitly choose **Mark new as seen** or group them. The existing backlog is not marked new on upgrade. Inline **Move…** opens the same confirmation flow; its recent destinations never move anything without confirmation. Nonzero group badges reveal unprocessed, in-progress/review, or failed meetings. Keyboard rows open with Enter/Space; visible checkboxes enter selection mode, and Escape clears it outside active dialogs/editors. After a move, Undo restores only rows that have not moved again. Editor Undo still takes precedence. Drilling into a meeting keeps the Library query, expanded groups, loaded rows, and scroll position; relaunch remembers only lightweight browse preferences unless you explicitly save a named filter.
