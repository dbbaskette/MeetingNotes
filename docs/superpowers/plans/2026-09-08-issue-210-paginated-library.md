# Issue 210 Paginated Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Library payload size and mounted browse rows bounded while preserving global filters, search, counts, status polling, and bulk selection.

**Architecture:** Add stable keyset pagination and lightweight ID hydration in SQLite/IPC, move Library state to query-aware pages, and window the fixed-height browse row slots. Search continues to scan globally and hydrates its result IDs independently of loaded pages.

**Tech Stack:** SQLite/better-sqlite3, Electron IPC, Zustand, React 18, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-meeting-loading-and-library-scaling-design.md`

## Global Constraints

- Branch from merged #209 `main`; no new runtime dependency.
- Page size defaults to 50 and is capped at 100; every order ends with meeting ID.
- Preserve status-bucket precedence, four browse sort choices, global search, filter counts, processing status, trash, recovery, and bulk actions.
- Keep mounted browse rows below 40 for the 1,000-meeting benchmark viewport.
- Do not retain an optimization unless repeated measurements beat run-to-run variation.

---

### Task 1: Stable SQLite page and count queries

**Files:**
- Modify: `electron/main/storage/meetings-repo.ts`
- Test: `electron/main/storage/meetings-repo.test.ts`
- Modify migrations/index definitions only if query-plan evidence requires an index.

**Interfaces:**
- Produces: `listPage(query): {rows:MeetingRow[];nextCursor:string|null}`.
- Produces: `counts(): {all:number;pending:number;processing:number;done:number;failed:number}`.
- Produces: `listIds(filter): string[]` and `findByIds(ids): MeetingRow[]` with 900-ID chunks.

- [ ] **Step 1: Write failing repository tests**

Insert more than two pages with duplicate dates, titles, durations, null values, and every status. For each sort/filter, walk all cursors and assert no missing/duplicate IDs, stable status precedence, deterministic ID tie-breaking, maximum page size, correct global counts, and soft-delete exclusion.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run electron/main/storage/meetings-repo.test.ts`

Expected: paginated methods missing.

- [ ] **Step 3: Implement validated keyset queries**

Map enum values to allowlisted SQL fragments; never interpolate arbitrary input. Use an opaque base64url JSON cursor `{v:1,statusRank,sortValue,id}` and reject malformed/version-mismatched cursors. Fetch `pageSize + 1`, return at most `pageSize`, and derive the next cursor from the last returned row.

- [ ] **Step 4: Verify GREEN and inspect query plans**

Run repository tests and `EXPLAIN QUERY PLAN` fixtures. Add an index only when the plan and benchmark show it reduces work for common newest/status queries.

- [ ] **Step 5: Commit**

Commit repository methods, tests, and any evidence-backed migration as `perf: add stable meeting pagination (#210)`.

### Task 2: Paginated IPC and active-ID hydration

**Files:**
- Modify: `electron/main/ipc/contracts.ts`
- Modify: `electron/preload/index.ts`
- Modify: `electron/main/ipc/handlers.ts`
- Test: `electron/main/ipc/handlers.test.ts`
- Test: `electron/preload/contracts-parity.test.ts`

**Interfaces:**
- Produces: `api.meetings.listPage(query)` returning `{items,nextCursor,total,counts}`.
- Produces: `api.meetings.getMany(ids)` and `api.meetings.listIds(filter)`.
- Removes renderer use of unbounded `meetings.list()` after consumers migrate.

- [ ] **Step 1: Write failing contract/handler tests**

Assert page-size capping, invalid enum/cursor rejection, batch speaker/action-count enrichment only for returned IDs, input ID deduplication/cap, stable result ordering, and library-wide counts.

- [ ] **Step 2: Verify RED**

Run handler and preload parity tests; confirm missing contract failures.

- [ ] **Step 3: Implement boundary validation and summary enrichment**

Use zod schemas at IPC boundaries. Extract one summary-mapping helper used by page and ID hydration. Add repository batch methods for speaker/action metadata restricted to requested IDs if measurement shows the current all-library joins dominate page latency.

- [ ] **Step 4: Verify GREEN**

Run handler/parity tests and both TypeScript builds.

- [ ] **Step 5: Commit**

Commit as `perf: expose paginated meeting summaries (#210)`.

### Task 3: Query-aware Library store and global search hydration

**Files:**
- Modify: `electron/renderer/src/store/meetings.ts`
- Modify: `electron/renderer/src/views/LibraryView.tsx`
- Modify: `electron/renderer/src/components/PipelineStatusBar.tsx`
- Create: `electron/renderer/src/lib/paged-meetings.ts`
- Test: `electron/renderer/src/lib/paged-meetings.test.ts`

**Interfaces:**
- Store produces `items`, `counts`, `total`, `hasMore`, `loadingInitial`, `loadingMore`, `error`, `setQuery`, `refresh`, `loadMore`.
- Pipeline status consumes `getMany(currentId + queueIds)` rather than the Library page.

- [ ] **Step 1: Write failing state-machine tests**

