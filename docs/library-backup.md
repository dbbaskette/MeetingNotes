# Library backup and safe restore

In **Settings → Storage → Back up Library**, choose a folder outside the active
Library. Review the destination, size and privacy notice, then create the backup.
Recording, processing, exports, vault sync and unfinished saves must finish first;
backup never stops those operations. The queue is held only while idle and resumes
in its prior state. Library changes wait or fail visibly until backup finishes.

The copy includes recordings and stems, externally referenced audio, meeting
folders/exports, speaker data, groups, terminology, action items, Notes History,
and consistent SQLite snapshots of the active Library and canonical settings
database. Model caches are re-downloadable and excluded. Credentials outside the
Library (such as Google OAuth tokens or HF tokens in app support) are not copied;
sign in again after moving machines. Settings may contain webhook secrets and
original paths. Keep the backup private. No cloud upload happens.

`manifest.json` lists every included regular file with its size and SHA-256,
audio path mappings and portable relative links. Database integrity is checked
before success. Changed/missing files fail safely. An `INCOMPLETE` marker remains
in an unfinished destination; never restore it. Original files are never deleted
or overwritten. A failed copy can be inspected or removed manually.

## Restore without overwriting live data

Quit MeetingNotes. Keep your original Library and canonical settings database.
From a source checkout with Node dependencies installed (Node ABI SQLite rebuild
may be needed: `npm run rebuild:node`), run:

```sh
node --import tsx scripts/restore-library-backup.ts /absolute/backup /absolute/NEW-restore-folder
```

The destination must not exist. The script validates hashes, links and databases,
copies only the manifest's data, and rebases audio/session references and Library
settings to the new folder. It does not change the original app or its settings.
Inspect the restored notes/audio, then select `NEW-restore-folder/library` as the
Library path in Settings and restart. The existing canonical settings stay active.
To recover the backed-up settings too, while the app is quit, first preserve the
current `~/Documents/MeetingNotes/db.sqlite` plus its WAL/SHM files, then explicitly
replace that canonical database with `NEW-restore-folder/settings.sqlite` (which
points at the new Library). Do not replace any database while the app is running.
Recheck endpoints, accounts, external watch paths and Obsidian sync before use.

Settings' canonical database currently remains in Documents even when the active
Library is elsewhere. Backup snapshots both actual databases; it does not assume
all persistent data lives under the configured Library path.
