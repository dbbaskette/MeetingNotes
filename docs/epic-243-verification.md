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
  incomplete destinations retain a marker and cannot be restored. The inventory
  is rechecked under the write lock so files added after Preview require a fresh
  preview; validation also requires a mapping for every database audio reference.

## Targeted host milestone

Node 25.9.0, arm64 host. 51 focused tests pass across recording, catalog,
summary-title race, search and data/backup suites. Earlier milestones cover
weekly freshness/calendar, IPC contracts, browse state and group revisions.
Types pass for main/renderer/fixtures; scoped lint has no errors (warnings are
reported, not represented as clean lint).

The final clean-Mac fixture records an alternating four-sample 12,000-line/
~6.6-hour synthetic transcript comparison against `1be1704`, warm-up excluded:
12,000 → 17 mounted rows; median initial React work approximately 142.7 → 9.9 ms;
median playback-update work 14.6 → 4.5 ms. Process working-set and JS heap samples
are retained, but renderer reuse/GC makes them noisy, so no isolated memory-saving
claim is made. Search burst: 30 rapid requests, maximum one child, 29 cancelled,
21 ms elapsed in the clean Mac. Running-child cancellation and timeout have
distinct assertions. These are synthetic workloads, not production guarantees.

Logs: `/private/tmp/meetingnotes-epic243-final-targeted.log`,
`/private/tmp/meetingnotes-epic243-data-tests.log`,
`/private/tmp/meetingnotes-epic243-boundary-final.log`, and
`/private/tmp/meetingnotes-epic243-final-backup-search.log` (51 final backup/search
tests). Fifteen summary-stage tests also pass after lint-safe mock typing.

## Full clean-Mac gate

First run `1ba13e1` reached 1,189 passing tests (six skipped), but failed one
existing watcher retry fixture before later gates could run. That failure is
not a full pass. An isolated host reproduction passed all ten watcher tests;
the polling fixture now lets its known initial-stat polling periods establish
the baseline before asserting delivery of a subsequent change and always
closes the watcher on failure. Assertions and product watcher behavior are
unchanged. Review additionally protected automatic vault-sync starts and the
structured Weekly metadata-cache write from the backup lock. Targeted
Obsidian/watcher/backup tests pass (42 tests); capture/source fixtures verify
title retention across Refresh and explicit restart.

An infrastructure-only retry failed before tests with a Virtualization framework
boot error. Run `541df02` then passed all 1,193 tests (six skipped), native audio,
types and production build, but stopped at five legacy `any` annotations in the
changed summary test file. Those mock annotations are now typed; no lint rule or
assertion was bypassed. A stale search completion hint is also hidden once browse
mode resumes. Intermediate runs are not represented as complete gates. Their
exact disposable VMs were removed. Temporary scratch cleanup removed some earlier
UI/CI logs; the final complete evidence is kept in the ignored workspace folder.

The complete shared Tart gate passed on `828158e41f82ff4157c38b41bc8ddaeb603bf9c3`,
tree `b09ca8f19fecc03e3469dc6d8663a5d98a233ff3`, in a disposable standalone clone
with Git history retained for baseline benchmarks. Environment: macOS 27.0
(26A428), arm64, Node 22.23.2, Electron 30.5.1.

- 1,193 tests passed; six skipped (147 files passed, two skipped).
- Native AAC/timeline/TTS synthetic checks, main/preload/renderer/fixture types,
  production build and scoped changed-file lint passed (zero errors, 12 warnings).
  This is not a claim that unrelated repository-wide lint has no existing errors.
- Browse benchmark preserved identical output: 1,000 meetings median 5.01 → 1.25
  ms; 10,000 meetings 61.88 → 10.57 ms, 500 groups, versus the existing benchmark
  baseline. This reuses the delivered browse optimization, not a new #243 claim.
- All eight renderer fixtures passed: rows, selection, grouped, startup, settings,
  sources, capture and epic243. Rows include busy deletion, unsaved rename
  retention and restored trigger focus; epic243 covers both transcript modes,
  whole-text Find/distant seek/manual scroll, narrow width/zoom/dark mode,
  nested/busy keyboard dialogs, task rollback/Retry and backup preview/progress.

Final renderer key-fencing rerun passed at
`68ca305feaac83125c3996704df174f635e42c7c`, tree
`3c18297fc58d9a5875668377d5def5ab62d2cc28`, in the same clean-Mac environment.
Types, production build, scoped lint (zero errors, 13 warnings) and all eight
fixtures passed again, including hidden-view/dialog J/K isolation. Backend/native
evidence above is reused because its source is unchanged. The final documentation-only
commit does not alter the verified runtime. Neither the user's checkout nor
installed app, library or credentials are used by guest fixtures. Source-only
gate; no installer or real inference/account integration acceptance is claimed.

Retained complete log directory:
`/Users/dbbaskette/Projects/MeetingNotes/.worktrees/fix-recovery-actions/.ci-epic243-results/meetingnotes-test-20261007144258-24876-26394187`.
Includes environment, checks, test/build/lint/native/renderer logs and
`epic243-benchmark.json`; PASS and cleanup are recorded. The disposable VM was
deleted; the stopped base was not modified.

Final renderer log directory:
`/Users/dbbaskette/Projects/MeetingNotes/.worktrees/fix-recovery-actions/.ci-epic243-results/meetingnotes-test-20261007144843-43644-67afc23d`.
The final transcript benchmark repeats the improvement: initial median
141.4 → 9.8 ms, playback median 13.7 → 4.1 ms; 17 mounted rows. PASS and
disposable-VM deletion are recorded for this run too.

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
