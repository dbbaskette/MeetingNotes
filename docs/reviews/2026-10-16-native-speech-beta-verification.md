# Native speech beta: implementation and verification

Date: 2026-10-16. Product source tested: `5cfe875e69e570d4b71207c189783240a18871e2`, tree `fe38636e92a201eaae88f8fc67934b5e6105736e`.

## Delivered evaluation boundary

MeetingNotes Beta 1.15.0-beta.1 has a distinct application identity and bootstrap, a copied-library import, original/new transcript comparison, unchanged saved notes, copied audio playback, native Apple transcription, SpeakerKit turns/centroids, and separate confirmed speaker profiles. It does not start the stable app's watchers, recovery, recording, exports, vault sync, or processing queue.

The stable application code path and 1.14.11 version remain unchanged. Old speaker identities/vectors are preserved in the copy. New model profiles require explicit confirmation; uncalibrated similarity guesses are not auto-applied. No private meeting library was copied or processed during development.

## Verification evidence

- Native helper compiled against pinned Argmax OSS 1.1.1. Swift validation suite: 2 tests passed.
- Targeted beta/process suites: 21 tests passed, covering database/file isolation, credential stripping, atomic import, cancellation, traversal/symlink rejection, changed source inventory, malformed/failed helper output, saved originals, unknown vectors, explicit enrollment, model isolation, and repeated-run label safety.
- Production build, whole-repository zero-warning lint, renderer types and documentation checks passed.
- Full disposable Tart run passed on source `5cfe875`, including 1,369 tests passed, 6 skipped; native audio helper; main/renderer/fixture types; build; docs; lint; Browse benchmark; all existing renderer fixtures; and the new beta UI/audio/notes comparison fixture. Guest: macOS 27 (build 26A428), arm64, Node 22.23.2, Electron 44.7.0. The runner confirmed deletion of its disposable VM. No hosted status or remote gate was posted/claimed.
- Retained full-run logs: `~/Library/Logs/MacOS Test Suite/meetingnotes/meetingnotes-test-20261016180803-47102-7a893c5c/`.
- Beta UI was also checked on the physical host against a disposable synthetic library, with a screenshot and actual copied-audio loading. This is not a signed-in or private-library acceptance claim.
- Physical-host native smoke passed with generated system-voice audio: public SpeakerKit files downloaded without credentials and verified against pinned hashes; one voice and a usable raw centroid returned; Apple's actual word timing validated.
- The signed helper inside the packaged app separately transcribed/diarized the synthetic clip successfully (23 timed word runs, one speaker, one usable centroid). Whole-app deep/strict signature verification passed.

## Measured feasibility, not a promotion decision

Two short synthetic English clips were run twice each through Apple, the current cached `ggml-medium.en.bin` using a task-owned Whisper server, and the benchmark-only FluidAudio 0.17.7 Parakeet v2 adapter. All 12 runs completed; all three engines had zero edit errors over 108 reference words per engine across the repeated runs, under the harness's basic normalization.

| Engine | Four observed wall times |
| --- | --- |
| Apple | 262, 189, 211, 232 ms |
| Whisper medium.en | 553, 542, 568, 550 ms |
| Parakeet v2 | 255, 206, 197, 197 ms |

These are very short, clean TTS clips, not meeting speech. Whisper's dedicated server was already loaded; native helper invocations included their process/model initialization, with OS compilation caches warm. The first Parakeet setup/download/load took about 24 seconds separately. Neither the small corpus nor these differing lifecycle costs establish a universal speed/accuracy ranking. Parakeet model assets use the upstream loader rather than a pinned beta manifest; it is not shipped or promoted.

A separate 75-minute repeated-synthetic stress test produced 13,015 timed word runs with transcript and diarization coverage in all 75 minute buckets and final speech near the end. Transcription took about 40.0 seconds; SpeakerKit about 13.0 seconds on this host while other verification work was running. It detected one speaker with one usable centroid. This establishes bounded long-file feasibility/timeline coverage for that synthetic input, not spontaneous meeting accuracy, overlap quality, peak memory, or calibrated identity matching.

Raw synthetic artifacts/results stay ignored under `speech-benchmark-results/`. No private audio or transcripts are included in this report.

## Local build artifacts

- `release/beta/MeetingNotes-Beta-1.15.0-beta.1-arm64.dmg` — approximately 128 MiB; SHA-256 `42a30771687d961704ace9caa5d3174747060b87968cc68b0f1642ed09aca001`.
- `release/beta/MeetingNotes-Beta-1.15.0-beta.1-arm64.zip` — approximately 139 MiB; SHA-256 `b3b8d31dd2f3f5afe49f5b6a2e1d8498fda34463eb20154924c612d062965de2`.
- Bundle ID `com.dbbaskette.meetingnotes.beta`, version `1.15.0-beta.1`, arm64, macOS 26 minimum. No stable URL scheme is registered.
- Signed with the existing local Apple Development identity. **Not notarized**: notarization was not configured. No installer was published or installed over the stable app; no application launch or private-library import was performed by the beta package check. The clean-VM check used source UI, not an installer payload; packaged native helper checks ran separately on the physical Mac.

## Remaining before stable promotion / closing #274

Representative licensed or explicitly approved real speech; accents/noise/overlap; held-out cross-meeting and cross-microphone speaker calibration with measured false matches and misses; real long-meeting memory/quality; integration into stable provider selection/onboarding; and any later packaging/fallback-removal decision. The beta deliberately exposes review-only suggestions until those gates pass.

First user test: install the separate beta, finish/close stable before copying, choose the existing library, then compare one short familiar meeting in transcript-only mode and full native speech mode. Confirm several known voices and check suggestions in a different meeting. Originals, stable notes/profiles and external vaults should remain untouched. See the [workflow](../guide/speech-beta.md).
