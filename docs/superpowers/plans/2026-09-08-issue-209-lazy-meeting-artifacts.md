# Issue 209 Lazy Meeting Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open meeting summaries without eagerly reading or parsing transcript and diarization artifacts on Electron's main thread.

**Architecture:** Split the existing detail payload into an asynchronously loaded shell, transcript artifact, and speaker-review artifact. A fingerprinted 64 MiB LRU cache deduplicates reads and invalidates on disk changes; the renderer loads optional artifacts independently and rejects stale responses.

**Tech Stack:** Electron 30 IPC, TypeScript, React 18, Node filesystem APIs, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-meeting-loading-and-library-scaling-design.md`

## Global Constraints

- No new runtime dependency.
- Preserve early raw-transcript preview, processing polling, editing, speaker naming, and error/retry behavior.
- Do not retain an optimization unless repeated measurements beat run-to-run variation.
- Do not touch unrelated untracked workspace files.

---

### Task 1: Fingerprinted artifact cache

**Files:**
- Create: `electron/main/library/artifact-cache.ts`
- Test: `electron/main/library/artifact-cache.test.ts`

**Interfaces:**
- Produces: `ArtifactCache.readText(path): Promise<string | null>`, `readJson<T>(path): Promise<T | null>`, `invalidate(path): void`, `invalidateFolder(folder): void`, and `stats()`.
- Cache key: absolute path; fingerprint: `${size}:${mtimeMs}:${ctimeMs}`; maximum retained text/JSON source bytes: 64 MiB.

- [ ] **Step 1: Write failing cache tests**

Test concurrent reads share one injected read operation, unchanged reads hit cache, size/mtime changes reload, missing-to-created and created-to-missing transitions invalidate, explicit invalidation reloads, and least-recently-used entries are evicted when an injected small byte budget is exceeded.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run electron/main/library/artifact-cache.test.ts`

Expected: failure because `ArtifactCache` does not exist.

- [ ] **Step 3: Implement the minimal cache**

Use asynchronous `fs.promises.stat/readFile`; retain in-flight promises; compute byte cost with `Buffer.byteLength`; perform JSON parsing only in `readJson`; make errors/missing files return null; and evict settled least-recently-used entries until retained bytes are within budget.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run electron/main/library/artifact-cache.test.ts`

Expected: all cache tests pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/library/artifact-cache.ts electron/main/library/artifact-cache.test.ts
git commit -m "perf: add fingerprinted artifact cache (#209)"
```

### Task 2: Additive detail-artifact contracts

**Files:**
- Modify: `electron/main/ipc/contracts.ts`
- Modify: `electron/preload/index.ts`
- Modify: `electron/main/ipc/handlers.ts`
- Modify: `electron/main/index.ts`
- Test: `electron/main/ipc/handlers.test.ts`
- Test: `electron/preload/contracts-parity.test.ts`

**Interfaces:**
- Produces: `api.meetings.getTranscript(id): Promise<{transcriptMd:string|null;rawTranscriptText:string|null}>`.
- Produces: `api.meetings.getSpeakerReview(id): Promise<{speakers:ReviewedSpeaker[]}>`.
- Changes `api.meetings.get(id)` to an async shell whose `transcriptMd` and `rawTranscriptText` fields are absent and whose speakers contain basic link fields only.

- [ ] **Step 1: Write failing handler tests**

Create fixture artifacts with a multi-megabyte transcript, raw JSON, summary, and diarization file. Assert `meetings:get` reads the summary but does not call cache reads for transcript/raw/diarization; `getTranscript` returns transcript plus raw text; `getSpeakerReview` returns review metadata; unknown IDs return null consistently.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run electron/main/ipc/handlers.test.ts electron/preload/contracts-parity.test.ts`

Expected: missing channels/methods and eager-read assertions fail.

- [ ] **Step 3: Implement contracts and handlers**

Add `meetingsGetTranscript` and `meetingsGetSpeakerReview` channels to main and preload. Add `artifactCache: ArtifactCache` to `IpcServices` and instantiate it in `electron/main/index.ts`. Replace synchronous shell artifact reads with `await artifactCache.readText(summaryPath)`. Use `readJson` inside the two optional handlers. Validate meeting IDs as non-empty strings at IPC boundaries.

- [ ] **Step 4: Verify GREEN and type parity**

Run: `npx vitest run electron/main/ipc/handlers.test.ts electron/preload/contracts-parity.test.ts && npx tsc --noEmit -p tsconfig.json`

Expected: handlers, channel parity, and renderer contract types pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/contracts.ts electron/preload/index.ts electron/main/ipc/handlers.ts electron/main/index.ts electron/main/ipc/handlers.test.ts
git commit -m "perf: split meeting detail artifact loading (#209)"
```

