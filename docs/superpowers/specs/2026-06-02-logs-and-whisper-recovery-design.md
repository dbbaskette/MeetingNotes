# Logs & Whisper Readiness Recovery — Design

**Date:** 2026-06-02
**Status:** Approved (brainstormed)

## Problem

Meetings intermittently fail on the initial transcription run. Logs
(`~/Library/Logs/MeetingNotes/app.log`) show three identical failures:

```
pipeline:failure  err="whisper: not ready within 120000ms"
```

In each case whisper-server loaded the model in **~1 second**, yet the
`/health` readiness probe never returned `{"status":"ok"}` for the full
120 s, so the pipeline gave up. Two distinct root causes, confirmed by
reading `electron/main/lib/managed-service.ts`:

1. **Wedged cold start (failures #1, #2).** When `/health` never greens,
   the whisper process does **not** exit, so `scheduleRestart` (which only
   fires on `proc.on('exit')`) never runs. `startInternal`'s poll loop just
   throws after the timeout, leaving the wedged process alive. The next
   `ensureReady` finds `this.proc` set, skips the respawn (`if (!this.proc)`),
   and polls the *same* wedged process again — so it fails repeatedly until
   the idle timer eventually kills it.

2. **Idle-shutdown race (failure #3).** Failure #3 fired at the exact
   millisecond the 10-minute idle timer ran `stop()`. While `stop()` is
   mid-flight (SIGTERM sent, `proc` not yet null), a concurrent `ensureReady`
   resets `stopped=false`, probes the dying server, and because `this.proc`
   is still set, `startInternal` skips the respawn and polls a dead process
   for the full timeout.

Separately, the readiness probe swallows every error
(`catch { return {ok:false} }`) and logs nothing about *why* `/health`
isn't green, and a failed run stores only `status='failed'` + the last
stage — the actual error string reaches `app.log` but never the DB or UI.
So a failed meeting cannot explain itself, and there is no diagnostics
surface in the app.

## Goals

- **Stop the failures** by making `ManagedService` recover from both modes.
- **Explain failures** that still happen: store the error per meeting and
  show it, with a Retry affordance.
- **Surface logs in-app** via a Diagnostics view reading `app.log`.

Non-goals: live-tailing logs in real time (Phase 2 stretch at most),
rotating `app.log`, changing the transcription/diarization pipeline itself.

## Phasing

**Phase 1 — recovery + per-meeting failure reason (the pain fix).**
**Phase 2 — global log viewer (diagnostics surface).**

---

## Phase 1

### 1a. `ManagedService` auto-recovery (`electron/main/lib/managed-service.ts`)

**Kill-and-respawn between readiness attempts.** Replace the single
spawn-then-poll-once-to-timeout flow in `startInternal` with a bounded
attempt loop:

- New deps (with defaults preserving today's behavior for non-whisper
  services): `startupMaxAttempts` (default `1`), `startupAttemptTimeoutMs`
  (defaults to `startupTimeoutMs`).
- Each attempt: ensure a process exists (spawn if `!this.proc`), then poll
  `/health` for up to `startupAttemptTimeoutMs`. On green → return. On
  attempt timeout with the process still alive → **force-kill it, await
  exit, and loop to respawn**. After the last attempt → throw
  `"<name>: not ready within <total>ms after <n> attempt(s)"`.
- Whisper supervisor sets `startupMaxAttempts: 2`,
  `startupAttemptTimeoutMs: 60_000` (total still ~120 s, but a wedged
  process gets killed and replaced halfway instead of polled uselessly).
- Each attempt logs via `onLog` (so it lands in `app.log` and the Phase 2
  viewer): attempt number, outcome, and on kill `"…readiness timed out,
  killing wedged process and respawning (attempt k/n)"`.

**Close the idle-shutdown race.** Make `stop()` track an in-flight promise
and have `ensureReady` await it before deciding to (re)start:

- `stop()` becomes a thin wrapper that dedupes: `if (this.stopping) return
  this.stopping; this.stopping = this.doStop().finally(() => this.stopping
  = null)`. Existing body moves to `doStop()`.
- `ensureReady` first line: `if (this.stopping) await this.stopping;` —
  guarantees any teardown (incl. an idle shutdown that just fired)
  completes and `proc` is null before we evaluate whether to spawn.

**Probe instrumentation (minimal).** `defaultHealthProbe` stays boolean for
the hot loop, but the attempt-timeout log line includes the last probe's
failure category. (Lightweight: we already know "not green"; we add
whether the process was still alive at timeout, which distinguishes
"wedged" from "crashed".)

These changes are covered by unit tests against `ManagedService` with a
fake `spawn` and a scriptable probe (extend existing
`managed-service.test.ts`): wedged-process respawn, idle-race re-entry,
attempt budget exhaustion, and the happy path unchanged.

### 1b. Per-meeting failure reason

- **DB migration** (`electron/main/storage/migrations.ts`): add nullable
  `error_message TEXT` to `meetings`.
- **Repository** (`electron/main/storage/meetings.ts`): `updateStatus`
  clears `error_message` on non-failed transitions; add
  `recordFailure(id, message)` (sets `status='failed'`, stores message).
- **Pipeline** (`electron/main/pipeline/pipeline.ts` catch): call
  `recordFailure(id, String(e))` instead of bare `updateStatus(id,
  'failed')`. Keep the existing `logger.error('pipeline:failure', …)`.
- **IPC/contracts**: `meetings:get` (and the row used by `meetings:list`)
  include `errorMessage`. No new channel needed for display.
- **Retry**: add `pipeline:retry` channel → handler resets the meeting to
  `status='pending'`, clears `error_message`, and re-enqueues via the
  existing processing path (same one `LibraryView` bulk-process uses).
- **Renderer** (`MeetingDetailView.tsx`): when `status==='failed'`, render a
  failure banner showing `errorMessage` (monospace, scrollable) and a
  **Retry** button calling `api.pipeline.retry(id)`. A failed `LibraryRow`
  already shows a red bar; clicking through reveals the reason.

---

## Phase 2 — Global log viewer

- **Logger** (`electron/main/logging/logger.ts`): expose the log file path
  (`logger.filePath`) so main can hand it to IPC.
- **IPC**:
  - `logs:tail` → reads the last ~256 KB of `app.log`, splits into lines,
    JSON-parses each (tolerating non-JSON lines as `{level:'info', msg:line}`),
    returns the most recent N (e.g. 500) newest-last. Bounded read so a large
    log never blocks.
  - `logs:reveal` → `shell.showItemInFolder(logPath)`.
- **Renderer**: a **Diagnostics** section in `SettingsView.tsx`:
  - Level filter chips (all / warn+error / error).
  - Scrollable list, newest at bottom, each row `ts · level · msg` with
    structured data expandable.
  - "Refresh" and "Reveal log in Finder" buttons.
  - (Stretch, not required: live append via a push channel — deferred.)

---

## Testing

- **Phase 1a**: unit tests on `ManagedService` (fake spawn + scriptable
  probe) — the four scenarios above. This is the highest-risk change and
  gets the most coverage.
- **Phase 1b**: migration test (column exists, default null); repository
  test (`recordFailure` sets message, `updateStatus` clears it); a pipeline
  test asserting a thrown stage records the message.
- **Phase 2**: a `logs:tail` parser test (bounded read, mixed JSON/plain
  lines, ordering).

## Risks

- The attempt-loop refactor touches the shared lifecycle used by whisper,
  pyannote, and the LLM runtime. Defaults (`startupMaxAttempts: 1`) keep
  every non-whisper service behaving exactly as today; only whisper opts
  into multi-attempt. Existing tests must stay green.
- Force-killing between attempts must await the real exit before respawn to
  avoid two processes briefly contending for the port.
