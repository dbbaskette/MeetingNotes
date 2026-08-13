# Implementation Plan: Issues #176–#179

## 1. Source-aware capture health

- Add unit-tested capture-health derivation in the renderer for startup, healthy, partial, and empty-stream states.
- Extend the Swift helper level protocol with `mic`, `system`, and `mixed` source names and independent throttling.
- Carry the source through recording manager, main-to-renderer events, preload types, and peak throttling.
- Replace the live row’s single silence warning with three indicators, actionable source-specific copy, confirmed fallback restart, and a post-stop summary.
- Run the capture-health, silence-detector, peak-throttle, recording-manager, and component-adjacent tests.

## 2. Durable recovery service

- Add a migration and repository methods for dismissed recovery sessions and recoverable-session queries.
- Extract watcher cataloging into a reusable, unit-tested catalog service.
- Add a recovery service that probes primary and stem files, classifies items, recovers without mutating originals, trims via ffmpeg, reveals files, and dismisses sessions.
- Add IPC channels and preload APIs for recovery listing and actions.
- Wire the library watcher and recovery service to the shared catalog path.
- Run storage, catalog, recovery, IPC, and watcher tests.

## 3. Unified Needs attention panel

- Add a pure, unit-tested selector that groups and orders recovery, failed, speaker-review, and pending items.
- Add a Library panel with primary actions and recovery detail/actions.
- Refresh the panel after recovery and dismissal and hide it when empty.
- Run renderer selector and Library tests, then typecheck.

## 4. Faster speaker review

- Add review metadata and transcript impact calculation to the speaker IPC response.
- Add a bulk-assignment IPC operation that links multiple labels and re-merges once.
- Add tests for metadata classification, impact counts, and bulk assignment.
- Enhance the panel with confidence/quality cues, duration and impact, selection controls, bulk assignment, and impact confirmation copy for destructive-looking changes.
- Run speaker repository, handler, transcript-merger, and renderer tests.

## 5. Integrated verification and packaging

- Run formatting/lint/typecheck commands defined by the repository.
- Run the full test suite; rerun and document any known timing flakes separately.
- Build the application and the new installer using the repository’s package script.
- Inspect the worktree diff and report the installer path, verification results, and any residual limitations.

