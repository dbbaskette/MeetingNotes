# Working with meetings

Speaker review, notes and action items, the Weekly view, and search and playback.

## The speaker-ID gate

*Name unknown voices once.*

After diarize + identify, meetings continue automatically when no voices need review, including recordings with no detected voices. The pipeline uses the same **Needs review** rules as the Speakers panel: an unknown voice, a match below 80% confidence, or fewer than two diarization segments pauses at `awaiting_speaker_id`. The library row turns amber with a `NAME VOICES` chip and (if the app isn't focused) a native notification. In the detail view each voice shows **Unknown**, **Probably <name>**, or **Confirmed**, plus confidence, speaking duration, impacted transcript lines, and a short playable sample. Ranked suggestions can be confirmed in one click; select multiple voices to assign them to one roster entry in a single operation, with an impact preview before transcript lines change. **Continue** re-merges the transcript with real names and proceeds; automatic continuation also re-merges names before summarizing. Don't care for this meeting? Toggle **Skip speaker ID** and it runs straight through.

## Summary + action items

*Editable, with provenance.*

Summaries are structured into **Overview · Key Discussion Points · Decisions · Action Items · Follow-ups · Open Questions**, skipping empty sections. Opening/closing small talk is moved (not duplicated) into an **Off-topic Conversation** section at the end. Verbosity is a one-time **detail level** (concise / standard / detailed) that pins the target length in the prompt so different models don't drift.

The **Summary editor** has View and Edit modes, with a live preview while editing — fix a hallucination or redact in place and Save (writes to `summary.md`).

**Remembered terminology:** after a short correction such as **Salsa → SLSA**, an inline offer lets you remember the preferred spelling for the current group or all meetings. Rules suggest changes by default; automatic replacement in future generated text is opt-in. **Settings → Dictionary** shows a compact count and learning-offers toggle. Choose **Manage dictionary…** to search, filter by group, and add/edit/disable/delete rules in a dedicated scrollable dialog. The dictionary no longer pushes other settings down as it grows. This local dictionary and its correction history live in the library's existing `db.sqlite`; include that database with the meeting files when backing up the library.

Use **Correct terminology…** above either the transcript or summary. Define a replacement once, preview labeled matches and separate counts for both documents, then **Apply to both** in one operation. You can deselect individual occurrences; the Apply label reflects the selected document(s). **Review terminology** uses the same shared dictionary. One **Undo** reverses a combined correction while preserving unrelated edits. Existing notes are corrected directly, not regenerated; action items are unchanged. Raw transcription, speaker labels, and audio timing are preserved, and corrections survive speaker renaming. Unsaved summary edits block corrections in either tab. Overlapping later edits make Undo refuse rather than overwrite them. Updating all matching wording in both documents does not introduce a refresh warning; an existing warning remains, and leaving summary matches unchanged marks notes as potentially stale. Saving or changing a dictionary rule does not rewrite historical meetings.

**Action items** are extracted from the summary and carry **provenance**: click one to jump to the exact summary bullet it came from. Edited the summary? Hit **↻ Re-extract** to regenerate the items in seconds without re-running the whole pipeline.

Deleting an individual task offers immediate **Undo**, preserving its identity, source, owner, due date, completion, and export metadata. Undo refuses to overwrite newer task changes.

## Weekly view

*A Mon–Sun narrative.*

The **Week** tab rolls up every meeting in the week: an LLM narrative (past weeks only), a **Themes** section synthesizing 3–6 topic threads that run *across* meetings (with clickable chips back to sources), all open action items grouped by owner, and key decisions. It's cached in SQLite by content hash — re-opening is instant; editing any meeting in the week invalidates it. **Export to Markdown** ships the whole rollup.

Set **Settings → "You are…"** to pin *your* open action items to a "You" group at the top. The current week is intentionally narrative-free (it would go stale within hours); the structured rollup still updates live.

Weeks use your Mac's local Monday–Sunday calendar, including DST boundaries. Task checkboxes, owner/due-date edits, **Snooze 1 week**, and Mine/Overdue/Due this week filters work directly in Weekly. Failed saves roll back and offer Retry; successful edits refresh counts and invalidate the narrative. The cache tracks actual summary text, tasks, and roster names; concurrent regenerate requests share one owner and stale generations are not cached.

## Progress, search & playback

- **Learned ETAs** — the app records how long each stage takes on *your* machine, bucketed by transcript size, and shows "elapsed · ~estimate" with a "running long" cue. A rough estimate appears after a single run.
- **Permanent status bar** at the bottom shows the in-flight run from any view (`Summarizing "…" — 17s · ~3m · 2 queued`), or `Ready` when idle.
- <kbd>⌘K</kbd> opens a global search across titles, summaries, and transcript text.
- Both Library and global search share date/week, speaker, task ownership, status, source, recovery-warning, and notes/transcript filters. Filters apply before result limits; chips remove them individually. Named filters explicitly save their query locally. Cancelled, incomplete, limited, and failed searches do not masquerade as complete results.
- **Click-to-play transcript** — timestamps seek the sticky audio player, which survives tab switches so you can listen while editing.
- Large timestamped transcripts render a bounded variable-height window on the existing scrollbar. **Find in transcript** / <kbd>⌘F</kbd>, full-copy and export still cover the whole text. Playback follows the active row unless you scroll manually; explicit seeks and search matches can reach unmounted passages. Per-line and Grouped views retain whole-text corrections and speaker colors.
- **Needs attention** — recovery warnings, failed processing, speaker gates, and pending recordings have prioritized next actions. **View all** or **+N more** opens the entire backlog with bounded pages.
