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

Full existing Tart suite will be recorded here after completion. User meetings,
settings, model caches and the installed app are untouched. No assertion or CI
timeout is weakened. Real-meeting false-acceptance/false-rejection calibration
remains follow-up evaluation; opt-in is not a claim that 0.98 means 98% certainty.
