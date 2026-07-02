# Re-extract Action Items from the Edited Summary — Design

**Date:** 2026-07-01
**Status:** Approved

## Problem

Action-item extraction now runs the LLM over `summary.md` (~1–3k tokens in, ≤2000
tokens out — see the 2026-07-01-extract-from-summary spec). It's fast and cheap:
seconds, not minutes. The summary is already user-editable in the meeting detail view
(the Summary panel writes `summary.md` via `meetings:save-summary`).

That combination exposes a quick fix loop we don't yet offer. The accepted trade-off
of summary-bounded extraction is: "if the summary drops a commitment, extract cannot
recover it." Today the only remedy is re-running the whole pipeline, or hand-adding
the item via the "+ Add item" button. But the user can already *fix the summary* —
add the missed commitment to its `## Action Items` section and save. What's missing is
a one-click "re-extract" that regenerates the action items from the current on-disk
`summary.md` **without** re-running transcribe / diarize / merge / identify / summarize.

## Decision

Add a dedicated, stateless re-extract action that re-runs **only the extract step**
against the current `summary.md` and replaces the meeting's action items — leaving the
meeting's pipeline state (`pipelineStage`, `status`) untouched.

- **New IPC endpoint `actionItems:reextract`** (channel string `action-items:reextract`),
  a handler that inlines the same extract logic the stage runs — read `summary.md`,
  `ensureLLMReady()`, one `lmStudio.chat()` call with `ACTION_ITEM_SYSTEM_PROMPT` +
  `maxTokens: 2000`, `parseActionItemsLoose`, then `actionItems.replaceForMeeting` and
  rewrite `action-items.json`. It returns the new item count.
- **Button lives in the Action Items panel** (`ActionItemsPanel` in
  `MeetingDetailView.tsx`), next to "+ Add item". It has three visible states —
  idle, in-progress ("Re-extracting…"), and error — and calls `onReload()` on success
  so the regenerated items render.

### Why not reuse `runExtracting` via the pipeline?

`runExtracting` is a `StageHandler` that needs a full `PipelineContext` — including
`llmSupervisor`, `stt`, `diarization`, `diarSupervisor`, `whisperSupervisor`, `roster`
— none of which `IpcServices` carries except by addition. More importantly, invoking
it means going through the `Pipeline` (`enqueue` → `process`), which walks the stage
machine and mutates `pipelineStage`/`status`. A `done` meeting would get pulled back
into the queue and flipped to `processing`; on the tiniest hiccup the failure path in
`Pipeline.tick()` would roll its stage back and mark it `failed`. That corrupts the
state of an already-finished meeting for what is really a content edit. So we do
**not** route re-extract through the pipeline.

### Why not reuse `meetings:rerun`?

