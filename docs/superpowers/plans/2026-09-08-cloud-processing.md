# Cloud Processing Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the tasks in order with task reviews. User has approved implementation; proceed without additional design gates.

**Goal:** A runnable experimental CF processing service and integrated Mac remote mode, with durable transfers, jobs and local speaker review.
**Architecture:** PostgreSQL-backed API/worker, S3 multipart object transfer, local durable remote coordinator separate from the existing local serial pipeline.
**Tech Stack:** TypeScript/Node, PostgreSQL, S3 SDK, Python pyannote and transcription provider, Electron/React/SQLite.
**Spec:** docs/superpowers/specs/2026-09-08-cloud-processing-design.md

## Global Constraints

- Keep recording, playback, recovery, the Library, voice roster, speaker naming, editing, and exports on the Mac.
- Start with one owner and one authoritative Mac library. Authenticate the desktop client with a revocable API token.
- Container disk is temporary workspace only.
- 1 GiB source file, 8-hour decoded duration, 16 MiB upload parts, two concurrent part uploads, 10 queued jobs per owner, and one running audio job per worker.
- Heartbeat every 15 seconds and a 120-second lease; three transient processing attempts.
- Default local mode; no automatic local fallback after remote submission.
- Use synthetic data for verification. TP deployment and real inference performance remain conditional on available platform resources; never claim unperformed deployment.
- Tests at coherent milestones; no mandatory red-green ceremony. All edits use apply_patch; dependencies installed with scripts disabled before reviewed native rebuild.
- Server-only dependencies in independent server/package.json and lockfile, not Electron production dependencies.

## Task 1: Remote service and worker

