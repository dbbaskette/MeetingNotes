# Native-only 1.16.0 release verification

## Scope and identity

Owner-directed clean break from the compatibility approach in 1.15.0. Product commit `287326b6de884a595e5461bb66e40562dbd6d7b0`; test-only follow-up `ceda5b8` scopes the notes-cache assertion to notes, retaining unrelated cached provenance. macOS 26+/Apple silicon required. No database migration or bulk reprocessing.

Old completed artifacts, roster names, settings rows, credentials and caches are retained. Old untagged embeddings are never matched or trained as native profiles. Only new speech-phase runs replace run-local label links. Prior 1.15.0 local installers remain the rollback path; reinstalling an app cannot undo overwritten meeting outputs, so back up before reprocessing.

## Physical-Mac checks

Host macOS 27.0.1 (26A434), Apple M5 Pro/arm64, Node 22.23.1, Electron 44.7.0, Xcode 27.1. No installed app, private meeting, microphone, vault or account was used. Speech operations ran outside the filesystem sandbox to permit Apple's local assets service.

- Main, preload, renderer and fixture type checks; production build and zero-warning repository lint passed.
- 275 targeted native/pipeline/speaker/IPC/settings/recovery tests passed at the first functional milestone. Final cache and package regression slice: 47 passed.
- Real Settings/history fixture passed navigation, search, explicit preparation/cancel, errors, narrow layout and three-step native-only onboarding. Saved legacy settings are present in the fixture but produce no selector/download/token controls or provider writes.
- Two Swift protocol/vector tests passed.
- Real Apple transcription + SpeakerKit inference on generated AAC completed the stable pipeline twice: source helper and signed packaged helper. Both completed speaker review/enrollment, one model-tagged profile, readable transcript, notes/action items and Markdown export. Summary responses were deterministic fixtures, not LLM inference. No legacy process started. Packaged helper result: 2026-10-16 19:31:11 UTC, 6.98 seconds; not a real-meeting performance benchmark.
- Actual source app launch rendered a populated synthetic Library (50 rows, next page) without warning/error logs or CSP violations.

## Package checks

Versioned outputs in `release/v1.16.0/`, built from product commit `287326b`. Subsequent test/docs changes do not affect the installer product tree.

- Deep/strict code-signature verification passed; Apple Development identity, not Developer ID/notarized distribution. Builder explicitly reported notarization skipped.
- App Info.plist requires macOS 26.0.0.
- ASAR version is 1.16.0, no compiled legacy provider directories or Whisper/HF/STT bridge endpoints. No sidecar, Python, libtorch, legacy diarizer or Whisper model files. Both Swift helpers and Argmax license/notices/model notices present.
- All 175 generated runtime files byte-match the signed package. Test/docs follow-ups do not require rebuilding an unchanged product.
- DMG checksum verification and ZIP compressed-data integrity passed.
- DMG: 120,591,079 bytes (115.0 MiB), versus 272,205,929 bytes in 1.15.0: **55.7% smaller**.
- ZIP: 129,558,951 bytes (123.6 MiB), versus 295,256,961 bytes in 1.15.0.

SHA-256:

```text
888b9129c7ed69d01830b22d7a10cdcf4bceb57522625dc4c8375a54ec584820  MeetingNotes-1.16.0-arm64.dmg
b60f11c6b6e393703ec83fd80c1a21139a808f87cb04dd461b589051b1dcb1b4  MeetingNotes-1.16.0-arm64-mac.zip
```

## Full local CI

First disposable run `meetingnotes-test-20261016192903-75262-d5ed9f33` found the notes-cache test's global-entry assumption (1,319 passed, one failed, six skipped). It correctly retained a tiny speech-provenance cache entry; test-only follow-up checks eviction of the notes entry, not unrelated data. VM deleted; logs retained.

Final full run **PASS**: `meetingnotes-test-20261016193247-88902-8bc664a4`, source `ceda5b89226c3c71b65491b506dfb3f296337b81`, tree `89c18c0355d8a5d07a23e306c5d395e564cef752`. Actual guest macOS 27.0 (26A428), arm64, Node 22.23.2, npm 10.9.8, Electron 44.7.0.

- Clean install and Electron-native rebuild; **1,320 tests passed, six skipped** (opt-in suites), 157 test files passed/two skipped.
- Complete capture helper build and synthetic writer/mic timing harness, renderer/fixture/main type checks, production build, docs, whole-repository zero-warning lint.
- Browse performance benchmark, all 11 Library/Settings/capture/processing/terminology/rename UI fixture modes, beta comparison UI.
- No installer payload staged or installer acceptance run in the VM. Actual signed native-helper inference and artifact checks are the physical-Mac checks above.

Runner reported PASS and deleted both owned clones, including the first failed run. Full logs remain under `~/Library/Logs/MacOS Test Suite/meetingnotes/<run-name>/`. No live test worker remains. Base and signed-in VMs were not modified. Remote-required release gates are not bypassed. Final documentation and lock-label-only follow-up reuses the unchanged tested product/test environment; docs check passed separately.

Final lockfile audit restored an accidentally changed Axios version *label* to 1.15.0. Its resolved tarball URL and integrity were never changed; installed Axios is 1.15.0. Deep comparison of every dependency entry against 1.15.0 now differs only in the root app version. This is metadata correction, not a new dependency artifact/environment or product change; the completed source, native and package evidence remains applicable.

## Limits and follow-up

No installer VM acceptance, user installation/restart, live capture, private meeting inference, signed-in export or PDF runtime acceptance was performed. Swift SDK/models/capture behavior is otherwise unchanged from 1.15.0; prior long-duration synthetic evidence is not a new accuracy claim. Broader accent/language/overlap/peak-memory and held-out speaker-score calibration remain open in #274. Speech suggestions require human confirmation.

Dependency installation reports 38 existing npm audit findings (one low, 12 moderate, 22 high, three critical); dependency versions are unchanged by this release. No automatic force-upgrade or audit remediation is represented as part of this change.
