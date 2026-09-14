# Library pagination and windowing (#210)

Measured 2026-09-08 on Apple M5 Pro, macOS arm64, Node v25.9.0, SQLite 3.49.2, Electron 30.5.1 / Chromium 124.0.6367.243. No dependency was added.

## Reproduce safely

Run from the repository root. Both commands are opt-in; regular Vitest skips the timing benchmark.

```sh
npm run rebuild:node
MN_LIBRARY_BENCH=1 npx vitest run electron/main/storage/library-pagination-performance.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism --isolate
node scripts/library-pagination-fixture.mjs
npx tsc --noEmit -p scripts/library-pagination-fixture/tsconfig.json
# Restore the native module before launching the application:
npm run rebuild:electron
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e 'const D=require("better-sqlite3");const db=new D(":memory:");console.log(db.prepare("SELECT 1 AS ok").get());db.close()'
```

The database test creates and removes its own temporary SQLite database. The standalone renderer command starts a loopback-only Vite server on port 5198, launches visible synthetic Electron windows with new temporary profiles, and terminates each child after at most 120 seconds. Close anything already using port 5198 first. It never imports the application main or preload, has no Node integration in the renderer, and uses an in-memory fake bridge for every UI mutation. Profiles/screenshots are retained at the printed `ISOLATED_PROFILE` paths for inspection. No live meeting, recording, profile, or database is accessed.

## Method

The fixed seed is 210. Each database has exactly 1,000 or 10,000 live meetings: 80% done and 5% each pending, awaiting-user, processing, and failed; four speaker links (two unidentified) and three action items per meeting. Dates/titles/durations include deterministic duplicates and nulls. All repositories, migrations, IPC validation, summary mapping, scoped joins, and ETA code are real. ETA probes only see absent synthetic files and an empty stage-duration table.

The historical `meetings:list` handler performs the old full-list SQL, all-library speaker/action enrichment, and summary mapping. The new handler performs the default all/newest 50-row page, global counts, and enrichment restricted to those IDs. Both serialize the actual response to UTF-8 JSON. There is one fresh-connection cold sample per path, then seven warm samples in alternating old/new order on the same database/connection. Connection creation, migration checks, and seeding are outside timing. "Cold" means a new SQLite connection, **not** an OS page-cache flush or cold Electron process. Statement preparation and JavaScript mapping remain inside timing; instrumented query/enrichment subtotals exclude the tiny instrumentation bookkeeping itself. Wall time includes it.

## Database results

Warm values are median [minimum, maximum] milliseconds; cold is the single fresh-connection sample.

| Meetings | Path | Cold ms | Warm wall ms | JSON bytes | Summaries | Speaker links / action rows enriched |
|---|---|---:|---|---:|---:|---:|
| 1,000 | old-full-list | 10.030 | 7.875 [7.153, 8.896] | 723,118 | 1000 | 4000 / 3000 |
| 1,000 | new-first-page | 1.316 | 0.630 [0.487, 0.819] | 36,694 | 50 | 200 / 150 |
| 10,000 | old-full-list | 69.838 | 66.273 [63.750, 74.331] | 7,231,327 | 10000 | 40000 / 30000 |
| 10,000 | new-first-page | 1.748 | 1.247 [1.055, 1.558] | 36,793 | 50 | 200 / 150 |

| Meetings | Path | Query + row mapping ms | Counts ms | Speaker/action enrichment ms | Serialization ms |
|---|---|---|---|---|---|
| 1,000 | old-full-list | 1.863 [1.640, 2.653] | — | 3.301 [2.737, 3.588] | 0.430 [0.347, 0.482] |
| 1,000 | new-first-page | 0.154 [0.128, 0.224] | 0.109 [0.093, 0.142] | 0.256 [0.204, 0.357] | 0.023 [0.020, 0.029] |
| 10,000 | old-full-list | 15.886 [14.886, 19.699] | — | 24.485 [23.056, 26.647] | 4.991 [4.252, 5.472] |
| 10,000 | new-first-page | 0.165 [0.100, 0.216] | 0.771 [0.723, 0.949] | 0.258 [0.195, 0.305] | 0.017 [0.015, 0.021] |

