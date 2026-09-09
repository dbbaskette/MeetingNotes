# Experimental remote processing: operator guide

This guide covers the optional remote-processing implementation on `codex/cloud-processing-design`, based on MeetingNotes 1.12.0. It is not part of the published 1.12.0 release, not deployed, and not production-qualified. Local processing remains the default. The Mac keeps the authoritative SQLite library, original recording, roster, edits, playback and exports.

Remote mode uploads a selected recording to private object storage, then uploads a labeled transcript snapshot for summary generation. Generated transcripts, speaker embeddings, summaries and action items are downloaded to the Mac; names enter the remote text snapshot after local review or skip. The server never receives a Mac path or the local roster. Closing the app does not cancel an accepted job; choosing **Process locally** explicitly fences/cancels the remote run before enqueueing local work.

## Local synthetic validation

Prerequisites are Docker Desktop and Node 22.15 or newer. These commands use only deterministic synthetic bytes/text and the isolated compose project; they do not inspect the MeetingNotes library or invoke a model provider.

```sh
cd server
npm ci --ignore-scripts
docker compose -p meetingnotes-remote-synthetic up -d --wait
npm run smoke
```

For a persistent endpoint used by the desktop integration test, keep the storage stack running and start these in separate terminals:

```sh
cd server
npm run local:setup
npm run local:api
```

```sh
cd server
npm run local:worker
```

The isolated endpoint is `http://127.0.0.1:58800`, owner `test-owner`, service `synthetic-local`, and token `synthetic-test-token-000000000000000000000000`. These are public test fixtures and must never be reused outside loopback synthetic tests. Stop only this fixture with:

```sh
cd server
docker compose -p meetingnotes-remote-synthetic down
```

Run the real desktop coordinator/importer boundary (temporary library and generated synthetic input only) with:

```sh
REMOTE_DESKTOP_INTEGRATION=1 node node_modules/vitest/vitest.mjs run \
  electron/main/remote/remote.test.ts
```

Run the real Electron UI/Keychain fixture after `npm run build`:

```sh
npm run verify:remote-ui
```

It assigns a temporary Electron `userData` directory and a separate temporary library, attempts the actual `RemoteCredentials`/Electron `safeStorage` path when encryption is available, and drives the real Settings and remote-status React components through connection, save, reconnect, cancel, confirmed local fallback, and both conflict decisions. It never loads the normal application main process, starts recording, touches the configured library or uses an external endpoint. Screenshot paths and the safeStorage result are printed on completion; an unavailable Keychain is reported rather than replaced with plaintext or a synthetic cipher.

On a new installation, select **Skip all** in the existing onboarding flow, open **Settings**, choose **Remote server**, enter the endpoint and token, select **Test connection**, review the returned service/profile identity, then select **Save processing location**. Testing alone does not authorize uploads or change the default. Local model setup remains needed for local fallback, Weekly, and auxiliary local AI features.

## Production-shaped local service

The API and worker are separate processes. PostgreSQL and a private S3-compatible bucket must already exist. Supply every required value from the environment table in [`../server/README.md`](../server/README.md); production validates HTTPS for object and inference endpoints and refuses the synthetic processor.

```sh
cd server
npm ci --ignore-scripts
npm run typecheck
npm run build
npm run migrate
npm run api
```

Start `npm run worker` in a separate process with the same database, object, identity, profile and token-hash configuration. Never share worker scratch as persistent storage. The desktop reaches the API and the `S3_PUBLIC_ENDPOINT`; the API/worker use `S3_ENDPOINT`. Test both routes from their actual network locations.

Build from the repository root because two allowlisted TypeScript modules are shared with the desktop:

```sh
docker build --no-cache --progress=plain \
  -f server/Dockerfile -t registry.example.invalid/meetingnotes-processing:<reviewed-digest> .
```

The root `.dockerignore` and explicit Dockerfile copies exclude host dependencies, `.env*`, Git data and local library content. Inspect the context and resulting image before pushing. Do not treat a local build as a Linux/model, license, vulnerability-scan or Tanzu Platform qualification.

## Tokens and rotation

