# Obsidian vault sync implementation plan

Status: approved by the user on 2026-10-02; implementation and automated verification complete for 1.13.0. The user also authorized PR/merge, README, release notes, a source-only release, and local installers.

## Approach

Reuse the Markdown rendering concepts in `electron/main/exporters/markdown.ts` and `document-content.ts`, but add a dedicated sync service rather than repeatedly invoking the existing overwrite-oriented exporter. Read meeting and group metadata from the existing repositories. The main agent owns implementation and integrated verification; no delegated agents or repeated approval gates are required.

## 1 Safe destination and rendering

Add `electron/main/obsidian/` modules for vault validation, ownership, filenames, metadata, managed Markdown blocks, and landing/Base/index templates. Inspect existing URL-scheme parsing before generating deep links. Use a supported YAML representation and validate generated syntax; do not interpolate arbitrary titles or group names into executable Base expressions.

Test with disposable vaults: duplicate and hostile filenames, YAML/Markdown escaping, multilingual titles, missing dates, time zones, stable links after rename/group moves, unrelated content, symlink escapes, and overlapping source/destination paths. Verify fixtures render using Obsidian Bases; if Obsidian is unavailable, report that compatibility check as outstanding rather than equating YAML parsing with UI verification.

## 2 Durable sync and preservation

Add a sync repository and additive migration in `electron/main/storage/migrations.ts` for per-destination ownership, per-meeting fingerprints, queued revisions, and conflict status. Add a bounded background queue, reconciliation, atomic writes, and recovery in the sync service. Store manifest state locally, not sensitive runtime credentials or machine paths in public note metadata.

Test idempotency, interrupted writes, app restart, unavailable/read-only vaults, rapid updates, external note edits/renames/deletes, conflicting ownership, settings changes while work is in flight, and preservation of Personal notes and unknown properties. Verify conflict resolution never silently replaces unmanaged files. Bulk work must yield and remain independent of processing success.

## 3 Source change integration

Wire service lifecycle through `electron/main/index.ts`. Implementation refinement: additive SQLite triggers persist source revisions centrally when completion status and meeting/group/speaker/action-item/terminology rows change. This covers the authoritative mutation paths and restart catch-up without adding exports or filesystem scans to `Pipeline.onComplete` or individual IPC listeners. The background worker consumes those revisions in bounded batches.

Test completion, summary editing/regeneration, terminology apply/undo, title changes, speaker naming, action updates, bulk group moves, group rename/delete, source trash/restore/purge, and missed-notification catch-up. Preserve prior exports while reprocessing and sync only complete source revisions.

## 4 Settings and status

Extend `electron/main/storage/settings-repo.ts`, IPC contracts/handlers, and `electron/preload/index.ts` for configuration, folder selection/validation, first-sync preview, status, manual sync, and conflict details. Add a compact component to `electron/renderer/src/views/SettingsView.tsx`, with expanded configuration/details only when needed.

Validate path errors, default-off sync, first-backfill confirmation, explicit content options, privacy copy, read-only status, keyboard operation, progress, retry, cancellation/disable, and failure messages in a disposable UI fixture. Setting a destination must not itself write the full library before confirmation.

## 5 Integrated verification and documentation

Update README usage, ownership rules, privacy, one-way sync limits, conflict handling, and rollback guidance. Run relevant focused checks at slice boundaries, then the full relevant suite once, production build, type checks, and changed-file lint. Use a large disposable library to verify bounded settings height, unchanged-output write suppression, queue responsiveness, and restart recovery. Measure rather than assert throughput.

Verify real grouped/date views against the same canonical files in a disposable Obsidian vault, including link navigation and user view customization. Confirm no changes to the user's actual vault or installed app during development. Report any version-specific Bases limitations. Publication and installers were subsequently authorized by the user.

## Verification evidence

- Full Vitest suite: 982 passed, 6 skipped, 125 passing files and 2 skipped files. Includes 24 new Obsidian tests covering additive v18 migration, collision/ownership/path checks, preservation, conflicts, note/index recovery, disable during a yielded batch, moved/missing notes, unavailable/read-only vaults, source deletion, and restart catch-up.
- 500-meeting fixture: 3,175 ms initial export in the full run; 0.7 ms unchanged pass with no writes. Earlier focused run: 2,728 ms / 1.0 ms. These are local synthetic measurements, not a throughput guarantee.
- Isolated Electron component fixture: preview and explicit enable, reconfiguration, 100 bounded issue rows, conflict/repair confirmations, disable, narrow layout, and focus restoration passed.
- Generated Bases follows official syntax and is parsed in tests. Obsidian 1.13.7 was launched with a disposable profile, but the available UI selector resolved the existing user window rather than the isolated instance. No actions were taken in that vault; the temporary process was closed. Live Base rendering, collapse behavior, and link navigation remain a manual compatibility check, not a claimed pass.
- Production build and renderer/main/preload type checks passed. Final changed-file lint and whitespace verification recorded in the release notes.

## Review focus

Cross-vault writes and symlink escapes; duplicate exports; accidental overwrites; user annotations and checkbox edits; source deletion; group rename fan-out; vault removal or path changes mid-write; failed persistence and stale queue revisions; unsupported Bases behavior; privacy surprises from externally synced vaults.
