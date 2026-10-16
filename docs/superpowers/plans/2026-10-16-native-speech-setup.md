# Native speech processing: Apple transcription and SpeakerKit speaker-ID replacement

Date: 2026-10-16
Status: Experimental beta implementation in progress; stable promotion gates remain open.
Tracking issue: [#274](https://github.com/dbbaskette/MeetingNotes/issues/274).
Baseline inspected: `f4239a4d11ffa6672efbdc0dfb3f586fb2cd39b9` (1.14.11).

## Outcome and decision

Make Apple SpeechTranscriber the recommended transcription provider on supported Macs, subject to a measured quality gate. Replace Python speaker processing on the recommended path with SpeakerKit OSS inside a bundled Swift helper, subject to speaker-quality and identity-migration gates. This includes both within-meeting diarization and persistent named-speaker recognition across meetings, not merely downloading a different diarization model. The recommended speech path should require neither a user-installed Whisper server nor a Hugging Face account/token.

## Speaker-ID architecture and deliverables

The existing Electron UI, roster, meeting library, and manual naming workflow stay in place. A new signed `meeting-notes-speech` Swift executable ships inside the app, separately from the recording helper. Electron starts it on demand and exchanges structured local requests/results over standard input/output; diagnostic logging stays on standard error. No listening HTTP service is needed for this helper.

| Responsibility | Proposed owner | Result |
| --- | --- | --- |
| Recognize words | Apple's SpeechTranscriber in the helper | Finalized text with timestamps |
| Separate voices within this recording | SpeakerKit OSS in the helper | Timed speaker turns and local speaker IDs |
| Represent each detected voice | SpeakerKit's raw speaker centroids | Model-tagged voice vectors; some speakers may have none |
| Recognize a saved person across recordings | MeetingNotes roster/matcher | A known roster ID or an unknown/reviewable speaker |
| Combine words, voices, and names | MeetingNotes merge stage | The existing speaker-attributed transcript and naming UI |

SpeakerKit is a Swift/Core ML implementation of pyannote-family processing, not Apple's speaker-recognition service and not an unrelated source of real-world names. Its clustering IDs are local to one processing run. MeetingNotes supplies the persistent identity layer.

Use the OSS `SpeakerKit` package product rather than the Argmax umbrella or Pro SDK. Inspect the resolved transitive graph: the v1.1.1 SpeakerKit target also depends on WhisperKit internally, but that does not require a Whisper server, downloading Whisper transcription weights, or using Whisper as our transcription provider. Keep the app's Apple adapter independent of SpeakerKit's WhisperKit-specific transcript-merge convenience API; consume timed turns and raw centroids directly.

The inspected v1.1.1 source exposes `speakerCentroidEmbeddings` in the raw, unnormalized, pre-PLDA embedder space for cross-run linking. It explicitly supplies no universal identity threshold and allows a speaker to have no usable centroid. Pin a verified SDK revision with that API and a separately identified model revision/preprocessing configuration; never persist a run-specific clustering representation as the roster's voice profile. Relevant sources: [centroid contract](https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/SpeakerKit/DiarizationResult.swift), [configuration](https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Sources/SpeakerKit/Pyannote/PyannoteConfig.swift), and [package graph](https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/Package.swift).

The user accepts requiring a newer macOS. Target Apple Silicon and macOS 26+ for the new recommended path; check actual engine and locale availability at runtime. Preserve existing Whisper/external and pyannote configurations during migration. The initial provider integration need not raise the minimum version for the entire app; making macOS 26+ mandatory for the installer is an explicit later rollout decision, not a requirement to remove working legacy support immediately.

This plan refines the speech portion of `2026-10-12-native-speech-and-simple-install.md`. That earlier proposal remains historical context, not a second implementation checklist. EG2/EmbeddingGemma transcription is not the selected integration: its complete embeddable implementation, timestamp contract, and redistribution terms remain unverified.

## Scope and limits

- Local, post-recording transcription of the same mixed timeline currently used for diarization.
- A separately installable beta with an isolated copy of the user's existing library and preserved before/after results for explicitly selected meetings.
- A bundled Swift processing helper, separate from the existing audio capture helper.
- Native transcription first; account-free diarization and speaker identity second; simplified onboarding after each capability actually works.
- No automatic reprocessing of existing meetings, replacement of saved notes, or loss of manual speaker assignments.
- No cloud inference, live captions, semantic search, independent-stem transcription, capture rewrite, bundled summary runtime, or public installer distribution in this issue.
- Summary generation continues using the existing LM Studio/Ollama/external provider. Audit remaining ffmpeg/ffprobe usage separately before claiming Homebrew-free or fully dependency-free setup.
- Implementation of the beta was authorized on 2026-10-16. This does not authorize publication, merging to main, or automatic processing of private meetings. A user selects the library copy and meeting reruns in the beta.

## Evidence and current boundaries

- [Apple's SpeechAnalyzer introduction](https://developer.apple.com/videos/play/wwdc2025/277/) describes on-device, long-form transcription, timestamps, streaming results, and system-managed speech assets. SpeechTranscriber is the recognizer; SpeechAnalyzer manages the session. The model may need an initial download.
- [Reproducible third-party accuracy tests](https://github.com/verliapp/stt-benchmark#on-device-results-apple-vs-whisper-vs-parakeet) show Apple competitive with Whisper and behind Parakeet on harder earnings-call audio. These are not MeetingNotes measurements; no speed or accuracy improvement is guaranteed.
- [Argmax OSS](https://github.com/argmaxinc/argmax-oss-swift) and its [SpeakerKit model repository](https://huggingface.co/argmaxinc/speakerkit-coreml) are the first native speaker candidate. Verify the selected SDK/model revisions, licenses, anonymous access, raw embedding semantics, and actual inference; do not confuse the OSS offering with the paid Pro SDK.
- [FluidAudio](https://github.com/FluidInference/FluidAudio) supplies the Parakeet comparison candidate and a possible speaker alternative. Review licenses and OS requirements per selected model, not only the Swift package manifest.
- `electron/main/pipeline/stages/transcribing.ts` currently wakes Whisper, converts/chunks audio, and writes timed segments to `transcript.raw.json`. `diarizing.ts` uses the same mixed timeline. `merging.ts` depends on aligned timestamps.
- `electron/main/pipeline/context.ts` couples STT to `LMStudioClient` and speaker processing to the Python client/supervisor. `electron/main/ipc/setup-health.ts` currently checks for Whisper and an HF token.
- `electron/main/speakers/embeddings.ts` stores vector dimensions but no model identity. New embeddings must never be compared with legacy vectors merely because dimensions match.

## Milestone 1 — Small local benchmark and go/no-go

**First implementation task.** Build a standalone evaluation harness before changing product defaults or onboarding.

**Files:** proposed `speech-engine/` Swift package; proposed `scripts/speech-benchmark/`; results under `docs/reviews/`. These directories do not exist yet. Reuse current Whisper configuration as the baseline rather than assuming a particular model or implementation.

**Work:** Compare current Whisper, Apple SpeechTranscriber, and one pinned FluidAudio/Parakeet configuration on the same physical Apple Silicon Mac. In the same feasibility milestone, compare current Python speaker processing with OSS SpeakerKit for both diarization and cross-recording identity; do not defer discovery of missing identity APIs until after Apple integration. Start with licensed public/synthetic inputs: clear speech, distant/noisy speech, accents, technical terms, names, dates/numbers, negation, silence, overlap, and 60–90-minute audio. Speaker evaluation must include the same people across separate recordings, different microphones/channels, short turns, and genuinely unfamiliar people. Split enrollment/calibration audio from evaluation audio to avoid testing on the samples used to choose a threshold. Use a small approved set of representative real meetings only with explicit permission; keep audio/transcripts out of Git and GitHub.

Measure cold/warm processing time, total transcription time including conversion, peak helper memory and relevant system memory pressure, first-use download/setup behavior, completeness, WER, critical-term errors, and timestamp alignment. Include invalid media, cancellation, unsupported locale, missing assets/offline first launch, and interrupted download. Record hardware, OS build, app baseline, audio preprocessing, model/configuration, and reproducible scoring. Apple assets are OS-managed and cannot be assumed version-pinnable: record observable asset/locale details and test date instead.

**Promotion gate, fixed before running:** no missing sections or material timestamp drift; aggregate WER no more than one absolute percentage point worse than current Whisper on the agreed corpus; no material regression on reviewed names, numbers, negation, or technical terms. Report speed and memory rather than promising an arbitrary multiplier. If Apple fails, report that result and propose Parakeet or an opt-in Apple mode; do not silently lower the gate.

**Acceptance:** a written comparison and explicit go/no-go, with no default change and no private corpus published. Physical hardware owns performance evidence; a Tart VM does not establish Neural Engine speed. Implementer owns this milestone's harness and checks.

## Milestone 2 — Integrate Apple transcription, preserve compatibility

**Depends on:** milestone 1 acceptance.

**Files:** proposed `speech-engine/` and `electron/main/speech/`; existing `electron/main/pipeline/context.ts`, `pipeline.ts`, `stages/transcribing.ts`, `stages/merging.ts`; `electron/main/storage/settings-repo.ts`, `settings-validation.ts`; composition/lifecycle wiring in `electron/main/index.ts`; `electron-builder.yml`, `package.json`, and native build scripts.

Introduce a small transcription-provider interface with a shared timed-result contract, instead of replacing the summary client. Add an explicit provider setting: Apple or the current Whisper-compatible path. Persist the selected provider/configuration with each job and generated artifact; retries must not accidentally combine output from different providers.

Use a versioned structured helper protocol, validated results, local file arguments without shell interpolation, progress, cancellation, bounded execution, parent-exit cleanup, and one process owner. Keep recording independent of processing-helper failures. Check capability/locale before starting; explain missing assets and unsupported configurations with a recovery action. No silent cloud fallback or automatic switch of a user's selected endpoint.

Normalize final results into the existing `{ start, end, text }` artifact on the original mixed-audio timeline. Do not fabricate timestamps or concatenate volatile intermediate results as finalized speech. Validate finite times, bounds, ordering, and duration; preserve long-file offsets and terminology behavior. Reassess Whisper-specific hallucination filters rather than applying every heuristic unchanged to Apple output. Preserve successful existing artifacts on failed retries and invalidate dependent cache entries only after replacement succeeds.

**Acceptance/check owner:** implementer verifies provider selection/migration, timestamp merge, long inputs, silence, terminology, retry/cancellation, malformed protocol output, helper death, and recovery using targeted tests and a native harness. Existing users retain their settings. New installations use Apple only after its quality and packaged-runtime gates pass.

## Milestone 3 — Replace diarization and persistent speaker ID with SpeakerKit OSS

**Depends on:** a qualified speaker candidate; can be evaluated separately from transcription, but not promoted independently of identity/migration evidence.

**Files:** proposed native speaker adapter in the same helper; `electron/main/pipeline/stages/diarizing.ts`, `identifying.ts`, `merging.ts`; `electron/main/speakers/embeddings.ts`, `matcher.ts`, `roster-service.ts`, speaker storage consumers and naming/confirmation handlers; settings and persistence migrations.

Evaluate OSS SpeakerKit first, FluidAudio if needed. Verify clean-profile unauthenticated downloads and offline inference, exact licenses/notices, speaker counts/turns, overlap behavior, raw identity vectors, and long-meeting performance. Benchmark transcription and speaker scheduling together: competing for the Neural Engine may change the best execution order.

**Concrete deliverables:**

1. Bundle a native adapter returning speaker turns plus one model-tagged raw centroid per usable detected speaker, rather than duplicating that centroid in every turn. Provide a compatibility reader where current artifact consumers still expect per-turn embeddings. Distinguish successful no-speech output from inference failure.
2. Implement model-aware enrollment, roster lookup, ranked suggestions, and confirmed-profile updates. The current matcher's `0.75` cosine-similarity gate is not automatically valid for the new model. SpeakerKit's cosine-distance API also uses the opposite direction: smaller means closer. Calibrate the application policy, including a sufficient best-versus-runner-up separation and an unknown outcome for ambiguous/poor samples. A raw similarity score must not be presented as a calibrated probability of identity.
3. Preserve a roster person's stable ID/name while keeping legacy and new voice profiles separate. Existing names are immediately usable; recognition in the new embedding space starts only after enrollment. Offer an explicit selected-sample migration action or let the user confirm the person in a future meeting. Never blend legacy vectors, infer an identity from a matching display name alone, or silently bulk-extract historical audio.
4. Preserve manual assignments when the underlying detected-speaker identity is unchanged. A complete new diarization run can renumber or split local `SPEAKER_XX` labels; do not carry an old manual assignment to an unrelated voice just because the numeric label matches. Retain original assignments/artifacts and require evidence-based remapping or explicit review for changed clusters.
5. Make low-quality, missing, zero, or non-finite centroids recoverable unknowns, with normal manual naming/playback available. Naming must remain possible even when a usable voice profile cannot be enrolled. Do not contaminate a known person's profile with an automatic or uncertain match.
6. Provide clean-profile provisioning without existing HF credentials, download interruption recovery, and offline inference. The public repository and optional-token API support this design, but actual anonymous asset downloads have not yet been exercised. Package the MIT SDK and model-specific notices; the model repository declares CC BY 4.0. Verify the exact selected files and required attribution before redistribution. No Pro API key, subscription, or paid runtime is planned.

Add provider/model/revision identity to embedding storage and artifacts with backward-readable legacy metadata. Never compare or average different embedding spaces. Validate dimensions, finite values, and nonzero norms; unusable vectors become an unknown/reviewable speaker rather than `cannot normalize zero vector` or a guessed identity. Calibrate match thresholds against the new model; do not copy the existing threshold blindly.

Preserve speaker names, manual links, existing vectors, and all old transcripts. Enroll the new embedding space from explicitly selected local samples or user-confirmed future meetings. No bulk rereading/reprocessing of the library. Keep the legacy provider available during transition.

**Acceptance/check owner:** implementer compares diarization error, false identity matches, and missed-known-speaker rates against the current pipeline and records numerical gates/corpus before promotion. False identification is more harmful than asking for confirmation; report the unknown/review rate alongside false matches so an always-unknown matcher cannot claim success. Tests cover model-tag isolation, legacy reads, zero/NaN/missing vectors, per-recording label renumbering, ambiguous candidates, unknown people, confirmation-only enrollment, manual-link preservation, upgrade/restart, and no-token cold setup. Only a verified account-free speaker configuration can remove HF from its setup flow; the legacy path still explains its requirement. Do not promise a particular speedup, memory reduction, or installer-size reduction until measured; the Python fallback still occupies space while bundled.

## Milestone 4 — Clear setup UX and packaged validation

**Depends on:** milestone 2 for transcription UX; milestone 3 before advertising account-free speech setup.

**Files:** `electron/renderer/src/views/OnboardingView.tsx`, `SettingsView.tsx`, `electron/renderer/src/lib/setup-wizard.ts`; `electron/main/ipc/setup-health.ts`, `contracts.ts`, `channel-schemas.ts`, related handlers/preload; `electron-builder.yml`, native build/signing scripts, `scripts/ci/package-runtime.mjs`; `README.md`, `docs/guide/models.md`, `docs/guide/settings.md`.

Show a recommended native speech path, download/readiness state, progress, cancellation, retry, offline reuse, and an explicit sample check. Apple downloads use Apple's asset APIs and lifecycle; do not invent a pinned app-managed Apple model cache. Third-party assets use pinned revisions, integrity checks, adequate-space checks, temporary/atomic installation, and deduplicated downloads. Missing or partial assets never count as ready. Users may record while speech assets are unavailable; processing explains what is still needed without blocking capture.

Separate transcription, speakers, and summaries in readiness UI. Keep legacy endpoint/token controls under Advanced and show them only for the providers that need them. Summary setup remains explicit. Do not claim that Apple transcription alone removes the HF-token requirement or every external dependency.

Bundle/sign the helper and required resources; verify launch from the packaged app path, including spaces. Retain the Python sidecar while it remains the legacy fallback; removing it is a separate packaging decision. No public distribution, auto-updater work, or revival of closed #250 is part of this plan.

**Verification ownership:** implementers own targeted UI/setup/download/protocol checks at slice boundaries. One integration owner reads the existing local-CI guidance and runs the full relevant suite once on the settled integrated tree using the existing disposable Tart runner, retaining source/environment logs and required remote gates. A physical supported Mac owns real speech/Neural Engine/offline checks. Package evidence must cover clean-profile setup, upgrades, helper signing, and missing/corrupt assets; VM capability failures must not be presented as real-engine performance failures. No private meetings, production vaults, or credentials in CI.

## Completion checklist

- [ ] Benchmark report and engine go/no-go accepted; no published private audio.
- [ ] Apple timed transcription integrated with recoverable lifecycle and preserved legacy settings.
- [ ] SpeakerKit OSS replaces both diarization and cross-meeting speaker-ID extraction on the recommended path; quality gates met.
- [ ] Model-aware enrollment, suggestions, unknown handling, and confirmation-only profile updates work; identity migration and cluster-remapping are safe.
- [ ] Provider-specific setup accurately reflects downloads, permissions, and inference readiness.
- [ ] Clean-profile offline reuse and packaged upgrade checks pass; source tests and local CI recorded.
- [ ] README/model/settings docs describe the actual shipped capabilities and remaining summary/media dependencies.
- [ ] Side-by-side beta reads an isolated copy of existing meetings, retains original comparison results, and never writes to the stable library or external integrations.

## Milestone 5 — Side-by-side beta with old meetings and before/after comparison

**User-approved direction:** install a clearly labeled beta alongside stable MeetingNotes and use existing meetings to evaluate the new engines. Access to old meetings means a safe copied snapshot, not two applications sharing one writable library. This section specifies the workflow; it does not itself copy private data or authorize uploads/publication.

**Dependencies:** usable native providers and migration safeguards. Build the standalone benchmark first; do not wait for a polished comparison UI to establish engine feasibility.

**Files:** `electron-builder.yml`, `package.json`, `electron/main/index.ts`, storage/settings/backup paths, watcher and pipeline startup wiring, URL-scheme and shortcut registration; `electron/main/ipc/handlers.ts` rerun flow, artifact/history consumers, and meeting detail UI. Reuse the existing `electron/main/storage/library-backup.ts` snapshot patterns where appropriate after inspecting their consistency guarantees.

**Isolation:** use a distinct product name, bundle identifier, application data root, logs, library root, and artifact filenames. Do not register as the stable `meetingnotes://` handler, claim its global recording shortcut, auto-record calls, or adopt/control stable-owned processing services. Changing Electron `userData` alone is insufficient: the current settings database opens under a fixed Documents/MeetingNotes path and settings can redirect the library elsewhere. Beta initialization must not open either stable database through a writable/migrating connection. Resolve and reject aliases/symlinks that route beta writes into stable data.

**Import:** on first beta launch offer **Copy existing library for testing**, showing source, destination, estimated disk use, and that the stable library is untouched. Use a consistent SQLite backup/snapshot and a quiescent source for the matching files; never naively copy a live WAL database and assume it is complete. If capture/processing is active, ask the user to finish it or provide a supported consistent snapshot; do not stop stable automatically. Prefer real independent copies or supported copy-on-write clones, never hard links or writable symlinks. Copy required audio, existing transcript/notes/diarization artifacts, groups, terminology, roster names/voice profiles, and relevant history; rebase all stored paths to beta-owned locations. External/missing audio must be explicitly copied with confirmation or marked unavailable, not silently read/reprocessed by a background watcher. Do not duplicate credentials or carry over export destinations as active integrations.

**Startup safety:** copied jobs must not resume or reprocess automatically. Disable beta's legacy/external audio watch folders, auto-process/auto-record triggers, exporters/webhooks/Obsidian sync, calendar mutations, and other external writes by default. No beta output is synced into the production vault or action-item destination. Readiness shows which local summary provider, if any, the user explicitly chooses for beta; no silent adoption of the stable app's managed services.

**Comparison workflow:** show old meetings/groups in the beta library. Before any selected rerun, retain an immutable baseline of the original transcript, diarization, manual speaker assignments, notes, and relevant model/settings provenance. Existing transcript-history preservation alone is not a complete speaker-comparison baseline. Offer a clearly labeled transcript-only comparison (Apple versus saved transcript, retaining baseline speaker turns) and full speech rerun (new transcription plus SpeakerKit and roster matching). Preserve baseline notes/action items unless the user separately requests their regeneration. Show **Original** and **Beta result** through a simple toggle or split view, with shared audio timestamps, processing times when actually measured, and engine/model labels; older timings that were not recorded remain unavailable. Switching views does not mutate either result. Preserve results across restart and failed reruns; repeated tests must not overwrite the original baseline. Never compare speaker IDs by their local numeric suffix across runs.

This is an on-demand, one-time snapshot, not continuous two-way synchronization. Meetings created in stable afterward require an explicit later import; importing must never silently overwrite beta experiments or the baseline. No beta-to-stable merge of generated results or automatic profile conversion is included. Beta can be discarded while stable continues using its original data.

**Acceptance/check owner:** integration owner verifies side-by-side launch and recording-ownership behavior, consistent import/path rebasing, sufficient-space and interrupted-copy recovery, no auto-resume/external writes, unchanged stable fixture files/database, before/after comparison across restart, failed reruns, missing audio, and safe profile enrollment using disposable fixtures. Retain full-suite evidence for unchanged code; run affected integration checks after adding beta isolation. A first install and local private-library copy occur only under the user's authorized test workflow, never in CI. No installer has been built or installed by this planning update.

## Recommended next project after this issue

Simplify summary-model provisioning: evaluate one managed local summary runtime and a small set of hardware-appropriate presets, preserving existing providers and testing long transcripts/weekly reports. Audit native media conversion versus bundled ffmpeg alongside that project. That is the remaining path toward a genuinely one-app installation, not part of this speech-engine migration.

## Planning completion record

- [x] Inspect current speech pipeline, setup, packaging, and related open issues.
- [x] Save the revised staged plan without modifying the earlier untracked proposal.
- [x] Create the GitHub enhancement issue carrying this plan (#274).
- [x] Obtain implementation authorization and start milestone 1.

At planning time, no application code, models, installed data, or running services were changed.

## Implementation progress — 2026-10-16

Branch: `codex/native-speech-speakerkit`.

- Added a pinned Swift helper with Apple word timestamps, SpeakerKit raw centroids, bounded/versioned process protocol, cancellation, and parent-exit cleanup. The SDK transitively compiles WhisperKit; no Whisper transcription model or server is needed by the beta.
- Added a separately bootstrapped beta comparison app and build configuration. It does not import the stable startup/services. The existing stable provider/settings path remains unchanged pending promotion evidence.
- Added consistent copied-library import, path containment, external-audio copying, atomic publication, cancellation, settings/credential stripping, and readonly access to the original database. The beta never resumes copied jobs or enables recording/exports/sync.
- Added preserved original-versus-new transcript comparison, unchanged notes, audio playback, and model-isolated speaker enrollment/similarity suggestions. Uncalibrated suggestions are review-only, not automatic identity assignments.
- Added synthetic native/UI fixtures, fault-path tests, and Apple/Whisper/Parakeet comparison tools. The optional FluidAudio benchmark adapter is not bundled or used by the app.
- Physical-device smoke confirms anonymous pinned SpeakerKit downloads, usable centroids, Apple transcription, and true word timestamps. This is not a representative accuracy or long-meeting promotion gate.
- Beta evaluation is intentionally available before promotion: stable defaults are not changed. Remaining gates include the representative/approved-private corpus, long meetings, speaker error rates and held-out identity calibration, final stable provider migration/onboarding, and a decision about removing Python from stable packaging. No complete issue closure is claimed by the first beta installer.
- No private meeting has been imported or processed by this implementation session.