Generate at least 32 random bytes in an operator-controlled shell or secret manager. This example keeps the raw value in a short-lived shell variable; send it only to the desktop Settings form and clear it afterward. The service receives only its lowercase SHA-256 hash.

```sh
REMOTE_RAW_TOKEN="$(openssl rand -hex 32)"
REMOTE_TOKEN_SHA256="$(printf '%s' "$REMOTE_RAW_TOKEN" | shasum -a 256 | awk '{print $1}')"
printf 'Desktop token: %s\nServer TOKEN_HASHES_JSON: [{"ownerId":"owner-1","sha256":"%s"}]\n' \
  "$REMOTE_RAW_TOKEN" "$REMOTE_TOKEN_SHA256"
```

Store the raw token in the macOS Keychain through Settings and the hash in the platform secret mechanism. Do not put either in source, a manifest, a vars file, logs or shell history. Unset `REMOTE_RAW_TOKEN` after entry.

Rotation is an overlap, not an ownership migration:

1. Generate a new token and add its hash with the same stable `ownerId`; retain the old hash with a short ISO `expiresAt`.
2. Roll every API instance with the two-hash configuration. Workers do not authenticate desktop calls but should receive a consistent service/profile configuration.
3. In Settings, enter the same endpoint and new token, **Test connection**, verify the same `serviceId`, `ownerId` and expected profile, then save. Old pinned jobs remain owner-scoped.
4. After all Macs have reconnected and the overlap expires, remove the old hash and roll every API instance again. A different owner ID cannot take over old jobs.

Never dump environment or service-binding credentials to validate rotation. A production rotation drill has not been performed.

## Tanzu Platform / Cloud Foundry procedure

No foundation is selected in the current validation session. Read-only `cfctx ls` previously reported `cdc` and `ndc`; no `cf` command has run. An operator must explicitly choose the foundation, org and space before using the procedure below. Replace these non-secret values first; do not copy a token, binding, service key or environment dump into the evidence directory.

```sh
CF_FOUNDATION=replace-with-explicit-choice
CF_ORG=replace-with-approved-org
CF_SPACE=replace-with-approved-space
CF_POSTGRES_OFFERING=replace-with-postgres-offering
CF_OBJECT_OFFERING=replace-with-object-offering
CF_POSTGRES_INSTANCE=replace-with-postgres-instance
CF_OBJECT_INSTANCE=replace-with-object-instance
CF_EVIDENCE_DIR=./cf-read-only-evidence-YYYYMMDD
mkdir -p "$CF_EVIDENCE_DIR"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$CF_EVIDENCE_DIR/00-captured-at.txt"
```

First select the approved org/space inside the chosen foundation context and capture the effective target. `cf target` changes CLI targeting only; it does not create or update a platform resource. Every command reasserts `cfctx` because each shell is independent.

```sh
zsh -ic "cfctx ${CF_FOUNDATION} && cf target -o '${CF_ORG}' -s '${CF_SPACE}' && cf target" \
  2>&1 | tee "$CF_EVIDENCE_DIR/01-target.txt"
```

Then run and capture this read-only preflight before any service creation, binding, push or task. These commands establish the foundation API, CAPI capabilities/stacks, org/space quotas, marketplace plans, existing service bindings and routes without returning binding credentials.