Files: create shared/remote-contracts.ts; server/package.json, tsconfig.json, src/{config,db,objects,api,worker,processor}.ts (split helpers as needed), migrations/001-jobs.sql, tests/*.test.ts, Dockerfile, manifest.yml, compose.yml, README.md; server Python inference adapter and pinned dependency file if needed. Modify root vitest config only if shared tests need it; do not change Electron runtime in this task.

Interfaces: export Zod contracts and inferred types from shared/remote-contracts.ts. Use `/v1` endpoints and states in the approved spec. Audio result uses existing `{segments:[{start,end,text}]}` transcription and `{segments:[{start,end,speaker,embedding}],num_speakers}` diarization shapes plus embedding model identity. Text input has transcript, summaryDetail, title and disableThinking; output contains summary markdown and validated action items. Document exact capability profile, request and result contracts for Task 2.

- [ ] Implement token-hash authentication with owner scoping and rotation; validated configuration, bounded request bodies, safe errors and rate/capacity limits.
- [ ] Implement PostgreSQL job/idempotency transactions, atomic claims, leases/generation fencing, revisioned transitions, attempts, cancellation, acknowledgement and content-free tombstones.
- [ ] Implement S3 multipart sessions, refreshed presigned part URLs, authoritative part reconciliation, size/digest verification, artifact manifests and cleanup retries. Do not buffer whole source in memory.
- [ ] Implement independent API and worker entry points with graceful shutdown, scratch cleanup and phase-only logging. Worker outputs use immutable attempt keys; results publish only through lease fencing. Expired/cancelled/deleted state blocks publication.
- [ ] Implement actual provider adapters: server-configured OpenAI-compatible transcription/LLM with bounded calls, local Linux pyannote invocation, decoded duration limits and CPU-safe default. Share existing prompt/output logic where feasible. Include an explicitly enabled deterministic synthetic processor for integration tests; never select it silently in production.
- [ ] Deliver Linux container, CF manifest and local PostgreSQL/S3 development setup. Linux sidecar cannot reuse macOS frozen bundle. Pin new dependencies and document provider/model licensing and embedding provenance.
- [ ] Tests must prove auth/owner rejection, same-intent replay and mismatched payload conflict, multipart interruption/completion retry, stale lease rejection, cancellation publication race, finite embeddings, immutable result hashes and retention retries. Use actual Postgres/object storage if locally available; report explicit gaps if not.
- [ ] Run service typecheck/test suite; record exact commands and results, self-review, commit Task 1. Report contract names and executable synthetic smoke entry point.

Example invariant to assert in a real storage test:
```ts
// Two workers cannot both publish after lease takeover.
expect(await store.complete(oldLease, manifest)).toBe(false);
expect(await store.complete(currentLease, manifest)).toBe(true);
```

## Task 2: Mac remote processing integration

Files: create electron/main/remote/{client,coordinator,repository,credentials,importer}.ts and tests (split cohesive helpers as needed); modify electron/main/index.ts, ipc/{handlers,contracts}.ts, preload/index.ts, storage/{migrations,settings-repo}.ts, renderer settings/Library/detail components as required. Add focused renderer RemoteProcessingSettings component. Consume Task 1's actual shared contracts without duplicating schemas.

Interfaces: `RemoteCoordinator` accepts persistent SQLite repositories, configuration/credential provider, pipeline stage helpers and notification callbacks. Exposes start(meetingId), continueFromSpeakerId(meetingId), cancel/retry/fallback, status and start/stop lifecycle. New IPC endpoints must have preload parity, boundary validation and no secret readback.

- [ ] Add default-local processing settings and secure credentials. Mac Keychain stores the API token; endpoint identity binds it and pins existing runs. A token can be entered/replaced and tested without returning it to the renderer. Explicit remote mode copy explains audio/transcript upload.
- [ ] Add durable outbox/run state and resumable upload client. Snapshot source/settings, stream SHA-256 and use server multipart reconciliation, bounded parts and request deadlines. Keep pending uploads across network loss or app closure. Persist stable idempotency keys before requests. Validate download URL schemes, bounded bodies, manifests and artifact schemas.
- [ ] Add independent coordinator: remote starts do not block the local queue; reconcile unfinished runs on startup; poll with bounded backoff; accepted jobs survive app shutdown. Route starts, batch starts, speaker gate continuation, reruns, deletion and recovery according to the run's mode, never global settings changes mid-run.
- [ ] Import audio analysis into an immutable local generation and transactionally publish its pointer/run state. Integrate artifact reads/merge with the new active-generation paths or provide an equally crash-safe journal/replay adapter for existing flat-file readers. Preserve local revisions and manual assignments; unknown embedding identity requires manual naming. Zero vectors remain unknown.
- [ ] Run existing local merge/identification where compatible and park at speaker gate. Continue submits a separate labeled-transcript text job. Import summary/action items with edit fencing and exactly-once local import bookkeeping. Reuse local completion/export paths with durable dedupe for side effects where needed.
- [ ] Show remote settings, connection test, per-run upload/queue/processing/download/offline state and contextual retry/cancel/local-fallback actions. Local inference setup is not required for remote meeting processing; weekly remains explicit local behavior.
- [ ] Test restart during upload/import, late result vs user edits/delete/rerun, source mutation, endpoint/token changes, incompatible embeddings, naming/skip, repeated import/exports, shared contract validation and local-mode regression.
- [ ] Run targeted tests, renderer/main typechecks, full application suite once, self-review and commit Task 2. Report supported UX and any remaining constraints explicitly.

Example import requirement:
```ts
// A remote result from run A must not replace an edit or newer run B.
expect(await importer.publish(resultA, expectedRevisionA)).toEqual({status: 'conflict'});
expect(readLocalSummary()).toBe(userEditedSummary);
```

## Task 3: Integrated validation and operator handoff

Files: server/README.md, docs/cloud-processing.md, synthetic smoke scripts/tests and narrow integration fixes as required.

- [ ] Run one complete synthetic audio-analysis/naming/text-generation flow using real service state/storage when available; validate offline/restart/cancel behavior at the service and client boundary.
- [ ] Inspect platform tooling read-only. Do not deploy or upload real recordings. Record explicit infrastructure validation commands, required bindings and measurements to collect before TP deployment.
- [ ] Run relevant full suites, build, dependency audit and API/desktop integration checks. Restore native SQLite module for Electron after Node tests.
- [ ] Document running locally and on CF, token setup/rotation, object lifecycle rules, resource hypotheses, limitations, rollout and rollback. Preserve local original audio and additive database compatibility.
- [ ] Commit verification/operator documentation; final independent branch review then resolve findings before handoff. Keep the experimental branch separate; no merge into main or automatic publication.

Coverage review: service durability/security/retention and CF packaging are Task 1; local ownership/transfer/UX are Task 2; cross-boundary reliability and platform qualification are Task 3. TP performance itself requires target access and is never substituted with synthetic timing claims.
