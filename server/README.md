# Experimental remote processing service

This is an independent Node service and worker. The Mac remains the authoritative library. Nothing here deploys a service, reads a local recording library, or silently chooses synthetic inference.

The end-to-end operator procedure, desktop setup, security ledger, rollout and rollback are in [`../docs/cloud-processing.md`](../docs/cloud-processing.md). This service README is the executable protocol and service-runtime reference.

## Run the complete synthetic storage smoke

From `server/`, with Node 22.15+ and Docker Desktop running:

```sh
npm ci --ignore-scripts
docker compose -p meetingnotes-remote-synthetic up -d --wait
npm run smoke
```

The compose project exposes PostgreSQL **16.14** at `127.0.0.1:55432`, MinIO **RELEASE.2025-09-07T16-13-09Z** at `127.0.0.1:59000`, and its console at `127.0.0.1:59001`. Images are pinned by digest. Credentials `synthetic` / `synthetic-local-only` are public test fixtures, never production credentials. No existing container or library is used. Tests create UUID-scoped PostgreSQL schemas and buckets, remove their own objects/schema/bucket, and leave the compose stack available for desktop integration. `docker compose -p meetingnotes-remote-synthetic down` removes only this stack; it has no host-mounted data or shared volumes.

The smoke executes the real HTTP-handler contracts and real S3 transfers: authenticated creation, interrupted two-part upload, API restart reconciliation, completion retry after the S3/DB crash boundary, leased verification, synthetic audio results, an explicitly named transcript snapshot, a separate text job, manifest/hash validation, acknowledgement and cleanup. It also exercises concurrent claims, stale lease fencing, cancellation, transient checkpoint reuse, three-attempt exhaustion, late-write sweeps, owner rejection and rate limits. Synthetic outputs are deterministic fixtures, **not transcription or quality benchmarks**.

For a persistent synthetic API/worker usable by the desktop, run:

```sh
npm run local:setup
npm run local:api
# In another terminal:
npm run local:worker
```

API: `http://127.0.0.1:58800`; stable service ID `synthetic-local`; owner `test-owner`; token `synthetic-test-token-000000000000000000000000`. The stable synthetic bucket is `meetingnotes-synthetic-local`. These explicit scripts bind the API to loopback and never activate providers. They print no credentials or meeting content. Production entry points below do not inherit their defaults.

## Wire contract for the desktop

`../shared/remote-contracts.ts` is the executable contract; import it rather than duplicating types. All protected calls send `Authorization: Bearer <token>`. Mutations additionally send a persistent, 8–200 character `[A-Za-z0-9_-]` `Idempotency-Key`; retain one key for each operation and payload, reuse it after unknown outcomes. Payload mismatch is 409. Signed URL renewal reuses the original intent but returns fresh URLs. Paths use server UUIDs, never local paths.

