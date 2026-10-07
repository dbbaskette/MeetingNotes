# Epic 242 verification and packaging baseline

Scope: #242 and children #173, #167, #216, #168, #232, #183, #180,
#231, #198, #169, #172 and #36. The owner requested the minor-version bump to
1.14.0, including contributor release notes. This work does not publish a
release, install an app, or enable automatic processing by default.

## Tested states and evidence

Product implementation: `c80426b`; packaged smoke contract correction:
`8e35ae5`. Subsequent commits repair portable/offline QA fixtures and test
mocks, not shipped capture/processing behavior. Clean-Mac full-suite source:
`0ff5e2a`. Version/notes commit `5ef2741` changes only metadata and documents;
the 1.14.0 app bundle was rebuilt and independently rechecked. Final portable
package follow-up source: `af2023a`. Documentation-only completion updates
reuse this evidence.

The host is arm64 macOS 27.0.1 (26A434), Electron 30.5.1. Verification uses
synthetic data and disposable directories; it never captures a real call or
sends to a real export account. The shared Tart runner clones the existing
stopped Golden Gate base; it does not modify the base or other running VMs.

### Completed host checks

- Native helper builds; bounded shared timeline, delayed first callback,
  input gaps/resumption, finite samples and coordinated AAC cleanup pass.
  Decoded generated tones and offline TTS speech pass duration, gain, RMS
  and clipping checks. These are not microphone/device acceptance tests.
- Targeted recorder, URL, catalog, auto-process, disposable-test, webhook,
  Tasks, model-download and transcript-preservation checks pass.
- Node/preload/renderer and UI-fixture type checks pass. Scoped lint has
  zero errors and seven warnings; a clean lint output is not claimed.
- Synthetic UI checks cover source refresh, explicit test initiation,
  failed Stop/restart, group intent, compact speaker review, retry history
  and a 113-item paged attention backlog.
- The actual unsigned packaged app paints a 600-meeting Library with both
  normal rendering and GPU-disabled SwiftShader. Real preload IPC returns
  50 items and a cursor; no recording or automatic processing starts.
- Packaged helper source enumeration passes without capture. Packaged STT
  and summary clients pass real HTTP transport checks against a private
  synthetic loopback server; actual STT/summary model inference is not claimed.
- The bundled sidecar runs real offline pyannote diarization on generated
  speech, producing segments and finite, nonzero speaker embeddings. Only
  existing cached weights are copied; no credentials or downloads are used.
  Sidecar build ID: `20261007T115847Z-b28a1e7` (unchanged Python runtime source).

Host packaged logs/screenshots: `/private/tmp/meetingnotes-epic242-package-smoke-final`.
The rebuilt 1.14.0 bundle also passes the same host package/runtime checks,
with actual Library version text and bundle metadata both showing 1.14.0:
`/private/tmp/meetingnotes-epic242-v1.14-smoke`.
Targeted logs: `/private/tmp/meetingnotes-epic242-final-targeted.log` and
`/private/tmp/meetingnotes-epic242-targeted.log`.
Native/UI logs: `/private/tmp/meetingnotes-epic242-native.log`,
`/private/tmp/meetingnotes-epic242-ui-3.log`.

### Full clean-Mac gate

Full source run `0ff5e2a` on macOS 27.0 (26A428), arm64, Node 22.23.2:
**1,166 tests pass, six skipped** (141 test files pass, two skipped).
Native AAC/timeline/TTS checks, renderer/fixture types, production main/preload
build, changed lint, Browse benchmark, Electron native rebuild and all seven UI
fixtures pass. The 500-note Obsidian fixture completes in 3,353 ms and its
unchanged pass in 0.4 ms; its durable-write stress test has a finite 30-second
VM limit, not an asserted five-second performance budget.
Browse output is identical: 1,000 records/500 groups, 5.10 → 1.23 ms median;
10,000/500, 53.43 → 10.40 ms. These compare the existing reviewed Browse
baseline, not a new production guarantee or an isolated epic-only speedup.

Source logs: `/private/tmp/meetingnotes-epic242-ci/meetingnotes-test-20261007123709-78201-1e6fc6be`.
That run's packaged gate failed before launch while copying framework extended
attributes through VirtioFS. Earlier runs also exposed and corrected outdated
IPC/migration fixtures. No failed overall run is represented as a full PASS.
The unchanged source-suite evidence is reused; the affected renderer/package
follow-up with 1.14.0 is pending final completion before publication.

## Measured disposable packaging baseline

Default maximum-compression arm64 build from `c80426b`, with an unsigned
test-only DMG/ZIP. Wall time is electron-builder packaging, not dependency
installation, native compilation or sidecar compilation.

| Measurement | Result |
| --- | ---: |
| Packaging wall time | 470.40 seconds |
| DMG file size | 235,035,375 bytes (224.15 MiB) |
| ZIP file size | 248,648,835 bytes (237.13 MiB) |
| App allocated disk usage (`du -sk`) | 701,500 KiB (685.06 MiB) |
| Bundled sidecar allocated disk usage | 489,092 KiB (477.63 MiB) |
| app.asar allocated disk usage | 14,420 KiB (14.08 MiB) |

Log: `/private/tmp/meetingnotes-epic242-final-package.log`. Allocated disk
usage differs from logical/archive file size and may depend on filesystem
link handling. These numbers are a current baseline, not an unsupported
percentage improvement against an old installer.

The hook removes 53 unused non-English locale directories, reported as
36.4 MB by the hook. It retains graphics fallback libraries/manifests,
licenses and notices. Keeping fallback resources can increase size compared
with prior aggressive pruning, but the normal/software packaged checks now
demonstrate compatibility. No speculative PyTorch/runtime pruning is applied.

Rollback: disable the locale trim hook for a conservative complete framework;
do not remove GPU fallback resources to recover size. Rebuild and rerun both
packaged rendering modes and offline inference after any dependency/pruning
change. Use the previous release for operational rollback; this PR does not
replace the installed application or publish binaries.

## Deferred checks and closure

The owner explicitly authorized merging and closing the epic/children while
deferring real-device verification. Closure does not mean live microphone,
long-call drift, overlap attribution, real exporter delivery, or real provider
inference were tested. Independent voice/system-stem processing stays disabled;
STT and diarization retain the same mixed input until hardware evidence supports
a change. See the [user checklist](reliable-capture-processing.md#user-verification-checklist-deferred-by-request).
If a device check fails, retain original audio and reopen #173 with the source,
device and approximate failure time.
