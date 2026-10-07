# Settings, notes history, and large libraries

Settings now has searchable Recording, Processing, Organization, Integrations,
Storage, and Advanced sections. Technical endpoints and lifecycle controls live
in Advanced. Text saves when you leave a field, rather than on every keystroke;
the save indicator reports failure and offers retry. Folder paths have explicit
Choose, Apply, and Cancel controls. Applying a library/watch path requires a
restart and does **not** relocate existing recordings or database files.

Quoted, `~/`, and Terminal-escaped paths are accepted only when their corrected
absolute folder exists. An existing literal path always wins. Obsidian preview
shows the validated destination before enabling sync; missing folders and invalid
vaults produce readable guidance.

## Recovering notes and action items

Open **Notes & action-item history…** in a meeting's Notes tab, choose a version,
compare it with the current notes and tasks, then restore explicitly. The latest
20 distinct versions per meeting are retained locally before saved notes change,
reprocessing, manual action re-extraction, and restore. Unsaved drafts are not
versions. Restore saves the current version first and replaces notes and canonical
tasks together, including completion, owners, due dates, source quotes, and export
markers. Audio/transcripts are not changed. A removed roster owner cannot be
recreated and its link becomes unassigned. Individual task edits remain part of
the next snapshot; this is not a task-by-task audit log.

New edits invalidate an open comparison. Processing blocks restore. If the
transcript changed since the saved version, restored notes are marked stale.
Durable restore journals recover after restart without overwriting intervening
edits. If such edits prevent recovery, compare the preserved versions again and
explicitly restore the desired one. Versions are deleted with the meeting after
normal trash retention. Export markers are retained to avoid treating restored
tasks as never exported; restore does not undo anything in external task systems.

## Grouped library and Obsidian

Expanded browse groups render only viewport rows plus a small buffer, retaining
focused rows and owners of open dialogs. Groups share one scroll surface; search
snippets remain variable-height. Collapse still avoids fetching the group's
meetings, and Load more still controls pagination.

Obsidian startup resumes outstanding revisions. **Sync pending / retry failed**
does not reset already-synced meetings. **Recheck all notes** explicitly scans all
exports (for example, after external file edits). Changing transcript/action-item
inclusion requeues that destination's exports, including when returning to a
previous destination. Browse.md now builds its group buckets in one pass while
preserving the same links and date ordering.