At 10,000 meetings the warm median decreases **53.1×**, and JSON bytes decrease **99.49%**. The old/new wall-time ranges do not overlap at either size. These are first-page gains, not a claim that every Library operation has constant cost.

### Remaining proportional work

The real `hydrateAttentionMeetings` helper queries three status-ID snapshots and hydrates them in batches of at most 1,000 IDs. The real paged store refreshes the entire loaded prefix to rebuild a consistent cursor chain. The following include serialization of every IPC response (including ID lists), but not actual Electron transport or renderer painting.

| Library size | Operation | Warm wall ms | JSON bytes across calls | Summaries / speaker links / action rows | Page calls / global count calls |
|---|---|---|---:|---|---|
| 1000 | global-attention | 3.057 [2.901, 3.602] | 150,131 | 200 / 800 / 600 | 0 / 0 |
| 1000 | refresh-prefix-50 | 0.421 [0.406, 0.545] | 36,694 | 50 / 200 / 150 | 1 / 1 |
| 1000 | refresh-prefix-500 | 5.979 [5.882, 6.508] | 365,888 | 500 / 2000 / 1500 | 10 / 10 |
| 1000 | refresh-prefix-1000 | 10.939 [10.297, 12.058] | 728,115 | 1000 / 4000 / 3000 | 20 / 20 |
| 10000 | global-attention | 30.554 [30.090, 35.065] | 1,501,090 | 2000 / 8000 / 6000 | 0 / 0 |
| 10000 | refresh-prefix-50 | 1.069 [1.048, 1.107] | 36,793 | 50 / 200 / 150 | 1 / 1 |
| 10000 | refresh-prefix-500 | 11.089 [10.828, 14.884] | 367,283 | 500 / 2000 / 1500 | 10 / 10 |
| 10000 | refresh-prefix-1000 | 22.045 [21.923, 22.190] | 742,109 | 1000 / 4000 / 3000 | 20 / 20 |

Global attention therefore grows with the actionable set (200 → 2,000 summaries here), not the visible 50-row page; it takes three ID queries plus one/two get-many calls. The Library now hydrates that set with `{ shell: true }`, skipping speaker/action joins and ETA probes, and the panel caps each group at 8 rows. A 1,000-row loaded prefix still issues 20 page queries, but continuation pages reuse the first-page `counts()` snapshot instead of scanning the live table 20 times. Loaded renderer state can grow to the whole library. All-matching selection ID snapshots and selected-summary hydration also grow with the selected set.

Pipeline/arrival/mutation notifications now invalidate a lifecycle-owned attention controller rather than starting parallel full snapshots. It retains one outstanding operation and one latest pending invalidation, stops obsolete ID/hydration work at IPC boundaries, and publishes only the latest result. The deterministic 100-notification/2,000-actionable-ID regression holds the first hydration batch unresolved: it observes six ID queries (two snapshots), three 1,000-ID hydration calls (one obsolete batch plus two latest batches), maximum hydration concurrency one, and one latest publication. Ordinary refresh calls deduplicate without forcing another snapshot. Cleanup also stops future batches; a failed ID query cannot release the controller while its sibling queries are outstanding.

The paged store likewise distinguishes ordinary refresh from semantic invalidation. Notifications during a loaded-prefix refresh discard the obsolete chain and coalesce into one trailing fresh rebuild, keeping the previous rows/counts until the latest prefix is ready. A refresh also waits for an obsolete load-more IPC before starting its replacement chain. Terminal and arrival regressions each inject 100 invalidations after page one has been collected while page two is unresolved, and require the final rows/counts without relying on another polling tick.

## Query-plan evidence and index decision

The test captures SQL and bound parameters from the actual repositories, then emits `EXPLAIN QUERY PLAN` details with its results:

- Old full list: `idx_meetings_deleted (deleted_at=?)` plus `USE TEMP B-TREE FOR ORDER BY`.
- New newest first and second pages: `idx_meetings_browse_newest (deleted_at=?)`, no temporary sort.
- Title sort: the browse index plus `USE TEMP B-TREE FOR LAST 3 TERMS OF ORDER BY`.
- Counts: `idx_meetings_deleted (deleted_at=?)`; every live row still contributes.
- Scoped speakers: `sqlite_autoindex_meeting_speakers_1 (meeting_id=?)` plus speaker primary-key join.
- Scoped actions: covering `idx_action_items_meeting (meeting_id=?)`.

