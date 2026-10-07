# Obsidian vault sync

MeetingNotes can maintain a one-way Markdown copy of completed meetings in an existing local Obsidian vault. No account, network endpoint, community plugin, or extra processing service is required. Sync is off until you enable it.

## Set up

1. Create/open a vault in Obsidian first. Its root must already contain `.obsidian/`.
2. In MeetingNotes, open **Settings → Obsidian sync → Configure…** and choose that root folder.
3. Keep the default `MeetingNotes` subfolder or choose an unused name. An unrelated existing folder is never adopted. Keep the vault separate from the MeetingNotes source library.
4. Choose content: action items are included by default; transcripts are off. Audio is never copied.
5. Choose **Preview sync**, check the completed-meeting count and destination, then **Enable and sync**.
6. Open `MeetingNotes/Meetings.md` in Obsidian. Enable its built-in **Bases** plugin to use the embedded table.

Only the dedicated subfolder is managed. The integration does not change `.obsidian` settings, enable plugins, create a missing vault, or install Obsidian. A missing/replaced/unwritable vault pauses sync; restore it and choose **Sync now / retry**.

## One file, several views

```text
Your vault/
  MeetingNotes/
    Meetings.md       landing page (customizable)
    Meetings.base     By group / By date / Ungrouped (customizable)
    Browse.md         generated link-only fallback
    Notes/            one stable Markdown file per meeting
```

Group names and IDs are properties on each note, not duplicate folder copies. Renaming a meeting, moving it between groups, or renaming/deleting a group updates its properties without changing its existing filename. The note links back to MeetingNotes using its stable meeting ID.

The date is the meeting start time, falling back to its creation time, normalized to UTC—not file modification time. By date sorts newest first. The fallback Browse index puts Ungrouped first; Bases uses its own alphabetical group ordering and is not an exact replica of the Library interface. Both views link to the same notes. A Base is restricted to its own sync folder so old destinations do not appear as duplicate rows.

The templates follow [Obsidian's documented Bases syntax](https://help.obsidian.md/bases/syntax). YAML/schema checks are covered automatically; live rendering in an isolated Obsidian window remains a manual compatibility check. Use `npx tsx scripts/obsidian-fixture.ts` to generate a disposable vault for that check.

## What stays in sync

While MeetingNotes is running, a background queue checks for completed meetings and updates approximately every five seconds. It catches changes to titles, groups, participants, summaries, terminology corrections, and action items. Durable database revisions catch up after restarts and while sync was disabled. Batches process at most 100 meetings and yield between notes; unchanged text is not rewritten. Reprocessing preserves the previous completed export until new notes are ready.

`mn_` properties contain meeting identity, title, date, group, participants, duration, open-action count, removal state, and stale-summary status. They do not contain credentials or machine paths. Notes and the local sync journal may contain sensitive meeting text: include the database in your protected library backups.

## Your annotations and conflict review

- Add text under **Personal notes**, outside the generated markers. Additional YAML properties are preserved.
- Treat the generated section and `mn_` properties as read-only. Changing a task checkbox in Obsidian does **not** update MeetingNotes; it creates a conflict when the next source change is synced.
- **Configure… → Review note** compares the current vault file with the latest export. You can save the latest version to a new file, or explicitly replace the generated content. Replacement preserves personal sections and unknown properties and saves the exact prior file as a `.backup` first.
- A comparison becomes invalid if either side changes before replacement. Changed ownership or broken markers prevent automatic replacement.
- Renames within `Notes/` can be reconciled by meeting identity. A missing file or a move outside that folder is reported; deleted exports are not silently recreated. Restore the file/path before retrying. Duplicate identity matches require manual resolution.
- `Meetings.md` and `Meetings.base` are created once and can be customized. `Browse.md` is generated; editing/removing it pauses index updates but does not stop individual meetings. **Recreate views…** requires confirmation and backs up existing view/index files before replacing them.

Writes use a durable before/after journal, a same-folder temporary file, and a final comparison before atomic replacement. This protects ordinary interrupted writes and detected concurrent edits; it is not a cross-application locking protocol. Avoid editing generated sections while a sync is active. Keep a vault backup/version history as well.

## Disabling, changing destinations, and removing meetings

Turning automatic sync off leaves all exports in place. Changing the vault or subfolder requires another preview and confirmation; the old destination is retained, and the new one gets its own manifest. There is intentionally no automatic cleanup of the old folder.

Trashing or permanently removing a source meeting retains its exported note and annotations, sets `mn_removed: true`, and excludes it from active views. Restoring a trashed meeting brings it back into those views. This integration is not a deletion mirror or an Obsidian-to-MeetingNotes editor.

## Limits and privacy

- Exports/read text are limited to 12 MB per note; turn transcript inclusion off for very large meetings. Automatic rename reconciliation is limited to 5,000 files in `Notes/`.
- Symbolic links inside the owned sync tree are rejected. The vault and owned-folder identities are checked to detect replaced mounts/folders.
- Up to 100 issues are displayed at a time in the bounded Settings dialog. Resolve these and retry to work through a larger backlog.
- Choosing a vault opts into writing meeting content there. Obsidian Sync, iCloud, Dropbox, Git, or another service attached to that vault may then distribute it externally. MeetingNotes does not control that service.
- Settings/component fixtures are synthetic; they do not enable sync against your real vault. The installed Obsidian version discovered during development was 1.13.7, but the automation selector could not isolate its second instance from the existing user window. No real vault was modified; live Base rendering/link navigation is not claimed as verified.

## Upgrade and rollback

Version 1.13.0 introduces additive database migration 19 for sync ownership, revisions, and write journals. Back up your entire library (including `db.sqlite`, with the app closed) and vault before upgrading. No recordings are moved.

To stop the feature, disable sync. For a full rollback to 1.12.8, quit MeetingNotes, preserve the current library and vault, and restore your pre-upgrade library backup together with the older app. Downgrading the app alone does not reverse migration 19 or remove exported files. Do not delete journal tables or ownership files to resolve conflicts.

Developer checks: `npx vitest run electron/main/obsidian/service.test.ts`, `node scripts/obsidian-ui-fixture.mjs`, and the normal project build/type checks. Fixtures create only temporary data; generated preview directories are disposable.
