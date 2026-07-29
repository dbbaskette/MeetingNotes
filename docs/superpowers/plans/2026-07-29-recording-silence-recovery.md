# Recording Silence Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically finalize recordings after five continuous quiet minutes, rediscover M4As that become valid at finalization, and give Gemma 4 enough extraction tokens to answer.

**Architecture:** `RecordingManager` owns a per-session silence timer and routes expiry through its idempotent manual stop path. `LibraryWatcher` observes add and change events and exposes a failed-path release operation so finalization can trigger rediscovery. Action extraction keeps its existing retry policy but raises the per-attempt output allowance.

**Tech Stack:** Electron 30, TypeScript 5.4, Node.js timers and child processes, chokidar 3, Vitest 1.6.

## Global Constraints

- Silence means no peak strictly above `-50 dBFS` for `300000 ms`.
- Any audible peak resets the full five-minute window.
- Automatic stop must use the same finalize path as manual stop.
- Original recordings are never deleted or rewritten by this feature.
- Extraction retains two temperature-shifted reasoning re-samples.
- Follow the repository testing cadence: complete each coherent slice, run its targeted tests, then run the full suite once before completion.
- Strict red-green TDD is not required because the repository agreement says to use it only when explicitly requested.

---

### Task 1: Recorder-Owned Silence Watchdog

**Files:**
- Modify: `electron/main/recording/manager.ts`
- Modify: `electron/main/recording/manager.test.ts`
- Modify: `electron/main/index.ts`

**Interfaces:**
- Consumes: helper `{"event":"level","peak_db":number}` lines and the existing `stop(sessionId): Promise<void>` API.
- Produces: `SILENCE_TIMEOUT_MS`, `SILENCE_THRESHOLD_DB`, an idempotent stop promise per session, and `onAutoStop(sessionId, silenceMs)` dependency callback.

- [ ] **Step 1: Add per-session watchdog and idempotent-stop state**

Extend each `SessionEntry` with:

```ts
silenceTimer: ReturnType<typeof setTimeout> | null;
stopPromise: Promise<void> | null;
```

Add exported policy constants:

```ts
export const SILENCE_TIMEOUT_MS = 5 * 60_000;
export const SILENCE_THRESHOLD_DB = -50;
```

Add an optional constructor dependency:

```ts
onAutoStop?: (sessionId: string, silenceMs: number) => void;
```

- [ ] **Step 2: Arm, reset, and clear the timer at lifecycle boundaries**

After entering `recording`, call `armSilenceTimer(sessionId)`. Reset it only
when a parsed level peak is strictly above `SILENCE_THRESHOLD_DB`.

Implement the helpers with the production timers:

```ts
private clearSilenceTimer(entry: SessionEntry): void {
  if (entry.silenceTimer !== null) clearTimeout(entry.silenceTimer);
  entry.silenceTimer = null;
}

private armSilenceTimer(sessionId: string): void {
  const entry = this.sessions.get(sessionId);
  if (!entry || entry.state !== 'recording') return;
  this.clearSilenceTimer(entry);
  entry.silenceTimer = setTimeout(() => {
    const current = this.sessions.get(sessionId);
    if (!current || current.state !== 'recording') return;
    this.deps.onAutoStop?.(sessionId, SILENCE_TIMEOUT_MS);
    void this.stop(sessionId).catch(() => this.transition(sessionId, 'error'));
  }, SILENCE_TIMEOUT_MS);
}
```

Clear the timer before manual/automatic stop work and before helper self-exit
finalization.

- [ ] **Step 3: Make concurrent stops share one operation**

Keep the public method stable and move the existing stop sequence into a
private method:

```ts
async stop(sessionId: string): Promise<void> {
  const entry = this.sessions.get(sessionId);
  if (!entry) throw new Error(`no such session: ${sessionId}`);
  if (entry.stopPromise) return entry.stopPromise;
  entry.stopPromise = this.performStop(sessionId, entry);
  return entry.stopPromise;
}
```

`performStop` clears the silence timer, transitions once to `stopping`, signals
the helper, waits for exit or hard-kill timeout, finalizes once, and deletes the
session only if the map still contains that entry.

- [ ] **Step 4: Log automatic finalization in the main process**

Construct `RecordingManager` with:

```ts
onAutoStop: (sessionId, silenceMs) =>
  logger.info('recording:auto-stop-silence', { sessionId, silenceMs }),
```

- [ ] **Step 5: Add deterministic manager tests**

Use `vi.useFakeTimers()` and a reusable fake process that records signals and
emits `exit` after `SIGTERM`. Cover:

```ts
it('auto-stops after five minutes without any level events', async () => { /* advance 300000 ms */ });
it('resets the full timeout after an audible peak', async () => { /* emit -20 dBFS */ });
it('does not reset for a peak exactly at -50 dBFS', async () => { /* emit threshold */ });
it('manual stop clears the pending watchdog', async () => { /* stop, advance timers */ });
it('manual and automatic stop racing finalize once', async () => { /* invoke both at expiry */ });
it('helper self-exit clears the watchdog and finalizes once', async () => { /* emit exit */ });
```

Assert `SIGTERM` count, repository `finalize` count, manager state, and
`onAutoStop` arguments.

- [ ] **Step 6: Run the recording milestone tests**

Run:

```bash
npx vitest run electron/main/recording/manager.test.ts
```

