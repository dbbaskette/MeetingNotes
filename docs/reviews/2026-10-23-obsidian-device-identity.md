# Obsidian device identity recovery — 1.19.2

> Built locally as 1.19.2 but never published; the fix shipped in 1.20.0.

## Diagnosis

The configured iCloud vault and its managed sync folder both existed. Their
current folder IDs matched the saved IDs, but their common device number had
changed. The library/destination ownership marker also matched. The old strict
`dev:ino` comparison therefore falsely reported the vault as unavailable and
blocked previewing the same destination.

## Fix and boundaries

Implementation commit: `a6b200c`. Recovery requires both unchanged directory
IDs, the same previous device for both, the same current device for both, a
changed device number, and the exact existing ownership marker. Obsidian
metadata, Notes directory, non-symlink paths and write access still must pass.
The normal enabled sync batch refreshes its existing metadata after all checks;
preview and folder lookup remain read-only. No schema change or destination
adoption is introduced.

Synthetic regressions cover valid restart/recovery, read-only preview, persisted
metadata refresh, changed vault/root IDs, inconsistent devices, wrong library or
destination marker and missing prior root identity. Existing tests retain
replacement, symlink, read-only folder, external-edit and interrupted-write guards.
All 34 Obsidian tests passed.

## Actual destination check

The fixed compiled service successfully previewed the user's real configured
vault using an in-memory copy of only destination metadata. The live database
was opened read-only; no sync run or enable operation was invoked. The saved
database identity and ownership marker were unchanged before/after. No real
meeting content was copied into the test fixture or this record.

## Installer

Local 1.19.2 arm64 package built from `a6b200c`:

- Actual signed package rendered a 600-meeting synthetic Library in normal and
  software rendering; paging, Actions and speaker-review IPC passed.
- All 191 generated application files matched the archive.
- Strict/deep signature, DMG checksum and ZIP integrity passed.
- Apple Development signing, without Developer ID notarization.
- Installed application and live vault were not modified; no capture or installer
  VM test. The loose packaging copy is recoverable from the retained DMG/ZIP.

DMG SHA-256: `0e4e4e815c17564dc8440a41c3802a019729f7c9a5840767b7d8ef442157a72e`.
ZIP SHA-256: `855c56955695bbcd229b67e123305c72b05d5d86b6fd78d5a7c33b1103703a2b`.

## Regression CI

The project Tart quick tier passed at `a6b200c`: all 1,400 regression tests passed,
six optional tests skipped, plus renderer/fixture/main types, build, emitted-module
guard, real startup/IPC, docs and lint. The disposable VM was deleted.
Environment: arm64 macOS 27.0, Node 22.23.2, Electron 44.7.0.
Logs: `~/Library/Logs/MacOS Test Suite/meetingnotes/meetingnotes-test-20261023162152-81134-646fb6a7/`.
Subsequent documentation changes do not alter the tested implementation or
packaged files. The fix and installer are local; no GitHub publication was made.