Migration 16 is tested separately by dropping/recreating only that index in the temporary fixture. Each schema change has one equal untimed primer, followed by one measured query; seven alternating indexed/unindexed pairs use the same all/newest 50-row workload.

| Meetings | No browse index ms | Composite browse index ms | Median decrease | Sum of both full ranges |
|---|---|---|---:|---:|
| 1000 | 0.215 [0.210, 0.244] | 0.091 [0.090, 0.099] | 0.125 ms | 0.043 ms |
| 10000 | 0.863 [0.811, 0.901] | 0.092 [0.090, 0.095] | 0.771 ms | 0.094 ms |

The index benefit exceeds even the sum of both full observed ranges, so it remains. This removes sorting; the lexicographic OR cursor can still scan earlier index entries on deep pages. No constant-cost deep seek, title/oldest/longest sort speedup, or index write/storage benefit is claimed.

### Near-end continuation evidence (final-review rerun)

The opt-in benchmark now walks real 50-row cursors to 100 rows before the end **outside the measured samples**, then repeats that exact continuation seven times. At 10,000 rows this is the cursor after row 9,900, returning rows 9,901–9,950; at 1,000 rows it is after row 900. Each measured operation still includes the real page handler, global counts, scoped enrichment and JSON serialization. This final rerun was performed separately from builds/UI fixtures; previous tables above retain the original measurements rather than mixing runs.

| Meetings / rows before cursor | Warm wall ms, median [min, max] | Query + row mapping ms | Counts ms | Enrichment ms | JSON bytes |
|---|---|---|---|---|---:|
| 1,000 / 900 | 0.462 [0.453, 0.486] | 0.161 [0.159, 0.173] | 0.085 [0.084, 0.089] | 0.178 [0.176, 0.195] | 36,342 |
| 10,000 / 9,900 | 1.367 [1.336, 1.434] | 0.404 [0.385, 0.452] | 0.754 [0.745, 0.773] | 0.180 [0.173, 0.209] | 35,219 |

The seven 10,000-row continuation wall times were 1.417, 1.336, 1.408, 1.434, 1.365, 1.362, and 1.367 ms. Every call returned 50 summaries, enriched 200 speaker links and 150 action rows, and issued one global count query. The emitted actual SQL/parameters use status rank 4, a null started-at sort value, ID `meeting-07871`, and limit 51. Its actual plan is:

```text
SEARCH meetings USING INDEX idx_meetings_browse_newest (deleted_at=?)
```

There is no temporary sort and no cursor-key range seek in that plan: cost remains proportional to earlier live index entries that the OR predicate may examine, plus global counts. The same rerun's 10,000-row first-page query median was 0.176 ms [0.105, 0.187], versus 0.404 ms [0.385, 0.452] near the end. The deep-query increase is measurable, although overall handler ranges overlap (first page 1.283 ms [1.054, 1.371]). The measured worst near-end handler sample, 1.434 ms, is acceptable for a 50-row continuation on this 10,000-row synthetic library; it does **not** establish constant-cost scaling or a latency guarantee at larger sizes/concurrent writes. No new index was attempted or added: there is no measured candidate improvement beyond variance to justify one.

## Renderer fixture

The isolated renderer uses 1,000 synthetic long-title rows with all five statuses, four speaker labels, and three action items. It compares the same LibraryRow component/data in a normal 72px-spaced list versus VirtualMeetingList, with a 700px browse viewport. Both use existing memoization; no new row memo was added. Seven warm paired reloads alternate comparison order, with an initial comparison reported separately. React development Profiler timing sums all initial commits, including the initial ResizeObserver update. The scroll probe moves to row 500 and waits for the scroll event plus three animation-frame callbacks, recording both elapsed wall time and React update work.

| Mode | Initial React work, warm ms | Scroll React work, warm ms | Scroll + frame-wait elapsed, warm ms | Mounted top / middle |
|---|---|---|---|---|
| plain | 92.300 [85.200, 98.900] | 0.000 [0.000, 0.000] | 76.500 [76.000, 76.900] | 1000 / 1000 |
| virtual | 4.500 [4.000, 5.700] | 4.200 [2.900, 4.500] | 77.500 [77.400, 79.000] | 15 / 20 |

