# Meeting Loading and Library Scaling Design

## Scope

This design covers GitHub issues #209 and #210 in two sequential,
independently measured pull requests. #209 reduces work performed when a meeting
opens. #210 bounds Library query payloads and rendered rows. No new runtime
dependency is required.

## #209: Meeting detail artifacts

The initial `meetings:get` response becomes a lightweight shell: database-backed
meeting fields, action items, models, audio path, basic speaker links, and the
summary. It must not read `transcript.md`, `transcript.raw.json`, or
`diarization.json`. Summary loading uses asynchronous filesystem APIs so it does
not block the Electron main event loop.

Two additive endpoints load optional content:

- `meetings:get-transcript(id)` returns `{ transcriptMd, rawTranscriptText }`.
  The renderer calls it only when the Transcript tab is selected or when a
  transcript search navigation opens the detail view.
- `meetings:get-speaker-review(id)` returns the review-enriched speaker array.
  The renderer requests it after the shell has painted. Until it arrives, the
  existing speaker rail shows basic links with a small loading state.

The renderer tracks an independent generation for each request so responses for
an old meeting cannot overwrite a newly opened one. Artifact failures show a
retry action without replacing already-loaded shell content. Processing-stage
changes continue to use the lightweight status endpoint; a stage change refreshes
the shell, and only reloads transcript/review content that has already been
requested by the current view.

An `ArtifactCache` owns asynchronous reads and JSON parsing. Entries are keyed by
absolute path plus size, modification time, and change time. It stores in-flight
promises to deduplicate concurrent reads and uses a 64 MiB least-recently-used
budget. Missing files are represented as null and invalidated when their stat
fingerprint changes. Summary saves, transcript merges, speaker assignments, and
pipeline artifact clearing explicitly invalidate affected entries in addition to
fingerprint validation. Cache behavior is process-local; disk remains the source
of truth.

A reproducible multi-hour fixture measures: initial shell latency, event-loop
delay, transcript load latency, warm-cache latency, bytes read, and IPC payload
size. JSON parsing moves to a worker only if repeated measurements show a
main-thread task above 50 ms; otherwise that complexity is not retained.

## #210: Paginated and virtualized Library

`meetings:list-page` accepts a validated `LibraryQuery`:

```ts
interface LibraryQuery {
  filter: 'all' | 'pending' | 'processing' | 'done' | 'failed';
  sort: 'newest' | 'oldest' | 'longest' | 'title';
  cursor?: string;
  pageSize?: number; // default 50, maximum 100
}
```

It returns `{ items, nextCursor, total, counts }`. The cursor is opaque,
versioned, and encodes the final row's status rank, selected sort value, and ID.
Every SQL order ends with the immutable meeting ID as a deterministic tie-breaker.
The status-bucket precedence remains pending, awaiting user, processing, failed,
done. Filters and counts operate across all non-deleted meetings.

The existing unbounded list call is removed from polling consumers. The pipeline
status bar hydrates only its current/queued IDs using `meetings:get-many(ids)`.
Search continues to scan the whole library; its returned meeting IDs are hydrated
through that same endpoint, so results do not depend on which Library page is
loaded. Search limits remain explicit and are reported as such in the UI.

The Library store retains the current query, loaded pages, total/counts, and
request generation. A query change discards old pages. Refresh replaces the first
page and reconciles loaded row identities; stale page responses are ignored.
Scrolling near the end requests the next page once. Failures retain loaded rows
and provide a retry affordance.

Browse rows use a focused `VirtualMeetingList` with a fixed, enforced row slot and
overscan. Only visible rows plus overscan are mounted; absolute offsets preserve
scroll position. Search results remain capped and use their existing section and
snippet layout. A 1,000-meeting fixture must keep mounted browse rows below 40.

Selection supports two states: explicit IDs, or all IDs matching the current
filter. “Select all loaded” remains local; an additional “Select all N matching”
action resolves the matching IDs from SQLite through `meetings:list-ids`. The
selection snapshot is fixed when chosen, so later arrivals are not silently added.
Bulk process applies only to selected pending IDs, bulk delete applies to all
selected IDs, and failed operations remain selected. Search selection resolves
only the current search result IDs. Confirmation text always reports the exact
number of IDs affected.

## Compatibility and error handling

All new IPC inputs are validated at the main-process boundary. New response
fields are additive while a phase is in flight. Renderer types live with the
preload contract, and main/preload channel parity remains tested. No renderer
argument is used as a filesystem path or SQL fragment.

The app preserves existing empty, loading, processing, early-transcript-preview,
search, recovery, trash, navigation, and bulk-action behavior. Existing unrelated
untracked workspace files are not modified.

## Verification

Each issue uses red-green-refactor tests, targeted benchmarks, renderer type
checking, the production build, the complete Vitest suite with isolated workers,
and an independent code review before its PR is merged. Performance changes are
kept only when repeated improvement exceeds run-to-run variation. Measurements,
fixture limitations, and reverted experiments are recorded under
`docs/performance/`.
