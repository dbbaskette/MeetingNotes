# Obsidian vault sync design

Status: approved by the user on 2026-10-02 and implemented for 1.13.0. Live isolated Obsidian rendering remains a documented manual compatibility check.

## Outcome

Choose an existing Obsidian vault root in Settings. MeetingNotes creates its own workspace within that vault and automatically maintains one Markdown note per completed meeting. The same files appear in group and date views without duplicating meeting content.

Use Obsidian's built-in Bases feature, not a required community plugin. Bases stores view configuration separately from the Markdown notes and supports multiple views, grouping by a property, and date sorting. The familiar organization is reproduced using note properties rather than moving files between group folders. Exact collapse behavior and Ungrouped-first ordering must be verified in a supported Obsidian version; do not promise pixel-identical behavior to MeetingNotes.

References checked 2026-10-02: [Bases](https://help.obsidian.md/bases), [Views](https://help.obsidian.md/bases/views), [Bases syntax](https://help.obsidian.md/bases/syntax), [Embedding views](https://help.obsidian.md/bases/create-base).

## Vault layout and views

Create a dedicated `MeetingNotes/` directory containing:

- `Meetings.md`: a landing note linking to the prepared views and explaining sync ownership.
- `Meetings.base`: Grouped, By date, and Ungrouped views of the same meeting files.
- `Notes/`: canonical meeting Markdown files, never separate copies for each view.
- `Browse.md`: a generated link-only index grouped by meeting group and by date, useful without Bases enabled. Grouped section puts Ungrouped first; chronological section is newest first.

Use a readable date/title/identity filename established on first sync and then kept stable. Immutable meeting IDs and a local manifest identify notes; title or group changes update metadata rather than paths. Initial filenames must safely handle reserved names, Unicode, invalid path characters, and duplicate titles/dates. A renamed or missing managed file is reconciled or flagged, not blindly duplicated or resurrected.

Generated properties include namespaced ownership and meeting IDs, display title, meeting start time, group ID/name, duration, participants, open action count, source update time, and source-deleted status. Use the actual meeting start time for sorting, with a documented created-time fallback when unavailable; never use vault file modification time. An Open in MeetingNotes link uses the existing meeting URL scheme after verifying its contract.

Generate Base and landing templates once. Preserve subsequent Obsidian view customization. Offer a deliberate repair/recreate action rather than overwriting user-customized view definitions during routine sync. Do not edit the vault's `.obsidian` configuration or enable plugins automatically. An existing unmanaged `MeetingNotes` directory or colliding file prompts a safe destination choice instead of being adopted or overwritten.

## Settings and first sync

Use a compact Obsidian card, consistent with the dictionary improvement:

- Automatic sync toggle, off until explicitly configured.
- Vault folder picker plus editable absolute path and validation.
- Destination preview: `<vault>/MeetingNotes`.
- Include action items, default on; include transcript, default off. Never copy audio by default.
- First-sync preview with eligible completed-meeting count, then Enable and sync. Existing completed meetings are included only after this confirmation.
- Small status line with last successful sync and queued/conflict counts; Sync now, Open folder, and details/retry actions.

The chosen vault is an export destination, not the MeetingNotes data directory. Explain that Obsidian Sync, iCloud, Git, or another service managing that vault may distribute exported content outside the Mac. No network connection is needed for MeetingNotes to write locally. Obsidian need not be open; MeetingNotes must be running to sync, with catch-up on startup.

## Sync contract

Initial implementation is one-way: MeetingNotes owns generated meeting content; Obsidian provides browsing and personal annotations. Do not import edited action checkboxes, group properties, or summaries back into MeetingNotes.

Each note has a clearly marked generated block and a separate Personal notes area. Preserve personal text and unknown properties. If an owned block or owned property was edited externally, stop that note's update and show a conflict; do not silently erase the edit. Provide safe comparison/export of the latest source version, with any replace operation explicitly confirmed. Fingerprint checks, atomic file replacement, restart recovery, and tests must cover interrupted and concurrent writes. Keep last successful output until a complete source revision is ready.

Queue sync after processing completes and after relevant title, group, summary, terminology, participant, and action-item changes. Group rename/deletion fans out to affected meetings. Coalesce repeated edits, serialize writes per destination, and compare output hashes to skip unchanged writes. Use durable pending work and bounded startup reconciliation to recover missed notifications. A sync failure must not fail transcription or summarization.

Trashing or removing a source meeting does not delete its Obsidian note or personal annotations. Mark it removed from the source, exclude it from active views, and let restore clear the marker. Preserve already-synced notes when sync is disabled or the vault destination is changed. Never silently sweep old destinations. Missing/unmounted/read-only vaults pause sync and retain queued work rather than recreating a path on another volume.

Resolve and validate the vault and owned subtree, reject symlink escapes and unsafe overlaps with the source library, and write only within the owned destination. Stable workspace ownership must prevent one MeetingNotes library from accidentally adopting another library's exports.

## Acceptance and boundaries

One meeting exists once on disk and appears in both configured views. Group moves and title changes preserve note identity and links. Hundreds of meetings do not expand Settings or block recording. User annotations and unrelated vault files survive sync, failure, restart, and source deletion. Conflicts remain visible and retryable. Initial backfill requires confirmation.

Out of scope: two-way editing, task completion import, audio copying, remote Obsidian APIs, installing plugins, modifying existing daily notes, and publication/release work. A later release request supplies publication authority. These defaults, including property-based groups instead of physical group folders, are proposed for approval.