1. `GET /v1/capabilities` → `RemoteCapabilitiesSchema`: `schemaVersions:[1]`, stable `serviceId`/`ownerId`, one `profiles[]` entry, limits and retention. Profile is `synthetic-v1` or `cpu-pyannote-v1`. **Use the returned digest**, never calculate a guessed profile. Digest covers model names, embedding identity, diarization revision, prompt version, context/duration/text limits. A changed profile fences incompatible queued jobs with `PROFILE_UNAVAILABLE`.
2. `POST /v1/jobs` body (`RemoteCreateJobSchema`): `{schemaVersion:1,kind:'audio_analysis'|'text_generation',clientMeetingId:<opaque 1..200 chars>,clientRunId:<UUID>,profileId,profileDigest,source:{bytes,sha256,contentType}}`. Returns 202 and `RemoteJobSchema` directly, with a relative `Location` header. Same intent replays the same job. Both kinds initially upload an object. **No transcript or title enters a control body or PostgreSQL row.**
3. `GET /v1/jobs/:id/upload` → `RemoteUploadSchema`: `{uploadId,partSize:16777216,state:'pending'|'uploading'|'verifying'|'complete',parts:[{partNumber,etag,bytes}]}`. Parts are authoritative S3 state; do not trust only local checkpoints. Session creation is durable and serialized; an orphan session from a crash is swept/lifecycle-aborted.
4. `POST .../upload-parts` with `{partNumbers:[1,2]}` → `RemoteUploadUrlsSchema`: `{parts:[{partNumber,url,expiresAt}]}`. Mint at most two URLs per call. Upload each 16 MiB part (last shorter) with an exact `Content-Length`; it is signed. Upload bodies go directly to private S3, not the API. Up to 64 parts/1 GiB, two concurrent client uploads. URLs last 15 minutes and are renewable without a new job.
5. `POST .../upload-completion` with `{}` → 202/current job. API reconciles S3 parts/size and idempotently completes multipart; a leased worker then streams SHA-256 verification. State remains `uploading`, phase `verifying_upload` until verified. Text JSON is validated before queuing. A returned 202 is **not** proof that digest verification succeeded; poll status.
6. `GET /v1/jobs/:id` → `RemoteJobSchema`: `{id,kind,clientRunId,state,phase,revision,cancelRequested,createdAt,updatedAt,resultAvailable,error}`. States: uploading, queued, running, succeeded, failed, cancelled. Phases include verifying_upload, queued, starting, transcribing, diarizing, summarizing, retry_wait, complete, failed, cancelled. Revision increases on fenced lifecycle/stage writes. Error is a safe `{code,retryable}` or null. Poll 5 seconds/back off to 60; 429/503 include `Retry-After`.
7. `GET .../result` → `RemoteResultSchema`: `{manifest,manifestDigest,downloads:[{name,url,expiresAt}]}`. `RemoteManifestSchema` has `{schemaVersion:1,jobId,clientRunId,profileId,profileDigest,generation,artifacts:[{name,bytes,sha256,contentType:'application/json'}]}`. The artifact set is exactly `transcription`+`diarization`, or `text`. Manifest digest is SHA-256 of recursively key-sorted JSON with no whitespace (array order retained), not ordinary response serialization. Hash downloaded artifact **raw bytes** before parsing. All URLs expire after 15 minutes and can be refreshed through this endpoint. Results use immutable attempt-specific keys; DB generation/lease fencing is the sole publication authority.
8. `POST .../acknowledgements` with `{manifestDigest}` after durable local import → current job. Wrong digest is 409. `POST .../cancellation` with `{}` fences and cancels active work immediately. `DELETE /v1/jobs/:id` → 204; tombstones revoke lookup/download authorization and async cleanup removes all objects. Previously minted URLs cannot be cryptographically revoked before their 15-minute expiry; deletion of their object removes access sooner.

Text input object (`RemoteTextInputSchema`): `{transcript:<labeled text>,summaryDetail:'concise'|'standard'|'detailed',title:string|null,disableThinking:boolean}`. Maximum JSON object 2,000,000 bytes; default transcript cap 24,000 characters. Provider calls additionally enforce UTF-8 byte upper-bound token accounting including system prompt, framing, and output reserve; a byte-level BPE provider with at least the configured `LLM_CONTEXT_TOKENS` is required. Oversize content returns `CONTEXT_LIMIT`, not silent truncation or untested chunking.

Artifacts:

- `RemoteTranscriptionSchema`: `{segments:[{start,end,text}]}`, finite ordered seconds.
- `RemoteDiarizationSchema`: `{segments:[{start,end,speaker,embedding}],num_speakers,embeddingIdentity,warnings}`. Identity is `{repository,revision,preprocessing:'mono16k-pcm16-turn-v1',dimension,normalization:'l2'}`. Real vectors come specifically from the staged **pyannote/embedding** model, not anonymous pipeline-internal embeddings. Invalid/zero/wrong-dimension vectors become `speaker:'unknown',embedding:[]` with a warning. Do not automatically match a legacy/unknown or different identity, even if its dimension matches.
- `RemoteTextResultSchema`: `{summary:<markdown>,actionItems:[{text,owner:string|null,due_date:'YYYY-MM-DD'|null}]}`. Existing summary and action-item prompts are imported unchanged from the Electron-independent prompts module. Model output is validated, never executed.

Error envelope (`RemoteErrorSchema`): `{error:{code,message,retryable,requestId}}`. 401 credential error; 404 missing/not owned/tombstoned resource (avoids existence disclosure); 409 intent/state/profile conflict; 413 size; 422 content; 429 capacity; 503 dependency unavailable. Errors never contain provider bodies, signed URLs, paths or stack traces.

## Production configuration and inference

Production entry points: `npm run migrate`, `npm run api`, `npm run worker` during development; container commands are `node dist/server/src/{migrate,api,worker}.js`. API binds platform `PORT` (8080 default). Separate processes share PostgreSQL and S3; the API never waits for model inference. Each worker handles one job at a time; STT and diarization run sequentially. Whole-job timeout defaults to one hour and can be configured up to two hours; provider requests/subprocesses and S3 operations are bounded independently. SIGTERM stops claims, aborts fetches/subprocesses, and removes its generated scratch directory. SIGKILL may leave scratch until container recycling; container scratch must not be a shared persistent volume.