Assert query changes clear old pages, obsolete responses are ignored, duplicate load-more calls share one request, refresh reconciles identities, page errors preserve rows, and overlapping page IDs deduplicate.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run electron/renderer/src/lib/paged-meetings.test.ts`

Expected: helper missing.

- [ ] **Step 3: Implement store and migrate consumers**

Fetch first page for filter/sort changes; load next page near the end; render a retry row on failure. Hydrate all search-hit IDs with `getMany` before applying search sections/counts. Make search result copy state its explicit cap. Change the pipeline bar poll to hydrate only current/queued IDs.

- [ ] **Step 4: Verify GREEN**

Run state, search, selection, poll-gate, and TypeScript tests.

- [ ] **Step 5: Commit**

Commit as `perf: page Library data and hydrate search results (#210)`.

### Task 4: Virtual browse rows

**Files:**
- Create: `electron/renderer/src/components/VirtualMeetingList.tsx`
- Create: `electron/renderer/src/lib/virtual-window.ts`
- Test: `electron/renderer/src/lib/virtual-window.test.ts`
- Modify: `electron/renderer/src/views/LibraryView.tsx`
- Modify: `electron/renderer/src/components/LibraryRow.tsx` only to enforce the documented browse-slot minimum height.

**Interfaces:**
- Produces: `virtualWindow({count,rowHeight,scrollTop,viewportHeight,overscan}): {start,end,offset,totalHeight}`.
- `VirtualMeetingList` renders only indexes `[start,end)` and requests more when the last overscan index approaches the loaded count.

- [ ] **Step 1: Write failing window tests**

Cover top/middle/end windows, zero rows, overscan clamping, viewport resize, and a 1,000-row/700px viewport yielding fewer than 40 mounted slots.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run electron/renderer/src/lib/virtual-window.test.ts`

Expected: helper missing.

- [ ] **Step 3: Implement fixed-slot virtualization**

Use one scroll container, a total-height spacer, absolutely positioned row slots, `ResizeObserver` for viewport height, and passive scroll state updates through `requestAnimationFrame`. Preserve focus by overscanning; if a focused row would unmount, keep that index in the window until focus leaves. Use normal rendering for capped search results with snippets.

- [ ] **Step 4: Verify GREEN and visually inspect**

Run virtual-window tests, TypeScript check, and a local 1,000-row fixture at narrow and desktop widths. Verify scrolling, keyboard focus, row menus, selection, and load-more behavior.

- [ ] **Step 5: Commit**

Commit as `perf: virtualize Library browse rows (#210)`.

### Task 5: Cross-page selection semantics

**Files:**
- Modify: `electron/renderer/src/views/LibraryView.tsx`
- Modify: `electron/renderer/src/lib/selection.ts`
- Test: `electron/renderer/src/lib/selection.test.ts`
- Test: `electron/main/ipc/handlers.test.ts`

- [ ] **Step 1: Write failing selection tests**

Cover select-loaded, select-all-matching snapshot, selection surviving unloaded pages and status refreshes, selected pending partition, deletion confirmation count, failed-item retention, and exclusion of later-arriving rows.

- [ ] **Step 2: Verify RED**

Run renderer selection and handler tests; confirm unloaded IDs are currently lost.

- [ ] **Step 3: Implement exact-ID snapshot selection**

When requested, resolve all IDs for the current filter and store that fixed set. Show “Select all N matching” only when total exceeds loaded count. Partition pending IDs using batch-hydrated summaries. Keep failed operations selected and use exact selected counts in confirmations.

- [ ] **Step 4: Verify GREEN**

Run selection, recycle, handler, and TypeScript tests.

- [ ] **Step 5: Commit**

Commit as `feat: preserve selection across Library pages (#210)`.

### Task 6: Benchmark, document, review, and merge #210

**Files:**
- Create: `electron/main/storage/library-pagination-performance.test.ts`
- Create: `docs/performance/library-pagination-210.md`

- [ ] **Step 1: Add opt-in 1,000/10,000-meeting benchmarks**

Measure old full-list query/enrichment/payload and new first-page/query/count/payload over at least five warm runs plus cold runs. Record median, range, serialized bytes, rows enriched, and query plan. Add a renderer fixture recording mounted row count and scroll-update duration for 1,000 rows.

- [ ] **Step 2: Run and record results**

Use fixed seeded data and identical conditions. Revert any index/memoization/windowing change whose improvement does not exceed variance. Record limitations and discarded attempts.

- [ ] **Step 3: Full verification**

Run renderer type checking, `npm run build`, `git diff --check`, complete isolated-worker Vitest, and relevant UI fixture checks. Restore Electron `better-sqlite3` afterward.

- [ ] **Step 4: Independent review and fixes**

Review cursor correctness, stale-response handling, global semantics, keyboard UX, and benchmark validity. Fix all critical/important findings and rerun affected tests.

- [ ] **Step 5: Push PR and merge**

Push `codex/210-paginated-library`, create a PR closing #210 with measurements, wait for checks, squash-merge, verify closure, fast-forward local `main`, and report both PRs.
