# Native speech full-app integration verification

Target: 1.15.0, integrating the owner's accepted Apple/SpeakerKit comparison beta into the regular app.

Final product source: `7bd849b4f9a70ec9b207a2fc6e58a9ad0b0bea33`, Git tree `340e2f76a9456c5c52c083248933844f04957eb2`. Subsequent release-evidence edits are documentation-only; the final installer was built from this product source. No binaries or private test inputs are committed.

The [beta verification report](2026-10-16-native-speech-beta-verification.md) covers the unchanged native engine implementation, anonymous pinned model download/offline inference, synthetic 75-minute coverage and comparison-workspace isolation. This integration adds full-app routing, provider selection/recovery, model-isolated stable voice profiles, native setup, terminology compatibility and packaging.

## Scope and safety

- No private meetings or signed-in exporter accounts are used by automated tests.
- The installed app and its active recording/processing are not replaced or interrupted.
- Existing users remain on their provider until opting in. Native similarities require confirmation. Legacy vectors and old meeting artifacts remain untouched by switching.
- Synthetic full-pipeline checks use actual Apple/SpeakerKit inference but deterministic LLM responses. They do not establish real-LLM quality, live microphone capture, overlap accuracy, held-out identity calibration or signed-in export acceptance.
- Local installer signing uses Apple Development, not notarized Developer ID distribution. GitHub releases have no installer assets.

## Source, protocol and functional checks

- Targeted pipeline/speakers/beta/IPC regression slice: **197 passed**. Subsequent native service, migration, terminology and handler tests cover the integration additions.
- Native engine build and **2 Swift protocol/timestamp/vector tests passed** on the physical Mac.
- Actual Apple + SpeakerKit processing of generated AAC speech through the full stable pipeline passed, including the human speaker-review gate, confirmed native profile, named transcript, notes/tasks and Markdown export. Legacy supervisor calls were configured to fail and were never invoked. Summary generation used deterministic fixture responses, not a live LLM.
- The same integration smoke passed using the **signed helper inside the packaged application**, not merely the source helper. A native centroid was enrolled and returned as a similarity-ranked candidate. No private library or beta experiment was imported.
- Final main/preload/renderer source startup smoke passed against its disposable synthetic 50-row library, with no product renderer warnings/errors or CSP violations.
- Native Settings UI fixture passed engine-save rejection without misrepresenting the selected engine, native preparation/progress/cancellation, no Whisper download, hidden legacy endpoints, and 780px layout without horizontal overflow. The actual native panel was captured and visually reviewed. Synthetic development fixtures emit Electron's expected development-CSP warning; the production startup smoke does not.
- Main, preload, renderer and fixture types, production build, shell syntax, zero-warning repository lint and documentation checks passed at integration milestones. Final full-gate results below supersede the targeted evidence for the settled tree.

## Clean macOS gate

**Final complete unit suite: 1,383 passed, six intentionally skipped**, on the physical Mac at product commit `7bd849b`. Log: ignored `speech-benchmark-results/integrated/final-unit-suite.log`.

**Clean-Mac full gate: PASS** at `e99911e` (tree `0a5f15574a97554e2b310e4521cc5bd4c6b93dfe`), **1,382 passed, six skipped**, all capture/build/type/docs/lint/benchmark/renderer/beta stages passed. Results: `meetingnotes-test-20261016185359-99008-2b9f1616`. The clone was deleted and the wrapper posted success for that exact commit.

The only subsequent product change is the `7bd849b` enrollment safeguard: require an actual saved roster entry before writing either profile format, with a new regression test for unknown/path-shaped IDs. Its affected **89-test** speaker/native/IPC slice passed; the entire **1,383-test** final-product suite, main types and zero-warning lint then passed. The signed-package native processing/enrollment flow and final source startup were rerun successfully. No renderer, Swift helper, capture or packaging source changed after the successful clean-Mac gate; their evidence is reused rather than attributed to a nonexistent second VM run on `7bd849b`.