Required environment:

| Setting                                                                  | Meaning                                                                                                    |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                           | PostgreSQL URL with TLS policy appropriate for the binding; max pool 10, connect 5s/query 30s              |
| `S3_ENDPOINT`, optional `S3_PUBLIC_ENDPOINT`                             | Internal server endpoint and externally reachable desktop signing endpoint; production HTTPS required      |
| `S3_BUCKET`, `S3_REGION`                                                 | Existing private bucket and region (`us-east-1` default)                                                   |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY`                                         | Least-privilege server bucket credentials, never desktop credentials                                       |
| `SERVICE_ID`                                                             | Stable installation identity; do not change during rolling rotation                                        |
| `TOKEN_HASHES_JSON`                                                      | JSON array of `{ownerId,sha256,expiresAt?}`; SHA-256 hashes of high-entropy bearer tokens only             |
| `PROCESSOR`                                                              | `providers` default; synthetic requires explicit `ALLOW_SYNTHETIC=true` AND non-production `NODE_ENV`      |
| `TRANSCRIPTION_URL`, `TRANSCRIPTION_MODEL`, optional `TRANSCRIPTION_KEY` | Complete server-reachable OpenAI-compatible `/v1/audio/transcriptions` URL; verbose JSON segments required |
| `LLM_URL`, `LLM_MODEL`, optional `LLM_KEY`, `LLM_CONTEXT_TOKENS`         | Complete server-reachable `/v1/chat/completions` URL and truthful model context (32768 default)            |
| `DIARIZATION_MODEL_PATH`, `EMBEDDING_MODEL_PATH`                         | Controlled-staging local Linux pipeline YAML/checkpoint paths; all referenced models must also be local    |
| `DIARIZATION_REVISION`, `EMBEDDING_REVISION`, `EMBEDDING_DIMENSION`      | Verified immutable asset provenance; default dimension 512, never infer compatibility from this alone      |

Optional admission settings only lower the planned maxima: `MAX_SOURCE_BYTES` ≤1 GiB, `MAX_DURATION_SECONDS` ≤28800 (default **3600**), `MAX_QUEUED_JOBS` ≤10. CPU/disk admission must be qualified before increasing defaults. `MAX_TEXT_CHARACTERS` ≤500000. `INFERENCE_TIMEOUT_MS` 1000..7200000.

STT and LLM execute on the configured **server-reachable endpoints**, not on the Mac. They may be separately CF-hosted services or approved inference providers. This package does not host Whisper/LLM weights. Inside the worker, ffmpeg decodes once to bounded mono 16k PCM; STT receives 5-minute PCM chunks to stay below common provider upload caps. Diarization invokes `server/python/diarize.py` on Linux CPU with two torch/OpenMP threads, offline staged models, and explicit per-turn embeddings. It cannot use the macOS frozen bundle or Apple MPS. Supported demuxers are restricted; URL/network playlists are not accepted. Model staging must verify matching weights/checksums/repository commits, licenses, egress, and YAML references; setting a revision string alone does not verify assets.

Docker build context is the repository root: `docker build -f server/Dockerfile -t <approved-image> .`. Pins: Node 22.23.1, Python 3.11 package, ffmpeg 7.1.1, torch/torchaudio 2.5.1 CPU, pyannote.audio 3.3.2, NumPy 1.26.4. Python top-level versions are pinned; a platform-specific fully transitive/hash-locked model environment and image vulnerability scan remain production qualification work. **The full Linux/Python image and real model inference have not been built/benchmarked in this implementation verification.** `manifest.yml` is an unpushed template with separate web/worker processes. It assumes image support and operator-supplied bindings; this service intentionally does not guess arbitrary `VCAP_SERVICES` layouts. Map bindings to the environment contract using the platform's secret mechanism before starting either process.

The root `.dockerignore` is an allowlist for only the service package/build inputs, source/tests/scripts, migrations/Python code, the shared remote contract, and the shared prompt module. The Dockerfile also copies those paths explicitly; host `node_modules`, `.env*`, local libraries, Git data and other workspace content are neither sent in the build context nor copied into an image layer. Keep both controls when adding a build input, and inspect `docker build --no-cache --progress=plain -f server/Dockerfile -t <approved-image> .` before publishing anything. A successful local image build proves packaging only—not foundation architecture, vulnerability posture, model staging or inference quality.

MinIO is AGPLv3; review its use/distribution requirements. pyannote.audio code, diarization/segmentation/embedding model repositories, torch, ffmpeg build options and configured STT/LLM providers have separate licensing/terms. Accept gated model terms and verify model cards/revisions in controlled staging; do not bake access tokens into images. No license acceptance or model download was performed here.

## Durability, rotation and retention

Workers atomically claim using PostgreSQL `FOR UPDATE SKIP LOCKED`, heartbeat every 15 seconds, and hold a 120-second lease. Every phase, checkpoint and publication checks generation, worker identity, unexpired lease, nondeleted state and cancellation. Three transient attempts use 10/20/40-second exponential backoff; lost third leases become terminal failures. Valid checksummed stage artifacts are reused on retry. A failed/rejected job has no automatic unlimited retry; an explicit new processing run uses a new run ID/key. A content-free deleted intent returns 409 during its 90-day retention rather than creating another job. **After tombstone expiry the desktop must demand explicit reprocessing; the server cannot recognize an expired intent forever.**

Generate bearer tokens with a cryptographically secure generator (at least 32 random bytes); retain raw tokens only in the desktop Keychain/operator secret manager. Hash the exact token bytes using SHA-256; do not store raw tokens in server configuration. Rotate by deploying old+new hashes mapped to the same stable owner, with a short `expiresAt` on the old hash, then removing it and rolling all API instances. Existing jobs remain owner-scoped; changing token ownership does not transfer jobs. Protect configuration changes and avoid logging environment variables. TLS termination must be trusted; the service does not accept user-supplied forwarding headers as authorization.

Janitor runs from workers between jobs, retries errors with capped exponential backoff, and re-sweeps every 24 hours to catch late fenced output writes. Abandoned uploads expire at 24 hours. Acknowledged jobs remove source/intermediate data at 24 hours while retaining published results; all completed job data expires at 30 days. Deletion clears intent/manifests/checkpoints from DB and removes objects asynchronously; only content-free identifiers/hash tombstones remain for 90 days. Previously minted URLs remain usable until expiry/object deletion. Configure private bucket lifecycle as a backstop: abort incomplete multipart at one day; expire job objects after a suitable >30-day safety margin, accounting for long upload/processing time. Enable encryption at rest. If bucket versioning is enabled, lifecycle must also expire noncurrent versions/delete markers: application deletes alone do not erase historical versions. PostgreSQL/object backup retention and legal holds require a separately documented deployment policy; no backup deletion is claimed.

## Diagnostics and evidence

Logs allow only IDs, fixed phases/codes, byte counts, durations, attempts and RSS; no transcripts, speaker names, token values or signed URLs. API generates safe request IDs. `GET /v1/metrics` is authenticated: process-local HTTP/S3 cumulative counts, errors and histogram buckets; API RSS; owner-scoped queue count/oldest age, expired leases, retries and cleanup backlog. Counters reset on process restart. Worker emits stage start/completion/reuse durations and RSS plus job completion/failure and cleanup retry events. DB is the authoritative cross-instance state. Distributed tracing, a metrics exporter/scraper, alert routing, and full CPU/Python-child RSS aggregation are **not wired**; do not interpret API RSS as model memory.

Operator questions/runbook:

- **Where is a job stuck?** Inspect its phase/revision/updatedAt, then phase logs by job ID; check worker lease expiry. Queue age rising means worker capacity/connectivity needs investigation.
- **Are retries/leases rising?** Inspect retries/expired-leases gauges, job safe error codes and provider/S3 error histograms. Confirm inference/storage reachability and whole-job timeout before changing limits.
- **Is cleanup behind?** Inspect cleanup backlog and `cleanup_retry`; check bucket delete/abort permissions and connectivity. Restore access; the janitor will retry. Do not claim deletion until `cleaned_at` and bucket lifecycle evidence confirm it.
- **How long are stages taking?** Use per-stage duration events, input bytes, total job duration and process RSS; collect Linux peak whole-process-tree RSS and scratch separately. Alert thresholds require measured foundation baselines; no untested production alert claims.

Verification commands: `npm run typecheck`, `npm run build`, `npm test` (unit/provider tests; real-storage case explicitly skipped unless enabled), `INTEGRATION=1 npm test` (full suite), `npm audit --omit=dev`, and `npm run smoke`. Tests use synthetic content only. No TP deployment, real recording upload, real-provider quality/performance comparison, production token rotation or backup-retention operation was performed.