Expected: all recording manager tests pass.

- [ ] **Step 7: Commit the watchdog slice**

```bash
git add electron/main/recording/manager.ts electron/main/recording/manager.test.ts electron/main/index.ts
git commit -m "fix(recording): auto-stop after five quiet minutes"
```

### Task 2: Retry Discovery After M4A Finalization

**Files:**
- Modify: `electron/main/library/watcher.ts`
- Modify: `electron/main/library/watcher.test.ts`
- Modify: `electron/main/index.ts`

**Interfaces:**
- Consumes: chokidar stable `add` and `change` events.
- Produces: `release(path: string): void`, which removes only that normalized path from watcher deduplication.

- [ ] **Step 1: Share path normalization across add and change**

Extract the current add callback into:

```ts
const handleAudioEvent = (p: string): void => {
  if (!SUPPORTED_EXT.test(p) || isStemArtifact(p)) return;
  let out = p;
  if (realWatchPath !== watchPath && p.startsWith(realWatchPath)) {
    out = path.join(watchPath, p.slice(realWatchPath.length));
  }
  this.emit(out);
};
watcher.on('add', handleAudioEvent);
watcher.on('change', handleAudioEvent);
```

- [ ] **Step 2: Add failed-path release**

Add:

```ts
release(p: string): void {
  this.emitted.delete(p);
}
```

Successful paths remain in the set and continue to deduplicate all later
events.

- [ ] **Step 3: Release discovery failures**

In the library discovery callback catch block, release before logging:

```ts
watcher.release(audioPath);
logger.error('library:discover-fail', { audioPath, err: String(e) });
```

The existing `meetings.findByAudioPath(audioPath)` check remains the database
deduplication guard.

- [ ] **Step 4: Make watcher tests event-driven and add regressions**

Replace fixed positive-event sleeps with:

```ts
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
```

Add tests proving:

```ts
it('emits a changed supported file after a failed path is released', async () => { /* release, append, wait */ });
it('does not emit a changed file again after successful delivery', async () => { /* append without release */ });
it('continues to ignore changed voice and system stems', async () => { /* append stems */ });
```

- [ ] **Step 5: Run the watcher milestone tests**

Run:

```bash
npx vitest run electron/main/library/watcher.test.ts
```

Expected: all watcher tests pass consistently, including the two baseline tests
that previously failed because of fixed 350–400 ms sleeps.

- [ ] **Step 6: Commit the rediscovery slice**

```bash
git add electron/main/library/watcher.ts electron/main/library/watcher.test.ts electron/main/index.ts
git commit -m "fix(library): retry recordings after finalization"
```

### Task 3: Increase Extraction Reasoning Room

**Files:**
- Modify: `electron/main/pipeline/extract-action-items.ts`
- Modify: `electron/main/pipeline/stages/extracting.test.ts`

**Interfaces:**
- Consumes: the existing `LMStudioClient.chat(ChatInput)` interface.
- Produces: `EXTRACT_MAX_TOKENS = 6000`; retry count remains `2`.

- [ ] **Step 1: Raise and document the extraction allowance**

Change:

```ts
export const EXTRACT_MAX_TOKENS = 6000;
```

Update the adjacent comment with the July 29 evidence: repeated 4,000-token
empty answers around 2,200 reasoning words and success after re-sampling.

- [ ] **Step 2: Update the extraction contract test**

Rename the test to mention 6,000 tokens and assert:

```ts
expect(arg.maxTokens).toBe(6000);
expect(arg.resampleRetries).toBe(2);
```

- [ ] **Step 3: Run the extraction milestone tests**

Run:

```bash
npx vitest run electron/main/pipeline/stages/extracting.test.ts electron/main/lm-studio/client.test.ts
```

Expected: extraction sends 6,000 tokens and the unchanged client retry behavior
passes.

- [ ] **Step 4: Commit the budget slice**

```bash
git add electron/main/pipeline/extract-action-items.ts electron/main/pipeline/stages/extracting.test.ts
git commit -m "fix(extract): increase reasoning output allowance"
```

### Task 4: Final Verification and Integration

**Files:**
- Verify all modified files and the approved design.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a buildable, tested feature branch ready for PR review.

- [ ] **Step 1: Review the complete diff against the design**

Run:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short
```

Confirm all design requirements map to code/tests and no user-owned files are
included.

- [ ] **Step 2: Run lint and build**

Run:

```bash
npm run lint
npm run build
```

Expected: both exit successfully.

- [ ] **Step 3: Run the full test suite once**

Run:

```bash
npm test
```

Expected: all test files and all tests pass with zero failures.

- [ ] **Step 4: Perform pre-merge code review**

Review `origin/main...HEAD` for race conditions, timer leaks, duplicate
finalization, watcher path normalization, and unintended retry-policy changes.
Resolve every critical or important finding before continuing.

- [ ] **Step 5: Push, open, and merge the PR**

Push `codex/recording-silence-recovery`, create a PR against `main` with the
verified test/build evidence, wait for required checks, and merge using the
repository's accepted merge method.

- [ ] **Step 6: Run the merged application**

Update the main checkout to the merged commit, rebuild the native audio helper
and Electron app as required by the repository scripts, replace or launch the
local MeetingNotes build without deleting the user's library, and verify the
window opens on the merged version.
