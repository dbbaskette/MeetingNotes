# Optional native voice auto-matching verification

Implementation on `codex/native-speaker-auto-match`; no release, installation,
user-library processing or settings mutation is part of this request.

## Policy and persistence

Off by default. Next identification run uses unrounded cosine similarity >=
0.98, runner-up lead >= 0.05, >= 10s exclusive speech, >= two distinct merged
turns with >= 1.5s clean speech each. Malformed timing fails closed. Duplicate
identity claims and already named identities cannot win by input order. Profiles
must match the native embedding space and dimension. These are initial opt-in
heuristics, not calibrated error rates or identity probabilities.

Migration 25 only adds nullable assignment provenance, retaining old identities,
scores and voiceprints. All read paths preserve new automatic/manual provenance.
Even similarity 1 is shown as automatic until a human confirms. Confirming the
same identity clears stale automatic review metadata and trains the existing
profile through the human assignment path. Auto-matching never calls training.
Manual assignments survive identification retry. Settings changes do not
retroactively rename meetings or undo existing assignments.

## Evidence

- 138 targeted tests passed: matching/evidence, DB migration/provenance,
  settings validation/persistence, real native-profile identification,
  gate continuation/name re-merge, IPC and detail-artifact invalidation.
- Main, renderer and fixture type checks passed; zero-warning lint passed.
- Isolated Settings and appearance fixtures passed: opt-in/out writes, automatic
  similarity label, explicit same-person confirmation, reload and editable
  identity, light/dark and narrow screens. All bridges use synthetic data;
  no capture, speech preparation or actual native inference occurred.

## Full clean-Mac verification

`bash scripts/ci/tart-macos.sh --no-status` passed on committed source
`dddb4a768a5fba0adc0a98f18171b35ce2dfedda`, tree
`53bd36a842e1e43375a8dd520d8d7d2cf2d7ba10`.

- macOS 27.0 (26A428), arm64, Node 22.23.2, npm 10.9.8, Electron 44.7.0.
- Clean dependency install and Electron-native rebuild passed.
- Full Vitest suite: 1,380 passed, 6 skipped; 161 files passed, 2 skipped.
- Swift audio-helper synthetic tests, renderer/fixture/main type checks,
  production build, docs and zero-warning lint passed.
- Browse benchmark, full renderer fixtures and speech UI fixture passed.
- Task-owned VM `meetingnotes-test-20261021105923-11231-1423e5b7` was deleted.
  Host logs are retained at
  `/Users/dbbaskette/Library/Logs/MacOS Test Suite/meetingnotes/meetingnotes-test-20261021105923-11231-1423e5b7/`.
- No GitHub status was posted. No packaged installer was built or tested.

The first full run on `eb636c9a4a87cc2a0c2bc43f5f257ffb781b24dc`
found two tests that recreated historical schemas by removing later columns,
but left the new provenance column behind. Their fixtures now remove that column
before exercising the real migration; the v18 fixture expects schema 25.
Production migration behavior was not weakened. All 45 tests in the affected
migration/bridge/cache files passed locally before the successful full rerun.
The follow-up also aligned preload provenance types and added a type-level
review-contract parity assertion. Renderer, fixture and preload type checks passed.

`npm run smoke:source` passed against the implementation's disposable synthetic
600-meeting library, with no logged warning/error or CSP violation. The later
preload change was type-only: compiled preload SHA-256 remained
`bee44e74e802dee6a9ee7e5a6938d37930e0ae3e21f8a93051d5f47e9206f897`.

User meetings, settings, model caches and the installed app are untouched. No
assertion or CI timeout is weakened. Synthetic fixtures do not establish actual
native inference or real-meeting matching accuracy. False-acceptance/false-rejection
calibration remains follow-up evaluation; opt-in is not a claim that 0.98 means
98% certainty.
