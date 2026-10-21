# Optional native speaker auto-matching

Approved: restore optional automatic assignments for strong, separated candidates;
retain review for ambiguous/short voices and train only on human confirmation.

- Settings → Processing: off by default. Next identification runs only; no
  retroactive rewrites or processing when the setting changes.
- Initial heuristic: raw cosine similarity >= 0.98, runner-up margin >= 0.05,
  >= 10 seconds of non-overlapping speech across >= 2 distinct turns with
  >= 1.5 seconds of clean speech each. Not calibrated identity probabilities.
- Match only same-model/dimension native profiles. Duplicate identity claims,
  existing named identities, missing vectors and invalid evidence stay reviewable.
- Add nullable assignment provenance to meeting links; preserve legacy links.
  Automatic assignments never appear human-confirmed, including similarity 1.
- Provide explicit confirmation in the voice editor; only human operations
  train/update profiles. Keep corrected/manual links intact on identification retry.
- Test policy, migration, pipeline gate/rewrites, settings validation/persistence,
  UI toggle and automatic → confirmed behavior using disposable data. Run full
  existing local macOS CI before completion; do not publish/release/install.
