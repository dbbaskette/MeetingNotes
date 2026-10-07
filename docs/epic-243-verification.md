# Epic 243 verification

Scope: #243 and #165, #164, #214, #233, #213, #229, #236, #234, #9,
#212, #211, #181, #195, #182, #235. Base `1be1704`, branch
`codex/epic-243`. Version remains 1.14.0. No release, installer, installed-app
replacement, real recording, account export, or live-library restore is requested.

## Implementation and acceptance evidence

- Weekly: shared local-calendar ISO weeks, UTC new instants, legacy naive
  imports read locally/built-in recording clocks read in UTC without rewriting
  historical rows. Timezone/DST/year-boundary fixtures cover five zones and
  167/169-hour weeks. Cache hashes actual notes/tasks/roster content. Concurrent
  normal/forced requests join; an edit during generation prevents stale caching.
- Dialogs/navigation: shared focus/inert/topmost Escape lifecycle, focus and
  text selection survive rerender; busy and nested behavior are exercised.
  Library/Weekly stay mounted while inactive, preserving scroll, loaded state,
  query/week and expansions. Only sanitized lightweight preferences persist;
  a query persists across relaunch only through explicit named-filter Save.
- Organization: keyboard row/checkbox actions are isolated, selection mode is
  visible, new arrivals have a one-time baseline and explicit acknowledgment,
  inline Move uses fixed IDs and confirmation, three recent successful
  destinations are deduplicated/pruned. Group badges come from bounded SQL
  aggregates and declare their full-group scope. Native editor Undo wins over
  group Undo; each toast owns its operation and revisions reject ABA/later moves.
- Recording titles: normalized title intent is persisted before spawn and
  source labels remain independent; recovered/watcher cataloging preserves it.
  Explicit restart retains it and Stop offers optional Rename. A generation-time
  user rename is protected even when its title resembles a default filename.
- Search: clients own and cancel subprocesses independently, replacement waits
  for actual child exit, sender destruction cancels owned work, and stale request
  IDs cannot kill a newer search. Complete/partial/limited/failed/cancelled results
  are distinct. Facets are validated and bound before title/file caps; shared UI
  includes removable chips and explicit local Save/rename/delete of named filters.
- Transcripts: bounded measured variable-height rows in both modes, existing
  parent scrollbar, full-text Find/Cmd+F/copy/export, distant seek/search, focus
  retention, manual-scroll pause, correction height invalidation. Narrow width,
  zoom and dark-mode checks are synthetic, not claims about a real call.
- Tasks: exact deleted identity/provenance/owner/date/status/export metadata
  can be restored; revision fencing refuses newer intent. Weekly completion,
  owner/due edits, snooze, local date filters, rollback/Retry and source note
  preserve “You” grouping and refresh structured counts/narrative freshness.
- Backup: actual canonical settings plus relocated library databases use
  SQLite snapshots; regular files and external audio/stems are copied without
  model caches. Idle/write coordination protects the consistent snapshot.
  Preview, progress, missing/changed-file failure, checksums/path validation and
  restore into a NEW disposable destination are tested. Originals stay unchanged;
  incomplete destinations retain a marker and cannot be restored.

## Targeted host milestone

Node 25.9.0, arm64 host. 51 focused tests pass across recording, catalog,
summary-title race, search and data/backup suites. Earlier milestones cover
weekly freshness/calendar, IPC contracts, browse state and group revisions.
Types pass for main/renderer/fixtures; scoped lint has no errors (warnings are
reported, not represented as clean lint).

Host UI log: `/private/tmp/meetingnotes-epic243-ui.log`. Alternating four-sample
12,000-line/~6.6-hour synthetic transcript comparison against `1be1704`, warm-up
excluded: 12,000 → 19 mounted rows, median initial React work approximately
135.5 → 9.0 ms. Process working-set and JS heap samples are retained; renderer
reuse/GC makes them noisy, so no isolated memory-saving claim is made. Playback
update samples are recorded by the final fixture. Search burst: 30 rapid requests,
maximum one child, 29 cancelled, approximately 12 ms on this host. Running-child
cancellation and timeout have distinct assertions. These are synthetic workload
results, not production latency guarantees.

Logs: `/private/tmp/meetingnotes-epic243-final-targeted.log`,
`/private/tmp/meetingnotes-epic243-data-tests.log`,
`/private/tmp/meetingnotes-epic243-boundary-final.log`.

## Full clean-Mac gate

Pending. The existing shared Tart wrapper will test a committed, disposable
standalone Git clone (history retained for baseline benchmarks), not the user's
checkout, installed app, library or credentials. Source-only gate; no packaged
installer or real inference/account integrations are claimed for this epic.

Dependencies are unchanged. Prior audit: 49 findings (2 low, 8 moderate, 35 high,
4 critical, including development dependencies); this is not a clean audit or
exploitability assessment. No unreviewed dependency upgrade is applied.

## Owner spot checks after a later build

1. New Ungrouped meeting → inline Move → confirm → selection clears → Undo;
   move it again and verify older Undo does not overwrite that move.
2. Search with date/speaker/task filters, open a result, Back; verify retained
   query/scroll/groups and explicit named-filter persistence after relaunch.
3. Long transcript: Find a late term, seek/play, manually scroll, switch Grouped;
   check text, timing, correction display and keyboard arrows.
4. Weekly: complete/change due date/owner/snooze; verify source, “You”, counts,
   overdue dates and refreshed narrative. Delete a detail task and Undo it.
5. Keyboard dialogs: Tab/Shift+Tab, Escape, nested confirmation and focus return.
6. Optional recording title, source refresh/restart and Rename after Stop.
7. With recording/processing/sync idle, preview and create a private backup;
   follow `docs/library-backup.md` to validate/restore only to a NEW test folder.
   Do not overwrite the active library. Keep a pre-upgrade closed-app copy.

Migration 22 adds title intent and revision guards; it does not relocate audio
or rewrite old timestamps. Downgrade/rollback should use the preserved complete
pre-upgrade library rather than assume an older binary understands new columns.