```sh
zsh -ic "cfctx ${CF_FOUNDATION} && cf api" \
  2>&1 | tee "$CF_EVIDENCE_DIR/02-api.txt"
zsh -ic "cfctx ${CF_FOUNDATION} && cf curl /v3/info" \
  2>&1 | tee "$CF_EVIDENCE_DIR/03-v3-info.json"
zsh -ic "cfctx ${CF_FOUNDATION} && cf curl /v3/stacks" \
  2>&1 | tee "$CF_EVIDENCE_DIR/04-stacks.json"
zsh -ic "cfctx ${CF_FOUNDATION} && cf org '${CF_ORG}'" \
  2>&1 | tee "$CF_EVIDENCE_DIR/05-org.txt"
zsh -ic "cfctx ${CF_FOUNDATION} && cf space '${CF_SPACE}'" \
  2>&1 | tee "$CF_EVIDENCE_DIR/06-space.txt"
zsh -ic "cfctx ${CF_FOUNDATION} && cf quotas" \
  2>&1 | tee "$CF_EVIDENCE_DIR/07-quotas.txt"
zsh -ic "cfctx ${CF_FOUNDATION} && cf marketplace" \
  2>&1 | tee "$CF_EVIDENCE_DIR/08-marketplace.txt"
zsh -ic "cfctx ${CF_FOUNDATION} && cf marketplace -e '${CF_POSTGRES_OFFERING}'" \
  2>&1 | tee "$CF_EVIDENCE_DIR/09-postgres-plans.txt"
zsh -ic "cfctx ${CF_FOUNDATION} && cf marketplace -e '${CF_OBJECT_OFFERING}'" \
  2>&1 | tee "$CF_EVIDENCE_DIR/10-object-plans.txt"
zsh -ic "cfctx ${CF_FOUNDATION} && cf services" \
  2>&1 | tee "$CF_EVIDENCE_DIR/11-services-and-bindings.txt"
zsh -ic "cfctx ${CF_FOUNDATION} && cf routes" \
  2>&1 | tee "$CF_EVIDENCE_DIR/12-routes.txt"
zsh -ic "cfctx ${CF_FOUNDATION} && cf domains" \
  2>&1 | tee "$CF_EVIDENCE_DIR/13-domains.txt"
```

If the named service instances already exist, capture their plan/state metadata with `cf service`; never use `cf env`, `cf ssh-env`, `cf service-key`, `credhub get`, or a command that prints credentials.

```sh
zsh -ic "cfctx ${CF_FOUNDATION} && cf service '${CF_POSTGRES_INSTANCE}'" \
  2>&1 | tee "$CF_EVIDENCE_DIR/14-postgres-instance.txt"
zsh -ic "cfctx ${CF_FOUNDATION} && cf service '${CF_OBJECT_INSTANCE}'" \
  2>&1 | tee "$CF_EVIDENCE_DIR/15-object-instance.txt"
```

For candidate endpoints supplied through the approved inventory—not discovered by dumping bindings—capture content-free TLS/reachability evidence from the operator workstation. The API must return a successful `/healthz`; the private object endpoint may return 401/403/404 without credentials, but DNS, TLS hostname validation and a completed HTTP response must succeed.

```sh
REMOTE_API_URL=https://replace-with-approved-api-route
S3_PUBLIC_ENDPOINT=https://replace-with-approved-object-endpoint
curl --proto '=https' --tlsv1.2 --fail-with-body --silent --show-error \
  "$REMOTE_API_URL/healthz" | tee "$CF_EVIDENCE_DIR/16-api-health.txt"
curl --proto '=https' --tlsv1.2 --silent --show-error --output /dev/null \
  --write-out 'http_code=%{http_code} remote_ip=%{remote_ip} tls_verify=%{ssl_verify_result}\n' \
  "$S3_PUBLIC_ENDPOINT/" | tee "$CF_EVIDENCE_DIR/17-object-reachability.txt"
```

Expected evidence is therefore the `00` capture timestamp plus the `01`–`17` command artifacts: exact API and selected target; `/v3/info` and stack inventory; org/space/quota output sufficient to compare the manifest's API 1 GiB and worker 8 GiB/10 GiB hypotheses; named PostgreSQL/object offerings and plans; service-instance and binding names/status without credentials; current routes/domains; and API/object TLS reachability. Add separately reviewed artifacts for image-deployment support, worker CPU/Linux architecture/termination grace, bucket encryption/lifecycle/versioning/backups/legal holds, inference egress, model licenses and staged model checksums. Hash the evidence files so later review can detect replacement:

```sh
find "$CF_EVIDENCE_DIR" -type f ! -name SHA256SUMS -exec shasum -a 256 {} + \
  | sort > "$CF_EVIDENCE_DIR/SHA256SUMS"
```

Only after the preflight is approved should an operator create/bind services, map bindings through the platform secret mechanism to the explicit variables in `server/README.md`, and run the mutating deployment procedure. The service intentionally does not guess `VCAP_SERVICES`. Build and scan an immutable image before setting these non-secret substitutions:

```sh
REMOTE_IMAGE=registry.example.invalid/meetingnotes-processing@sha256:replace-with-reviewed-digest
zsh -ic "cfctx ${CF_FOUNDATION} && cf push -f server/manifest.yml \
  --var approved-image='${REMOTE_IMAGE}' \
  --var postgres-service='${CF_POSTGRES_INSTANCE}' \
  --var object-service='${CF_OBJECT_INSTANCE}'"
zsh -ic "cfctx ${CF_FOUNDATION} && cf run-task meetingnotes-processing \
  --command 'node dist/server/src/migrate.js' --name migrate-remote-schema --wait"
zsh -ic "cfctx ${CF_FOUNDATION} && cf app meetingnotes-processing"
zsh -ic "cfctx ${CF_FOUNDATION} && cf processes meetingnotes-processing"
zsh -ic "cfctx ${CF_FOUNDATION} && cf logs meetingnotes-processing --recent"
```

Before accepting recordings, run synthetic 5-minute, 60-minute and multi-hour fixtures on the target Linux runtime and record wall time, queue time, model load, CPU allocation, whole process-tree peak RSS, scratch peak, object/database latency, upload renewal, cancellation latency, lease recovery, cleanup backlog and API/worker restarts. Set admission limits from those measurements. A TP deployment, binding check and model-quality run are still pending.

## Retention and deletion operations

Application policy is fixed in the current service: incomplete uploads expire at 24 hours; acknowledged source/intermediate content is deleted after 24 hours; completed job data expires after 30 days; and content-free idempotency tombstones remain for 90 days. Deletion immediately tombstones authorization, then the janitor asynchronously removes objects. A presigned URL can remain valid for up to 15 minutes unless its object is deleted sooner.

Configure the bucket as a backstop to abort incomplete multipart uploads after one day and expire job objects after a safety margin greater than 30 days. With versioning, also expire noncurrent versions and delete markers. Monitor `cleaned_at`, cleanup backlog/retries and bucket evidence; a tombstone response alone is not erasure proof. Align PostgreSQL/object backups and legal holds separately—this implementation does not delete backup copies.

The Mac retains the original recording and additive local schema. Remote generations, conflict backups and diagnostics follow the meeting-folder/trash lifecycle. The current slice has no dedicated “forget server” UI for encrypted historical endpoint credentials or content-free run diagnostics.

Analysis reruns treat cluster labels such as `SPEAKER_00` as generation-local, not person IDs. Names carry forward only through a confident match against local roster embeddings with verified identical model provenance; unmatched or ambiguous clusters need naming. Before replacing active meeting-speaker links, the importer retains the displaced assignments in `.remote-generations/<new-run-id>/previous-database.json` alongside the previous diarization/transcript files. Roster people and vectors are not removed. Edits made after submission still park the result for review; explicit replacement archives the reviewed local version before adopting the new analysis. Replayed imports do not duplicate the replacement. Native speaker-gate alerts remain once per run, with eligibility reset on a new remote run or gate exit, including automatic skip.

## Rollout and rollback

1. Keep all desktops in local mode. Qualify the image, bindings, TLS, model assets, retention and resource limits in an isolated nonproduction org/space.
2. Deploy behind a separate experimental route and run only synthetic content. Exercise API/worker restart, expired credentials, interrupted upload/download, cancellation and cleanup. Do not substitute local synthetic timing for foundation measurements.
3. Canary one explicitly consenting Mac and one non-sensitive recording only after the operator approves real-data testing. Confirm local original preservation, speaker gate, summary import, conflict handling and export-attempt semantics.
4. Expand only with measured alerts/runbooks. Existing runs pin endpoint, service/profile identity and limits; configuration changes do not move them.

To roll back, first switch every Mac default to **On this Mac**. Let accepted remote jobs finish or explicitly cancel them; do not silently redirect them. Stop new route traffic, then stop workers/API after leases and cleanup state are understood. Retain the database and bucket until the documented retention/backup policy is satisfied. Reverting the desktop is safe because migration 17 is additive and older code ignores the new tables; preserve the local original recordings. Roll back the image to a previously scanned digest only if its schema/profile contract remains compatible—do not reverse database migrations or delete objects as an emergency shortcut.

