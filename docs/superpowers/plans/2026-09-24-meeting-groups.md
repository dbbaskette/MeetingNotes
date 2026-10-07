# Implementation plan — meeting groups

Design approved. Implementation is local; publication and release are not part of this request.

## 1. Storage and queries

- Add migration 17 in `electron/main/storage/migrations.ts`: groups table, unique normalized name, nullable meeting/session group references, indexes, and safe delete behavior. Add a `GroupsRepo` for CRUD and counts; extend `MeetingsRepo` with assignment and scope-aware `listPage`, `counts`, `listIds`, and hydration.
- Keep group assignment on soft-deleted rows; delete-group transaction clears meeting/session references, never audio. Add migration and repo tests for upgrade from v16, duplicate names, rename, delete, bulk partial failures, null/unknown groups, paging/cursor invalidation, and soft-delete/restore.

## 2. IPC and search

- Add strict schemas/channels in `electron/main/ipc/contracts.ts`, handlers in `electron/main/ipc/handlers.ts`, bridge methods in `electron/preload/index.ts`, and typed client methods. Do not accept paths or raw SQL. Extend meeting summaries with group information.
- Pass scope into inline Library search at the indexed search stage before hit limiting; leave the quick-search palette global and annotate results. Test search scope, caps, contract parity, invalid inputs, and cross-scope cursor rejection.

## 3. Library and detail UI

- Add a reusable `GroupPicker` and create/rename/delete dialogs styled with existing tokens. Wire the Library scope selector in `LibraryView.tsx`; keep Needs attention and queue global. Scope the existing status chips, sort, count, search, pagination, and select-all-matching consistently. Persist only the selected scope ID in local UI preferences and recover gracefully if it disappears.
- Add `Move to group…` to `MeetingRowMenu.tsx`, the detail header, and bulk selection actions. Include a reversible toast with exact successful assignments; keep failed IDs selected for retry. Add row metadata only in All view. Handle focus, Escape, narrow widths, long names, large group lists, and empty states.
- Add component/integration tests for switch/create/rename/delete, row/bulk move, scoped search, and selection behavior.

## 4. Capture integration

- Add the optional Save to group control to `SourcePicker.tsx` and a small equivalent chip to `MeetingDetectedBanner.tsx`; thread selection through `RecordButton.tsx` and the active recording state in `App.tsx` into recording start. Preselect a named Library scope but never require a group. Preserve it through `LiveRecordingRow.tsx` restart/fallback. Persist the group ID when creating the recording session in the main process; catalog it with the meeting using the session output path. The watcher and recovery must agree and be idempotent.
- Test start/stop, watcher-first versus stop-first, restart recovery, group deletion mid-capture, detected-banner start, restart/fallback, and source-picker keyboard behavior. Verify capture still starts in one source click.

## 5. Verification and handoff

- At functional milestones run targeted storage, IPC, search, capture, and renderer tests. Then run the full relevant suite, type checks, production build, and existing Library pagination performance fixture once on the final source tree. Compare scoped versus unscoped page/count latency; no material regression at 1,000+ meetings.
- Manually inspect light/dark and narrow/standard windows, a populated and empty group, a long name, row/detail menus, recording picker, recovery, and assistive keyboard navigation. Update README's Library/capture description and record any measured limitations in the PR.
