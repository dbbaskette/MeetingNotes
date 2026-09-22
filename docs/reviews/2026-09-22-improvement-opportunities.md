# MeetingNotes improvement review — 2026-09-22

This review covers the local code and documentation. Items 1–12 were implemented with the PDF follow-up work; item 16 remains a recommendation. Performance items are based on code and build output, not an end-user latency benchmark.

| # | Area | Priority | Recommendation and evidence |
| --- | --- | --- | --- |
| 1 | Startup performance | Medium | **Implemented:** Detail, Weekly, Settings, and Onboarding views are lazy-loaded. The main production JS chunk fell from 524 kB to 240 kB (uncompressed); first-navigation latency has not been benchmarked. |
| 2 | Detail performance | Medium | **Implemented:** The pipeline emits persisted stage/status changes; the detail view refreshes on those events and keeps a 15-second fallback poll. |
| 3 | Weekly performance | Low | **Implemented:** Narrative elapsed time updates once per second. |
| 4 | Code simplification | Medium | **Implemented:** Transcript, speaker, action-item, and export sections are separate view modules; the detail controller remains in `MeetingDetailView.tsx`. |
| 5 | Code simplification | Medium | **Implemented in stages:** Export, Weekly, and Settings/Onboarding IPC handlers have separate registration modules; the shared contract and `registerIpcHandlers` entry point remain. Recording and meeting handlers still live in the entry module. |
| 6 | Contract safety | Medium | **Implemented:** Weekly payload types live in `electron/main/ipc/contracts.ts` and are imported by both the aggregator and renderer. |
| 7 | Export architecture | Medium | **Implemented:** Pure shared export-target metadata defines kind, file extension, empty-selection policy, own-item restriction, and Google requirement; main and renderer use it for export decisions. |
| 8 | Export correctness | High | **Implemented:** PDF, Markdown, and Google Doc share summary cleanup; selected database items are the only exported action-item list. Notes-only Markdown has no action-item heading. |
| 9 | Export UX | Medium | **Implemented:** The picker groups Open and Completed items and labels completed items as unselected by default. |
| 10 | Export UX | Medium | **Implemented:** Summary-only Markdown and PDF exports show a saved-path toast. |
| 11 | Connection UX | Medium | **Implemented:** Google status errors are visible in the export panel with Retry. |
| 12 | Modal lifecycle | Low | **Implemented:** The picker clears its auto-close timer on unmount. |
| 13 | Docs accuracy | Medium | **Addressed:** The README’s absolute “No cloud. No uploads” claim conflicted with optional Google and webhook exports. It now states the local default and identifies optional network exports. |
| 14 | Docs accuracy | Low | **Addressed:** `docs/exporters.md` omitted Google destinations and claimed no PII could leave the Mac unless webhook was enabled. The introduction and privacy section now describe all destinations. |
| 15 | Docs maintenance | Low | **Addressed:** The fixed test count in `README.md` said “688 tests” while this run had 910 passing tests. The command description no longer embeds a count. |
| 16 | Lint hygiene | Medium | Make repository-wide lint useful as a gate. `npm run lint` currently reports 166 errors and 8 warnings, including a React hook rule violation in `RecoveryRow.tsx` and many test-fixture `any` errors. Fix the hook violation first, then exclude generated fixtures or separate test lint rules so new regressions stand out. |

## PDF export added in this change

The meeting Export rail now offers PDF. The action-item picker allows all, some, or no items; choosing none exports notes alone. The exporter prints the saved summary through an isolated Electron window and removes the summary's embedded Action Items section before adding selected database items. It does not make a network request.
