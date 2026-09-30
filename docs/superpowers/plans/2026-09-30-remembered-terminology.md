# Remembered terminology implementation plan

Status: approved on 2026-09-30 and implemented locally on `codex/remembered-terminology`. See `../specs/2026-09-30-remembered-terminology-design.md` for the contract.

## Outcome and ownership

Implement a local dictionary learned through explicit confirmation, scoped suggestions and opt-in automatic replacements, a focused transcript correction action, and correction review/undo. The implementing agent owns integration and final verification. Use coherent functional increments; strict TDD, delegated agents, publication, and installer builds are not required by this plan.

## 1. Dictionary and matching foundation

Existing files: `electron/main/storage/migrations.ts`, `db.ts`, `groups-repo.ts`, `electron/main/ipc/handlers.ts`, `electron/preload/index.ts`, `electron/renderer/src/ipc/client.ts`.

Add a terminology repository, validated shared contracts, and pure matcher/diff modules in appropriate existing lib directories. Define rule revisions, scope precedence, normalization, bounded candidate detection, and conflict handling. Add persisted application/occurrence decisions, dismissals, and pending-write reconciliation needed by later slices. Bind group removal to safe rule removal/disablement.

Check migrations against a disposable existing-schema database; test scope isolation, invalid input, duplicate conflicts, replacement cycles, single-pass matching, Unicode/case/phrase boundaries, and bounded work on large documents. Verify recovery decisions and rule revisions survive restart. This slice owns database and matching tests.

## 2. Generation and artifact integration

Depends on slice 1. Existing files: `electron/main/pipeline/context.ts`, `electron/main/index.ts`, `electron/main/pipeline/stages/merging.ts`, `stages/summarizing.ts`, `electron/main/pipeline/prompts.ts`, `electron/main/library/artifact-cache.ts`, `electron/main/pipeline/clear-artifacts.ts`.

Thread the terminology service into stage and remerge dependencies. Preserve raw segments, snapshot applicable rule revisions/group scope, apply saved occurrence decisions and automatic rules to segment prose before formatting, and persist correction metadata with generated artifacts. Feed the corrected transcript and a bounded applicable glossary to summaries; normalize only eligible generated prose. Add revision/fingerprint checks, recoverable writes, cache invalidation, stale-summary signaling, and conflict-safe undo. Rule edits and meeting moves must not mutate existing documents.

Test transcript regeneration after speaker naming, retranscription with changed segments, stage/rule-change races, scope changes, interrupted writes, stale preview rejection, and undo after unrelated/overlapping manual edits. Verify timing/speaker labels and raw files are unchanged and that search/export paths read corrected artifacts. This slice owns pipeline and persistence integration tests. Do not add STT prompt support in this iteration.

## 3. Learning and correction UI

Depends on slices 1–2. Existing files: `electron/renderer/src/views/MeetingDetailView.tsx`, `MeetingTranscriptPanel.tsx`, `SettingsView.tsx`, plus new small shared correction components.

After successful summary saves, compare the captured saved baseline and submitted draft, then offer a single inline confirmation for eligible short substitutions. Handle navigation and in-flight edits without mixing meeting IDs or drafts. Use current-group/default-library scope and Suggest mode defaults; expose Automatic as an explicit checkbox. Provide a focused transcript Correct term action with occurrence preview and the same Remember controls. Add Review terminology, before/after detail, and safe Undo. Keep routine reading uncluttered and every action keyboard accessible.

Add searchable Settings terminology management and the option to disable learning offers. Keep save failures independent from dictionary failures: do not show “learned” before persistence succeeds, and do not undo a successful notes save if remembering fails.

Check the user journey using disposable meetings: edit/save/remember; skip learning; multiple small edits; paragraph rewrite; manual rule creation; suggest/accept/dismiss; automatic group-scoped correction; review/undo; keyboard navigation; settings edit/disable/delete. Verify summary staleness messaging and no unsolicited summary/action regeneration. This slice owns UI integration verification.

## 4. Integrated verification and documentation

Depends on slices 1–3. Update README usage for learning, scope, review versus automatic behavior, dictionary location in the existing library database, and undo limitations. Link existing terminology-related docs as appropriate rather than treating old transcript-editor plans as implemented features.

Run the full relevant test suite once for the completed tree, then build/type-check and the applicable lint checks. Reuse unchanged targeted evidence. Review a realistic fixture with technical `Salsa → SLSA` and legitimate food-related salsa in another group; verify current and future transcripts, notes, exports, and source playback. Compare candidate-detection/matching time and operation counts on small and large fixtures; report measured values without inventing an accuracy or speed claim. Do not use private live meetings or paid model calls for fixtures.

Review focus: scope leakage, repeated prompting, clobbered manual edits, corrections lost on remerge, unsafe undo, prompt-only reliance, stale caches, and raw transcript mutation. Report any provider-dependent generation checks not exercised. Commit/push/PR/release/installer work requires the user's requested publication boundary and is not included here.

## Completion record — 2026-09-30

- Completed dictionary migration/repository, main-process validation, library/group scoping, revision and cycle checks, Suggest/Automatic modes, and local learning preferences.
- Completed single-pass prose matching, short-edit detection, generation integration, occurrence preview/dismiss/apply, persisted correction history, conflict-safe undo, restart recovery, and transcript correction preservation during speaker remerge. Raw transcript bytes are not changed. External transcript modifications are detected and preserved by refusing to overwrite them.
- Completed inline summary learning offers, transcript/summary correction panels, searchable Settings management, and explicit stale-notes regeneration. Updated README. No STT prompt changes or additional model requests.
- Full Vitest suite: **953 passed, 6 skipped**, 123 files passed and 2 skipped. Following the final Markdown/Unicode boundary refinement, the affected matcher/service/merge/summary suites passed **39 tests**, including one added boundary regression. Unchanged full-suite evidence was reused.
- A final Undo review added revision-anchored handling of repeated identical passages. The terminology service suite passed **13 tests**, including that regression; service lint and main-process compilation passed again. Earlier integration/UI evidence remains applicable to the unchanged interfaces.
- Production build, renderer TypeScript check, ESLint for all new source/test files, and tracked-diff whitespace checks passed.
- Browser verification used a disposable fixture with the actual React components: remembered Salsa → SLSA for Engineering in Suggest mode, selected/applied an occurrence, inspected history, edited the rule to Automatic, and exercised Undo. The temporary preview file, tab, and server were removed. UI screenshot: `/private/tmp/meetingnotes-terminology-preview.png`.
- Synthetic compiled-matcher check on this machine, 50 rules: 20 segments / 1,019 characters / 20 matches took 6.52 ms; 2,000 segments / 101,999 characters / 2,000 matches took 17.53 ms. These are single-run fixture timings, not product latency guarantees. Small-edit detection took 0.49 ms; the large before/after pair exceeded the deliberate 200,000-character learning budget and safely skipped automatic learning (manual correction remains available).
- No live model/audio accuracy trial, production library mutation, release, installer build, or publication was performed. Generation correctness was exercised using deterministic local fixtures and existing stage tests; model adherence to glossary guidance is not assumed, and automatic rules also run deterministically on generated prose.
- Restored the `better-sqlite3` native module for Electron using the project's standard rebuild after Node-based testing.
