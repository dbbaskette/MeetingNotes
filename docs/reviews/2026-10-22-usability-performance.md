# 1.19 usability and performance verification

Scope: twelve approved recommendations. Source-only GitHub release plus a local
installer; no installation or restart of the user's running app.

## Completed development checks

- Targeted regression suite: 129 tests passed across speaker profiles/matching,
  processing, scoped search, storage and IPC. Additional coverage is included in
  the final full-suite run.
- New synthetic regressions cover native-profile preservation across roster merge,
  repeat merge, undo/provenance persistence, incompatible dimensions, safe model
  discovery and cache freshness. A 50-person / 20-voice batch performs 50 profile
  reads cold, zero warm, and one after changing one profile; the former per-voice
  implementation read all 50 profiles for each voice (1,000 reads).
- Native pipeline tests cover separate speech states, serialized long recordings,
  cancellation scoped to the current meeting with the next meeting completing,
  and notes-first continuation without confirming unknown voices.
- Populated appearance fixture passes six screens in light/dark and desktop/narrow
  layouts, including task completion and group pin/preparation. Uses only synthetic
  bridge data, not real meetings, capture, setup or accounts.

## Memory experiment

The original scheduling experiment used the pinned SDK audio loader and a generated
75-minute speech recording. Parallel helper RSS peaks were 1,554 / 1,559 MiB;
sequential peaks were 1,548 / 1,531 MiB. This small change does not establish a
meaningful system-memory improvement. Sequential elapsed times were about 39.6s
versus 35.7–36.1s parallel. Therefore the decoder itself was also optimized to avoid
intermediate float copies and final-array growth, retaining identical resampling
and whole-recording clustering. Follow-up measurement and PCM parity results are
recorded below.

With the lower-copy decoder, parallel peaks were 1,267 / 1,293 MiB and sequential
peaks 1,258 / 1,278 MiB. Sequential times were 37.5 / 39.4s versus 33.7 / 34.2s
parallel. Compared with the original parallel workflow, optimized sequential peak
helper RSS was approximately 18–19% lower; most of the reduction came from decoding,
not scheduling. All four follow-up runs retained 13,015 timed words through 4,500s,
full speaker coverage and 1,719 transcription-progress events. The pinned models
and existing generated audio were reused without downloads. Three native Swift
tests passed, including bit-identical PCM versus the SDK at 16/44.1/48 kHz,
mono/stereo, and across a ten-minute decoder boundary.

Measurement uses `scripts/speech-benchmark/scheduling-memory.mjs`: 100ms samples of
summed speech-helper RSS only. Apple speech-service/GPU allocations are excluded.
Synthetic repeated speech is not an accuracy or cross-meeting identity benchmark.

## Scoped-search experiment

`scripts/bench-search-scope.mjs` generated 500 disposable transcripts, selected ten,
and measured seven warm no-match searches. Median elapsed time fell from 12.91ms
for 500 folders to 6.00ms for the eligible ten. This verifies the reduced scan scope,
not a guaranteed latency improvement for real libraries or cold disks.

The first isolated suite caught two old migration fixtures that reset the schema
version without removing the new pin column, plus a parallel-scheduling test that
depended on host free RAM. The fixtures now reconstruct the prior schema fully and
explicitly select the parallel path. All 42 tests across those three files pass.

## Safety and compatibility

- Original audio and immutable weekly snapshots are untouched.
- Voice profile schema remains backward readable, with optional history/provenance.
  Roster merge keeps source profile recovery copies; incompatible dimensions fail
  before any writes. A failed DB commit restores changed target files.
- Speaker-label resolution only replaces exact diarizer tokens, never guesses at
  existing names. Notes history captures pre-resolution notes and tasks.
- Group pin migration is additive. Current action data is queried live and excludes
  deleted meetings; results are bounded to 100 per page.
- Saved profile cache validates file identity and explicit mutations invalidate it.
  Search narrows folder input before scanning and retains cancellation/limits.

## Final verification — 2026-10-22

The application implementation is unchanged since `d066a15`. CI evidence is reused
across test-fixture and documentation-only follow-ups, not represented as one
uninterrupted successful run:

- Full Tart run at `f3f315a1020570b8998f00af0fd2706b3bf566b4`: **1,393 tests
  passed**, six optional tests skipped (164 files passed, two skipped). Native
  audio-helper synthetic tests, renderer/main/fixture types, build, docs, lint and
  browse benchmark passed. This run stopped at an outdated capture-fixture bridge
  missing the new speaker-review method; the rename fixture shared that omission.
- Corrected synthetic bridges only; no app-code changes. The complete isolated
  renderer suite at `1b90061db64dbd3b173441ffe000198d03eed130` passed all twelve
  fixture modes and the speech-beta comparison UI. Types, build, docs and lint
  also passed again. Both task-owned VMs were deleted by the runner.
- Guest environment: arm64 macOS 27.0 (26A428), Node 22.23.2, Electron 44.7.0.
  Physical native/PCM/memory checks: arm64 macOS 27.0.1 (26A434).
- Logs under `~/Library/Logs/MacOS Test Suite/meetingnotes/`:
  `meetingnotes-test-20261022210326-9431-0f01af3b` (full checks), and
  `meetingnotes-test-20261022210943-21453-9b107c64` (renderer completion).

## Installer

Built from `f3f315a` with the unchanged tested app source. Final source changes
after that revision are UI fixtures and release documentation only.

- Version 1.19.0, arm64, minimum macOS 26.0.0; both native helpers bundled.
- All 181 packaged application files matched `dist` byte-for-byte.
- Deep/strict code-signature verification, DMG verification and ZIP integrity passed.
- Apple Development signing, not Developer ID notarization. No app installation,
  app restart, real recording or installer VM test performed.
- Removed only the loose packaging `.app` to prevent duplicate registration;
  the verified DMG/ZIP retain a recoverable copy.
- DMG SHA-256: `dda4aee891eb25604433ff3f7dd35891498784e1506f8639909ad0dff88ec1e0`.
- ZIP SHA-256: `5b1425716dc93ac4667326e844aab5143fffd4af007ce43b12354b1366d9b1aa`.