`meetings:rerun(id, fromStage)` re-enqueues through the stage machine from `fromStage`.
It can't target "just extract" without also re-running everything after the rerun
point — and `extracting` is the last work stage, but rerunning from `summarizing`
would re-run summarize (the expensive path we're specifically avoiding) and rerunning
from `extracting`… doesn't exist as a rail button and would still go through the queue
and flip `status`. `meetings:rerun` also clears artifacts and mutates pipeline state.
Re-extract must be surgical: touch only the action items, never the meeting's state.
Rejected.

### Considered alternatives

- **Add `llmSupervisor` to `IpcServices` and call `runExtracting` directly (not via
  the Pipeline):** avoids the queue/state issues, and reuses the stage body verbatim.
  But it still needs a full `PipelineContext`-shaped object assembled in the handler,
  and `runExtracting` writes `action-items.json` + calls `replaceForMeeting` + logs —
  all of which the inline handler does anyway. The extract body is ~10 lines; inlining
  it (as `llm:health-check-model` already inlines a `chat` call) is clearer than
  building a fake context. Rejected in favor of the inline handler, but see "Shared
  helper" below — the shared constants keep the two paths from drifting.
- **Auto re-extract on every summary save:** silent, surprising, and burns an LLM call
  on every keystroke-batch save even when the user only fixed a typo in the Overview.
  Re-extract must be explicit. Rejected.

### Shared helper (avoid drift)

To keep the new handler and the stage in lockstep, both read the same summary file and
use the same prompt/token budget. The extract stage
(`electron/main/pipeline/stages/extracting.ts`) already owns:
`summary.md` path, the missing/empty-summary error string, `ACTION_ITEM_SYSTEM_PROMPT`,
`maxTokens: 2000`, `temperature: 0`, `disableThinking`, `parseActionItemsLoose`, and
the `action-items.json` write. The handler reproduces exactly these — same file, same
prompt, same cap — so a future change to the extract contract must touch both. This is
called out explicitly in the plan's Self-Review as the one drift risk.

## Changes

### 1. `electron/main/ipc/contracts.ts` — new channel

Add `actionItemsReextract: 'action-items:reextract'` to the `IPC_CHANNELS` map (with a
doc comment: re-run only the extract step against the current on-disk `summary.md`;
replaces the meeting's action items; does not touch pipeline state).

### 2. `electron/preload/index.ts` — mirror the channel + expose `api.actionItems.reextract`

The preload has its **own** `IPC_CHANNELS` literal (a hand-maintained copy) and its own
`api` object. Add the same `actionItemsReextract` key to that literal, and add
`reextract: (meetingId) => ipcRenderer.invoke(...)` returning `Promise<{ count: number }>`
under `api.actionItems`.

### 3. `electron/main/ipc/handlers.ts` — the handler + `llmSupervisor` in `IpcServices`

- Add `llmSupervisor: { ensureReady: () => Promise<void> }` to the `IpcServices`
  interface (index.ts already constructs `llmSupervisor` and can pass it — it's the
  same object the pipeline `ctx` uses). This is the only new service dependency.
- Register `actionItems:reextract`: validate `meetingId`, look up the meeting, read and
  trim `summary.md`, throw the same missing/empty error as the stage if blank,
  `await s.llmSupervisor.ensureReady()`, call `s.lmStudio.chat({ model:
  s.settings.get('llmModel'), temperature: 0, disableThinking:
  s.settings.get('disableThinking'), maxTokens: 2000, messages: [system:
  ACTION_ITEM_SYSTEM_PROMPT, user: summary] })`, `parseActionItemsLoose`, write
  `action-items.json`, `s.actionItems.replaceForMeeting(meetingId, items)`, log, and
  return `{ count: items.length }`.
- `ACTION_ITEM_SYSTEM_PROMPT` is already imported at the top of handlers.ts (the
  health-check handler uses it); `parseActionItemsLoose` needs a new import from
  `../lib/action-item-schema.js`.

### 4. `electron/main/index.ts` — pass `llmSupervisor` into `registerIpcHandlers`

Add `llmSupervisor,` to the services object passed to `registerIpcHandlers` (the local
`llmSupervisor` const already exists — it's in the pipeline `ctx`).

### 5. `electron/renderer/src/views/MeetingDetailView.tsx` — the button + states

In `ActionItemsPanel`, add a "Re-extract" button beside "+ Add item". It:

- Is disabled and shows "Re-extracting…" while the call is in flight.
- On success, calls `await onReload()` so the regenerated items render.
- On error, shows an inline error message (the reasoning-loop failure the extract path
  can throw surfaces here as `LMStudioError`'s message — "…spent its entire token
  budget…"; we display the raw message rather than a bespoke recovery UI, matching how
  the "+ Add item" editor surfaces save errors as text).
- Sits under a short helper line clarifying it reads the **current summary** (so a user
  who hasn't saved their edit understands why a just-typed item wasn't picked up).

### 6. Tests

- `handlers.test.ts`: add `action-items:reextract` to the "registers all known
  channels" assertion; add a test that the handler reads `summary.md`, calls `chat`
  with `maxTokens: 2000` and the system prompt, calls `replaceForMeeting` with the
  parsed items, and returns `{ count }`; add a test that a missing/empty `summary.md`
  throws the actionable error **without** calling `chat`. Extend `baseServices()` with
  an `llmSupervisor: { ensureReady: async () => {} }` stub.

## What does not change

The extract stage (`extracting.ts`) and its behavior, the pipeline, the stage machine,
`meetings:rerun` / `meetings:save-summary`, `parseActionItemsLoose`, the action-item
schema, the FailureBanner and its reasoning-recovery controls, and the meeting's
pipeline state on re-extract. Re-extract is state-neutral: a `done` meeting stays
`done`.

## Summary-persistence note

Re-extract reads `summary.md` from disk, so it only sees **saved** edits. The Summary
panel's `save()` writes `summary.md` via `api.meetings.saveSummary` before dropping
back to view mode; edits held only in the editor `draft` are not on disk. The helper
line under the button states this ("reads the saved summary"), and re-extract does not
attempt to read renderer state — it deliberately uses the same on-disk file the stage
uses, so what you re-extract is exactly what you saved.

## Error handling

- Missing/empty `summary.md` → handler throws the same actionable message the stage
  throws ("summary.md is missing or empty…"); the button surfaces it inline. (In
  practice a `done` meeting always has a summary; this guards a corrupted library.)
- Model loops anyway → same `LMStudioError` path as the stage, bounded at 2000 tokens,
  surfaced fast; its message renders in the button's inline error.
- The handler never mutates pipeline state, so no failure here can leave the meeting in
  a bad `status` — the worst case is "action items unchanged, error shown."

## Testing strategy

Unit tests as in §6 (vitest, mocked `lmStudio.chat` + `llmSupervisor`, tmp-dir
`summary.md` — same patterns `extracting.test.ts` and `handlers.test.ts` already use).
Manual verification: open a `done` meeting, edit the summary's Action Items section
(add a bullet), Save, click Re-extract, and confirm the new item appears and the
meeting stays `done`.