The existing wrapper `bash scripts/ci/tart-macos.sh` owns each disposable clone and retains results under `~/Library/Logs/MacOS Test Suite/meetingnotes/`. The guest uses macOS **27.0 (26A428)**, arm64, Node **22.23.2**, npm **10.9.8**, Electron **44.7.0**, fresh dependencies and Electron-native SQLite. Coverage includes the full Vitest suite, synthetic capture-helper checks, types/build/docs/lint, Browse benchmark, all 11 stable renderer fixture modes, and the isolated beta UI fixture. Real native speech inference is owned by the physical Mac, not inferred from VM capability.

Earlier runs are retained transparently:

1. `meetingnotes-test-20261016184320-32351-9b957e65`, product commit `8d1eb3c`: **1,380 passed, six skipped**, all gate stages passed. Clone deleted; `tart-ci=success` posted for that exact commit.
2. `meetingnotes-test-20261016184942-72342-b91ec4aa`, final product commit `e99911e`: **1,381 passed, one failed, six skipped**. The unchanged `LibraryWatcher` polling test “emits a stable-file event once the file size stops changing” hit Vitest's five-second timeout. Later gate stages did not run. Clone deleted and the failure status was posted, not hidden.

The watcher source/test have no diff from main, and the prior release notes already record a clean-VM watcher timeout. The unchanged isolated host watcher suite subsequently passed **10/10** in about 2.1 seconds. This supports an intermittent timing failure; its precise root cause is not established. No watcher assertions, timeouts, tests or gate requirements were weakened. The full unchanged-tree rerun without concurrent packaging passed, including the watcher. All three task-owned clones were deleted; no VM was retained or unrelated VM stopped.

## Physical Mac and artifacts

Host: Apple **M5 Pro / 64 GB**, arm64, macOS **27.0.1 (26A434)**, Xcode **27.1 (27A9275)**, Node **22.23.1**. Assets were already explicitly prepared; tests reused the pinned task-owned speaker model cache. Inference did not require HF credentials or model downloads.

Local artifacts (not uploaded to GitHub):

| Artifact | Approximate size | SHA-256 |
| --- | --- | --- |
| `release/v1.15.0/MeetingNotes-1.15.0-arm64.dmg` | 260 MiB | `beb57bdc8c791e0bdf918094ebca4384dba52f335ae1326bd8ebd5d0d35e5aa0` |
| `release/v1.15.0/MeetingNotes-1.15.0-arm64-mac.zip` | 282 MiB | `2491cb1d01ad7b997c9fa1fa86aec2c70b0d34075a9c5d9d7b1bfb31e92d5fef` |

- Deep/strict `codesign` verification of the complete app and strict verification of `meeting-notes-speech` passed. The existing **Apple Development** identity was used. The build explicitly skipped notarization because no notarization configuration was available; this is not Developer ID/notarized distribution.
- `hdiutil verify` reported the final DMG checksum **VALID**.
- ZIP CRC/integrity validation reported no compressed-data errors.
- The packaged version is **1.15.0**. Main, settings repository, native service, guarded roster service, preload and renderer entry extracted from `app.asar` byte-match the settled local build (six files checked). Required native helper and SDK notices/licenses are bundled.
- Capture and native speech helpers were rebuilt. The unchanged legacy sidecar payload was reused; its source has not changed in this feature branch. Retaining it deliberately preserves the legacy fallback and means no installer-size reduction is claimed.
- Installer VM acceptance was omitted as requested. The signed installer was not installed over the running stable app. No TCC permissions, keychain entries, real meetings, vaults or export destinations were changed by these checks.
- After verification, the newly generated loose app bundle is removed to avoid duplicate LaunchServices/Launchpad registration. The signed application remains inside both retained installers; the installed stable app and beta artifacts are not removed.

## Rollout and remaining evaluation

Existing installations stay on Legacy until explicitly switched in Processing Settings. Only new supported installations default to native. The owner accepted their beta meeting evaluation; broad real-meeting accuracy/overlap/peak-memory measurements and held-out identity calibration are not claimed complete. Native voice candidates remain human-confirmed and legacy remains selectable. Issue #274 retains those evaluation boundaries.

The README and release notes explain the benefits, remaining LLM/FFmpeg dependencies, asset setup, storage, model-isolated enrollment, non-imported beta data, explicit reprocessing and rollback. Source-only GitHub publication and the local installer are separate from installation; the running app remains unchanged until the owner chooses to replace it.