## Evidence, limitations and security ledger

Validated with synthetic content as of 2026-09-09:

- Service unit/integration coverage used real PostgreSQL and MinIO for owner auth, multipart reconciliation, leases/restarts, stale publication, cancellation, acknowledgement, cleanup and retention. The separate service production dependency audit reported zero findings.
- The real desktop coordinator/importer completed audio upload, SQLite reopen, speaker naming, a separate text job, summary/action import, acknowledgement and deletion against that service. Throwing local-inference spies were not called. Restart, offline/reconnect, lost responses, resumable download, fallback and late-edit/conflict fences have focused tests.
- The final Node 22 desktop run passed 116 test files with 2 opt-in performance files skipped: 949 tests passed and 5 were skipped. It included the real desktop coordinator/importer against the synthetic service and two-generation speaker identity, crash/review fencing, and per-run notification regressions. All 21 service tests passed with integration enabled. Main, preload and renderer TypeScript checks passed; the production renderer build completed 359 modules with the existing nonblocking 527.44 kB chunk advisory.
- The final Electron 30.5.1 fixture saved remote Settings, retried/reconnected, cancelled, rejected and confirmed local fallback, and exercised both keep-local and replace conflict decisions. Its navigation probe kept the privileged window on the app document and routed one synthetic HTTPS link through the injected external-browser handler. Four captures were visually reviewed. The isolated Vite document now supplies a restrictive fixture CSP and the final Electron run emitted no insecure-CSP warning. In this unsigned normal Electron process, run after `app.whenReady()` with a temporary profile and no `ELECTRON_RUN_AS_NODE`, `safeStorage.isEncryptionAvailable()` returned `false`; no credential write or plaintext fallback was attempted. A signed app in the intended logged-in macOS user session must still prove the Keychain round trip and permission behavior.
- The Electron native module was restored and positively loaded after Node tests: Electron 30.5.1, ABI 123, in-memory `SELECT 1` returned `{ok:1}`. The allowlisted Docker context was 181.26 kB; the full service image build could not begin because registry metadata for the pinned Node/ffmpeg bases timed out and neither base was cached.

Not validated: a selected TP foundation/org/space, CF bindings/TLS, a signed-user-session Keychain round trip/permission prompt, a user clicking a native notification (the fixture reported notification support only), sleep/wake, a live microphone/network-loss run, signed installer behavior, Linux/model packaging and licensing, real STT/diarization/LLM quality, multi-hour performance, production token rotation, backup deletion, external webhook exactly-once delivery, deployment or release. Automatic exports are at-most-one local delivery attempt; an ambiguous network outcome requires operator review and a manual retry can duplicate delivery.

Desktop dependency review on 2026-09-09 found 29 pre-existing full-tree advisories (3 critical, 19 high, 4 moderate, 3 low). A production-only `npm audit --omit=dev` reported zero, but it excludes packaged Electron and therefore is not a clean packaged-runtime result. Electron 30.5.1 and archive/build/runtime-adjacent packages remain in the ledger; suggested fixes require major Electron/Vite/Vitest/builder migration and separate compatibility review. The remote service audit is independently zero.

Focused reachable-path mitigation in this branch keeps the privileged renderer on its exact app document, denies popup windows, routes only credential-free HTTP(S) links to the system browser, gates IPC by the expected renderer webContents and document URL, and registers the recovery-audio protocol with CORS support. Remote control responses/artifacts remain bounded, authenticated and schema/hash checked. Fixture inputs are trusted synthetic data, Vite binds loopback, Vitest UI is off, and no installer/untrusted archive build occurs during validation. The renderer still has no production Content Security Policy; adding one requires moving the existing inline boot/preview scripts and qualifying development versus packaged resource loading. Remaining advisories are not dismissed as development-only; production qualification remains blocked on that browser-policy work, a reviewed runtime/toolchain migration, image scan and platform evidence.