At both 900px and 1440px window widths, mounted virtual rows are **15 top, 20 middle, 15 end, and 21 with a distant focused/dialog-owned row pinned**. The mandatory fewer-than-40 budget passes. Initial React work improves far beyond sample variation. Scroll wall time does not show an improvement; the normal list scrolls without React commits, while windowing incurs small updates to keep its DOM bounded. Frame-wait timing is not a production INP or frame-rate measurement.

The runner additionally asserts 64px row bodies with 8px gaps and no horizontal overflow, viewport resize, selection after scrolling, navigation, menu portals, Rename autofocus/unsaved value retention after focus leaves, pin release, native Tab past the overscan edge, one load-more request despite duplicate calls, retained rows after failure, reachable Retry, and successful retry. Screenshots at both widths were visually inspected.

## Selection UI checks

The second isolated page mounts the real LibraryView and shared selection store with 120 fake meetings. The complete scenario passes:

- Select all loaded selects exactly 50 IDs; loading another page leaves those 50 unchanged.
- Select all 120 matching resolves a fixed 120-ID snapshot; a later arrival, another page, a Processed filter, and global search do not expand or prune it.
- After clearing, search's Select all loaded selects exactly its two result IDs without a global browse-ID query; no all-matching control is shown in search.
- A backend status change between display and click changes the pending confirmation from the displayed 12 to exactly 11; Cancel receives initial focus. Process sends those 11 exact IDs, succeeds for 10, and retains the failed ID plus all non-pending selections.
- Delete confirms exactly 110 selected IDs, including off-page rows; 108 succeed, one rejects, and one returns false (already deleted/no-op). Only the two unsuccessful IDs remain selected.
- Undo sends exactly the 108 newly deleted IDs; neither the rejected nor the no-op ID is restored. The final painted UI still shows two selected IDs.

## Retained/discarded attempts

| Attempt | Evidence | Decision |
|---|---|---|
| Paginated summary payload + scoped metadata | 10k: 66.273 → 1.247 ms; 10,000 → 50 summaries; non-overlapping ranges | Retain |
| Composite equality/status/newest/ID index | Isolated index pairs above; improvement exceeds observed variation | Retain migration 16 |
| Fixed-slot windowing | 1,000 → at most 21 mounted rows; initial React work improvement exceeds both ranges | Retain |
| Partial expression index from Task 1 | On its separate 10k/95%-done fixture, all-filter medians 0.827 → 0.832 ms; pending 0.415 → 0.417; processing 0.475 → 0.476; done 0.906 → 0.902. Ranges overlapped and SQLite kept the old index/temp sort. | Discarded before Task 1 commit; not shipped |
| Additional memoization or sort indexes | No additional speculative implementation attempted; existing pre-210 memoization is unchanged | None added |

The partial-index numbers above are historical Task 1 measurements, not directly comparable to the seed/distribution used by this committed end-to-end benchmark.

## Verification and limits

Renderer type checking, strict fixture type checking, production build, whitespace diff check, the opt-in database benchmark, both isolated UI fixtures, and the complete isolated single-worker suite pass. After the final-review fixes, the suite reports 113 files passed / 2 skipped, 896 tests passed / 5 skipped; the timing fixtures account for opt-in skips. Production output is 519.70 kB JS (153.56 kB gzip) and 59.68 kB CSS (10.02 kB gzip); Vite retains its existing >500 kB chunk warning. Electron's native better-sqlite3 ABI is restored and verified separately after Node tests.

This is a synthetic, single-machine, low-noise snapshot, not a production latency guarantee. The database benchmark excludes IPC structured cloning, actual renderer transport, audio/transcript content, OS-cold I/O, real stage-duration history, and concurrent pipeline writes. JSON bytes are a consistent payload proxy, not Electron wire bytes. The fixture uses development React/Vite (including development CSP warnings), not the packaged application, and fixed heights/window sizes are not coverage of every zoom/accessibility setting. Status/sort updates are live, not a database snapshot; the store rebuilds loaded cursors on refresh, but changes between pages can still move rows. Search is explicitly capped at 100 hits and remains non-virtual. No live-data or network integration behavior is asserted by the synthetic mutation bridge.
