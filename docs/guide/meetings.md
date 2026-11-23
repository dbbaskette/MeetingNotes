# Working with meetings

Speaker review, notes and action items, the Actions and Weekly views, and search and playback. The app has four top-level views: **Library**, **Actions**, **Weekly** and **Settings**. A meeting page has three tabs: **Notes**, **Transcript** and **Actions**.

## The speaker-ID gate

*Name unknown voices once.*

After diarize + identify, meetings continue automatically when no voices need review, including recordings with no detected voices. The pipeline uses the same **Needs review** rules as the Speakers panel: an unknown voice, a match below 80% confidence, or fewer than two diarization segments pauses at `awaiting_speaker_id`. The library row turns amber with a `NAME VOICES` chip and (if the app isn't focused) a native notification. In the detail view each voice shows **Unknown**, **Probably <name>** (legacy), **Auto-matched · similarity …**, or **Confirmed**, plus confidence, speaking duration, impacted transcript lines, and a short playable sample. Ranked suggestions can be confirmed in one click; select multiple voices to assign them to one roster entry in a single operation, with an impact preview before transcript lines change. **Continue** re-merges the transcript with real names and proceeds; automatic continuation also re-merges names before summarizing. Don't care for this meeting? Tick **Skip speaker ID step** and it runs straight through.

Expanding an unnamed voice shows why it needs review. To stop the meeting instead, use **Cancel processing**; its audio is kept.

### Optional automatic voice matching

Enable **Settings → Processing → Automatically match known voices** to apply
strong native voiceprint matches during future identification runs. It is off
by default. The heuristics require unrounded similarity ≥ 0.80, a ≥ 0.05
lead over the runner-up, and ≥ 10 seconds of non-overlapping speech across two
distinct turns (each with ≥ 1.5 seconds of clean speech). Close candidates,
duplicate identity claims, short voices, missing/invalid evidence and incompatible
model profiles remain in review. Scores are not identity probabilities.

An unnamed voice whose best candidate scores ≥ 0.60 with the same lead shows
**Sounds like … · Confirm** on its row; one click assigns it as your own
confirmation. Unnamed voices with under 10 seconds of speech are listed under
**brief voices**, do not pause the meeting for review, and can still be named.

Names appear as **Auto-matched**, not **Confirmed**, even for similarity 1.00.
Expand the voice, listen and choose **Confirm this voice** to teach that profile;
use **Assign to** to correct it. Automatic matches never train themselves.
Confirmed assignments survive identification retries on the same diarization.
Changing the setting does not process old meetings, alter saved assignments or
undo prior matches. New diarization still resets run-local numeric labels.

### Notes before names

Enable **Settings → Processing → Generate notes before naming every voice** to
skip the pause. Processing carries on with speaker labels, and the notes and
action items refer to an unnamed voice by its exact `SPEAKER_00`-style label.
When you name that voice later, those labels are replaced in the notes, the
action-item text, owners and source quotes without regenerating anything, and
the previous notes are saved to notes history first. Names that are already in
the notes are never substituted. Saved weekly reports do not change.

A task whose owner was an unnamed voice is linked to the person you name, so it
counts as yours in **Actions** and **Weekly** when that person is you, even if
you rename yourself later.

Finished meetings with voices still to name are listed last in **Needs
attention → Voices to name**; **Name voices** opens the meeting. The count
matches the "N to identify" badge on the Library row.

After you name a voice in notes written with speaker labels, the notes panel
shows **Names changed. Regenerate notes to rewrite them with the new names?**
**Regenerate notes…** re-runs notes and action items only, after a
confirmation; the current version stays in notes history. The prompt goes away
once the notes are regenerated, and never appears for notes written when every
name was already known.

### Voiceprints

Only your own confirmations teach a voiceprint. **Settings → Organization →
Speakers** lists the roster; expand **Voiceprints** on a person to see when
their native voiceprint was last confirmed and from which source, and use
**Undo last voiceprint change** to revert the most recent one. Undo changes
future matching only; names already assigned in meetings stay as they are.
Merging two people keeps their native profiles.

## Notes and action items

*Editable, with provenance.*

Notes are structured into **Overview · Key Discussion Points · Decisions · Action Items · Follow-ups · Open Questions**, skipping empty sections. Opening/closing small talk is moved (not duplicated) into an **Off-topic Conversation** section at the end. Verbosity is a one-time **detail level** (concise / standard / detailed) that pins the target length in the prompt so different models don't drift.

The **Notes** tab has **View** and **Edit** modes, with a live preview while editing — fix a hallucination or redact in place and Save (writes to `summary.md`).

**Remembered terminology:** after a short correction such as **Salsa → SLSA**, an inline offer lets you remember the preferred spelling for the current group or all meetings. Rules suggest changes by default; automatic replacement in future generated text is opt-in. **Settings → Organization → Dictionary** shows a compact count and learning-offers toggle. Choose **Manage dictionary…** to search, filter by group, and add/edit/disable/delete rules in a dedicated scrollable dialog. The dictionary no longer pushes other settings down as it grows. This local dictionary and its correction history live in the library's existing `db.sqlite`; include that database with the meeting files when backing up the library.

Use **Correct terminology…** above either the transcript or summary. Define a replacement once, preview labeled matches and separate counts for both documents, then **Apply to both** in one operation. You can deselect individual occurrences; the Apply label reflects the selected document(s). **Review terminology** uses the same shared dictionary. One **Undo** reverses a combined correction while preserving unrelated edits. Existing notes are corrected directly, not regenerated; action items are unchanged. Raw transcription, speaker labels, and audio timing are preserved, and corrections survive speaker renaming. Unsaved summary edits block corrections in either tab. Overlapping later edits make Undo refuse rather than overwrite them. Updating all matching wording in both documents does not introduce a refresh warning; an existing warning remains, and leaving summary matches unchanged marks notes as potentially stale. Saving or changing a dictionary rule does not rewrite historical meetings.

**Action items** are extracted from the notes and carry **provenance**: click one to jump to the exact line it came from. Edited the notes? Use **Re-extract from summary** on the meeting's **Actions** tab to regenerate the items without re-running the whole pipeline. It reads the saved notes, so save your edits first.

Deleting an individual task offers immediate **Undo**, preserving its identity, source, owner, due date, completion, and export metadata. Undo refuses to overwrite newer task changes.

## Actions view

*Every open action item, in one list.*

**Actions** (<kbd>⌘3</kbd>) lists the open action items from all meeting dates. Filter by owner (**My actions** or **Everyone**), by group (including **Ungrouped**) and by date (**Overdue**, **Next 7 days**, **No due date**). **My actions** needs **Settings → Organization → You are…** to be set. Checking an item off removes it from the list and offers **Undo**; **Snooze** moves its due date a week out; **Edit** changes its text, owner and due date. Items from a meeting that is being processed cannot be edited until it finishes. The list is live: saved weekly reports are not changed by it.

## Weekly view

*A Mon–Sun narrative.*

The **Weekly** view (<kbd>⌘2</kbd>) rolls up every meeting in the week: an LLM narrative (past weeks only), a **Themes** section synthesizing 3–6 topic threads that run *across* meetings (with clickable chips back to sources), open action items grouped by owner, and key decisions. Once generated, the **Saved report** is a permanent SQLite snapshot of all those sections. New weeks, meeting edits, task completion and speaker-name changes do not alter or regenerate it. Reopening and **Export to Markdown** use the saved report, even when the model is offline or source meetings have been removed. Only **Regenerate** replaces it with the latest inputs; a failed regeneration keeps the previous report.

Set **Settings → Organization → You are…** to pin *your* open action items to a "You" group at the top. The current week is intentionally narrative-free (it would go stale within hours); the structured rollup still updates live.

Weeks use your Mac's local Monday–Sunday calendar, including DST boundaries. Current-week tasks support checkboxes, owner/due-date edits and **Snooze 1 week**; failed saves roll back and offer Retry. Saved reports show historical, read-only actions: use their source-meeting links to manage current tasks. Mine/Overdue/Due this week filters in saved reports use the snapshot date rather than changing as time passes. Concurrent generation requests share one owner, and source changes during generation are rejected without overwriting the previous report.

Reports generated by older versions retain their original overview, themes, decisions and generation date. Because those versions did not save meeting/action sections, those sections are frozen from the available data on first opening after upgrading, with a notice in the report. Regenerate if you want a new report wholly based on current inputs.

## Progress, search & playback

- **Process without a blocking popup** — select recordings and choose **Process** to queue only the selected meetings that are still pending. Progress stays inline; unsuccessful starts remain selected for retry. Processing and speaker-review rows open their detail view even when other meetings are selected; use their checkboxes for explicit selection.
- The Library and **Needs attention** inbox share one scroll area, including at smaller window sizes and higher zoom. Stage refreshes preserve the scroll position, and active capture controls remain above the scrolling area. Routine queue messages disappear automatically. Delete and re-run confirmations still protect operations that replace or remove results.
- **Separate speech progress** — transcription and voice analysis each report their own progress. They run in parallel; for a meeting of an hour or longer, or when free memory is under 2 GB, they run one after the other to save memory.
- **Learned ETAs** — the app records how long each stage takes on *your* machine, bucketed by transcript size, and shows "elapsed · ~estimate" with a "running long" cue. A rough estimate appears after a single run.
- **Permanent status bar** at the bottom shows the in-flight run from any view (`Summarizing "…" — 17s · ~3m · 2 queued`), or `Ready` when idle.
- <kbd>⌘K</kbd> opens a global search across titles, notes, and transcript text. Type a question and press <kbd>Shift</kbd>+<kbd>Enter</kbd> (or click **Ask**) for an answer from your summary model, with numbered links to the meetings it came from. See [Asking your meetings](#asking-your-meetings).
- **Keyboard** — <kbd>j</kbd> / <kbd>k</kbd> move between meetings in both Library views and <kbd>Enter</kbd> opens the highlighted one. <kbd>⌘1</kbd> Library, <kbd>⌘2</kbd> Weekly, <kbd>⌘3</kbd> Actions. In the notes editor <kbd>⌘S</kbd> saves; <kbd>Tab</kbd> indents, and <kbd>Esc</kbd> then <kbd>Tab</kbd> leaves the editor.
- **Cancel a run** from the meeting page (**Cancel processing**), the status bar at the bottom of any view (**Cancel**), or the Library queue banner (**Cancel current**). Only that meeting stops; its audio is kept and queued meetings are unaffected.
- **Find in transcript** marks every match inside the lines. <kbd>Esc</kbd> or the clear button empties the search.
- **Actions** — see [Actions view](#actions-view). Overdue tasks are flagged.
- **Prepare next meeting** (a group's **⋯** menu in the Library) lists open actions with check-off, the decisions and open questions from recent notes, and template sections such as *Topics for Next Time* and *Blockers*. **Copy Markdown** copies the brief; **Open in Actions** shows the group's full task list.
- **Obsidian sync** problems (vault unavailable, notes paused by an edit in Obsidian) appear in **Needs attention**. Notes history and the Obsidian conflict review show a line-by-line diff.
- Both Library and global search share date/week, speaker, task ownership, status, source, recovery-warning, and notes/transcript filters. Filters apply before result limits; chips remove them individually. Named filters explicitly save their query locally. Cancelled, incomplete, limited, and failed searches do not masquerade as complete results.
- **Click-to-play transcript** — timestamps seek the sticky audio player, which survives tab switches so you can listen while editing.
- Large timestamped transcripts render a bounded variable-height window on the existing scrollbar. **Find in transcript** / <kbd>⌘F</kbd>, full-copy and export still cover the whole text. Playback follows the active row unless you scroll manually; explicit seeks and search matches can reach unmounted passages. Per-line and Grouped views retain whole-text corrections and speaker colors.
- **Needs attention** — recovery warnings, failed processing, speaker gates, pending recordings and, last, finished meetings with voices to name have prioritized next actions. **View all** or **+N more** opens the entire backlog with bounded pages.

## Notes templates

A template sets which sections the notes have for a kind of meeting. Six are built in:

| Template | Sections it adds |
| --- | --- |
| **General** (default) | Key Discussion Points, Follow-ups, Open Questions |
| **1:1** | Updates, Feedback and Growth, Blockers and Support Needed, Topics for Next Time |
| **Standup** | Progress, Planned Next, Blockers, each per person |
| **Customer call** | Customer Context, Needs and Pain Points, Objections and Risks, Next Steps, Open Questions |
| **Interview** | Candidate Background, Strengths, Concerns, Notable Answers, Open Questions |
| **Decision review** | Options Considered, Trade-offs, Risks and Mitigations, Open Questions |

Every template keeps **Overview**, **Decisions**, **Action Items** and **Off-topic Conversation**, because action-item extraction, the Weekly view and exports rely on them.

- **For a group:** Settings → Processing → **Notes template by group**. Meetings in that group use it from then on.
- **For one meeting:** the meeting page's **Processing** menu → **Notes template**. *Automatic* follows the group.

Choosing a template never rewrites notes that already exist. To apply it to a finished meeting, pick the template and then use **Processing ▾ → Re-run from… → Notes and action items only**; the previous notes are kept in notes history. Templates are built in and cannot be edited yet.

## The meeting page

Notes, transcript and action items fill the page. The header shows the meeting's date and length and holds two controls:

- **Processing** lists the models that produced the notes and the three re-run options: from transcription, from speaker separation, or notes and action items only. Each asks for confirmation before replacing results. A recording that has never been processed shows **Process recording** here instead.
- The **panel button** beside it hides or shows the speakers and export rail, so a finished meeting can be read at full width. The choice is remembered.

Above the tabs, **Ask about this meeting** answers a question from this meeting's notes and transcript only; see [Asking your meetings](#asking-your-meetings).

In the speakers rail, voices that need review are always listed in full. When more than four voices are already named, they fold into one **N named voices** row; **Show all** expands it.

## Asking your meetings

Ask a question in plain words and get a short answer with numbered sources. The answer is written only from passages of your notes and transcripts; when nothing relevant is found it says so instead of guessing.

- **Across the library:** <kbd>⌘K</kbd>, type the question, <kbd>Shift</kbd>+<kbd>Enter</kbd> or **Ask**. A source opens its meeting, at the quoted moment for a transcript passage.
- **Across filtered meetings:** with search filters set (dates or week, speaker, status, tasks, source, warnings), Ask uses only the meetings those filters allow, by the same rules as the result list. The answer starts with the scope, for example *Asked across 12 meetings in week 2026-W46, with Alice*. The notes/transcript filter limits the passages to notes or transcripts.
- **Inside one meeting:** on the meeting page, type in **Ask about this meeting** and press <kbd>Enter</kbd>. It appears once the meeting has notes or a transcript. A transcript source seeks the player to that moment without leaving the page; a notes source switches to the Notes tab. If the meeting does not cover it, the answer says it was not found in this meeting. <kbd>Esc</kbd> closes the answer.

Each answer ends with where the model ran. With LM Studio or Ollama managed by the app, or an external endpoint on `localhost`, `127.0.0.1` or `[::1]`, it ran on this Mac. With any other endpoint, the answer names the host your question and the quoted passages were sent to. When no passage matched, nothing is sent.

Questions and answers are not saved or logged. Leaving the answer, asking something else, or closing the window stops a question still being answered.