### Task 3: Load optional artifacts without stale updates

**Files:**
- Modify: `electron/renderer/src/views/MeetingDetailView.tsx`
- Create: `electron/renderer/src/lib/detail-artifacts.ts`
- Test: `electron/renderer/src/lib/detail-artifacts.test.ts`

**Interfaces:**
- Produces: generation helper that accepts meeting ID + artifact kind and rejects obsolete completions.
- Consumes: `getTranscript` and `getSpeakerReview` from Task 2.

- [ ] **Step 1: Write failing request-generation tests**

Assert a completion for meeting A cannot update meeting B, duplicate current requests share one promise, retry after failure is allowed, and stage refresh reloads only artifacts previously requested.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run electron/renderer/src/lib/detail-artifacts.test.ts`

Expected: helper module missing.

- [ ] **Step 3: Implement helper and renderer integration**

Load the shell first. Request transcript when the Transcript tab is active or a transcript seek opens the detail route. Request speaker review after the first shell paint. Show existing raw-preview copy when raw text arrives; show compact retryable errors inside the affected transcript/speaker regions. Preserve already loaded content during retries and processing polls.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run electron/renderer/src/lib/detail-artifacts.test.ts electron/renderer/src/lib/transcript-lines.test.ts && npx tsc --noEmit -p tsconfig.json`

Expected: generation behavior and renderer typing pass.

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/src/views/MeetingDetailView.tsx electron/renderer/src/lib/detail-artifacts.ts electron/renderer/src/lib/detail-artifacts.test.ts
git commit -m "perf: load transcript and speaker review on demand (#209)"
```

### Task 4: Explicit invalidation at artifact writers

**Files:**
- Modify: `electron/main/ipc/handlers.ts`
- Modify: `electron/main/pipeline/stages/merging.ts`
- Modify: `electron/main/pipeline/clear-artifacts.ts`
- Modify the construction/wiring files required to pass `ArtifactCache` to those writers.
- Test: affected handler, merging, and clear-artifact tests.

**Interfaces:**
- Consumes: `invalidate(path)` / `invalidateFolder(folder)` from Task 1.

- [ ] **Step 1: Add failing invalidation tests**

Assert summary save invalidates `summary.md`; merge/speaker remerge invalidates transcript and speaker-review source artifacts; artifact clearing invalidates its folder; a read immediately after each mutation returns new bytes even if a coarse filesystem timestamp is unchanged.

- [ ] **Step 2: Verify RED**

Run the specific handler, merging, and clear-artifact test files and confirm stale content is observed.

- [ ] **Step 3: Wire explicit invalidation**

Invalidate before writes/removals so an overlapping read cannot repopulate stale content after mutation. Preserve stat-fingerprint validation as the second correctness layer.

- [ ] **Step 4: Verify GREEN**

Re-run the targeted tests and confirm fresh content.

- [ ] **Step 5: Commit**

Commit only the cache wiring and affected tests with `perf: invalidate cached meeting artifacts (#209)`.

### Task 5: Benchmark, document, review, and merge #209

**Files:**
- Create: `electron/main/library/artifact-loading-performance.test.ts`
- Create: `docs/performance/meeting-artifacts-209.md`

- [ ] **Step 1: Add an opt-in benchmark**

Generate a temporary multi-hour-shaped fixture: at least 250,000 transcript lines, raw segment JSON, diarization JSON, and summary. Compare the old synchronous all-artifact path against shell-only cold/warm loads for three runs. Record wall time, event-loop delay, bytes read, JSON parse duration, and serialized payload bytes.

- [ ] **Step 2: Run benchmark and decide on worker parsing**

Run: `MN_ARTIFACT_BENCH=1 npx vitest run electron/main/library/artifact-loading-performance.test.ts`

If repeated JSON parse tasks exceed 50 ms, add a worker-backed JSON parser with failure/termination tests; otherwise record that worker complexity was evaluated and not retained.

- [ ] **Step 3: Full verification**

Run renderer type checking, `npm run build`, `git diff --check`, and the complete isolated-worker Vitest suite. Restore the Electron-compatible `better-sqlite3` binary afterward.

- [ ] **Step 4: Independent review and fixes**

Review the full diff against this plan. Fix every critical/important finding and rerun affected verification.

- [ ] **Step 5: Push PR and merge**

Push a `codex/209-lazy-meeting-artifacts` branch, create a PR closing #209 with measured results and limitations, wait for checks, squash-merge, verify #209 closed, and fast-forward local `main`.
