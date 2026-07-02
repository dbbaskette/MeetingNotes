# App-wide Pipeline Status Bar + Rough Early Estimates — Design

**Date:** 2026-07-01
**Status:** Approved

## Problem

Pipeline progress is only visible from two places: the Library (the `QueueBanner`
and per-row chips) and the meeting detail view (the `StageTimeline`). The moment a
user wanders into Settings or Weekly — or drills into a *different* meeting — the
app goes silent about the run in flight. There is no app-wide surface that says
"something is processing, here's where it is, click to see it."

Separately, the learned per-stage ETA (per-stage-progress-eta) is honest to a
fault: with `MIN_SAMPLES = 3`, a (stage, size-bucket) shows *"estimating…"* for the
first **three** meetings of a given size. One real sample is already far more
informative than nothing — a user who just watched summarize take 3 minutes should
see *~3m* on the next run, hedged, not a shrug.

## Decision

Two additive changes:

**A — a slim persistent status bar** at the bottom of the app shell, visible from
every view (Library, Weekly, Settings, detail). While a meeting is processing it
reads:

```
Summarizing "Q3 sync" — 17s · ~3m · 2 queued
```

Clicking it navigates to that meeting's detail view. If the queue is paused it says
so (`Paused — finishing "Q3 sync" · 2 queued`). When nothing is processing and the
queue is empty, the bar renders nothing at all — no permanent chrome, same rule the
`QueueBanner` follows. The existing per-stage section in the detail view
(`StageTimeline`) stays exactly as it is; the bar is the *app-wide* surface.

**B — rough estimates after one run.** `estimateMs` currently returns `null` below
`MIN_SAMPLES` (3). Change the estimate to three grades:

- **0 samples** → `null` — still *"estimating…"*. We never invent a number.
- **1–2 samples** → median of what exists, flagged **rough**. The UI hedges it:
  `~3m (rough)`.
- **3+ samples** → median, firm — today's behavior, rendered `~3m` as before.

The roughness flag propagates end-to-end: through the parallel
transcribing+diarizing max-combination in `stageEtaForMeeting` (if either
contributing branch is rough, the combined estimate is rough), through the IPC
payload, and into both renderers of the estimate (detail-view `StageTimeline` and
the new status bar).

## Changes

### Estimate math (`electron/main/lib/stage-eta.ts`)

Replace the `number | null` return with a small struct — the flag has to travel
*with* the number or every caller re-derives it from sample counts it no longer has:

```ts
export interface StageEstimate { etaMs: number; rough: boolean }
export function estimateStage(samples: readonly number[]): StageEstimate | null
//  []            -> null
//  1–2 samples   -> { etaMs: median, rough: true }
//  >= MIN_SAMPLES -> { etaMs: median, rough: false }
```

`estimateMs` has exactly one caller (`stage-eta-for-meeting.ts`), so it is replaced
by `estimateStage` rather than kept as a divergent twin. `MIN_SAMPLES` keeps its
value (3) and its meaning flips from "minimum to show anything" to "minimum for a
*firm* estimate". Median stays median — with 1–2 samples it degrades naturally to
the single value / the two-value average.

### Composer (`electron/main/ipc/stage-eta-for-meeting.ts`)

`stageEtaForMeeting` returns `StageEstimate | null`. The parallel
transcribing+diarizing combination keeps its shape — wall-clock is bounded by the
slower branch, so `etaMs` is the max of the non-null branches — and gains the
roughness rule: **rough if any contributing (non-null) branch is rough**. A null
sibling is ignored entirely, as today: a lone firm branch still yields a firm
number.

### IPC payload (`contracts.ts`, `handlers.ts`)

Additive only — `stageEtaMs: number | null` keeps its exact shape so nothing
downstream reshapes:

```ts
stageEtaMs: z.number().nullable(),   // unchanged
stageEtaRough: z.boolean(),          // NEW: hedge the figure when true
```

`meetings:list` and `meetings:get` populate both from the composer's return:
`stageEtaMs: eta?.etaMs ?? null`, `stageEtaRough: eta?.rough ?? false`. A `null`
estimate is never rough.

### Renderer formatting (`electron/renderer/src/lib/fmtEta.ts`)

`fmtEta` gains an optional second parameter — additive, existing call sites
unchanged in meaning:

```ts
fmtEta(etaMs, rough)  // ~3m (rough)  when rough; ~3m / ~45s / estimating… as today
```

`isRunningLong` is untouched: a rough estimate still powers the overrun cue (a
hedge on precision, not on existence).

### Status-bar derivation (`electron/renderer/src/lib/status-bar.ts`, NEW)

The repo has no component-render harness (node test env, no jsdom), so everything
decidable lives in a pure module and the React component is a dumb shell. Two pure
functions:

```ts
deriveStatusBar(meetings, pipelineStatus): StatusBarModel | null
statusBarText(model, elapsedSeconds): string
```

- `null` ⇔ the bar is hidden: no `currentId` **and** an empty queue (paused or
  not — a paused empty queue is a no-op, not news).
- `StatusBarModel` carries: `kind: 'processing' | 'paused'`, `meetingId` (click
  target, the pipeline's `currentId`), `title` (from the meeting summaries; `"…"`
  when the row hasn't landed yet — same fallback `QueueBanner` uses), `stageLabel`,
  `stageStartedAt` (the component feeds it to `useElapsed`), `etaMs`, `etaRough`,
  and `queued`.
- Stage labels reuse the `pipeline-steps.ts` collapse (`stepIndexFor`) so the bar
  agrees with the timeline about what phase the run is in, worded as bar-friendly
  gerunds per user step: transcribe → **Transcribing**, speaker ID →
  **Identifying speakers**, summarize → **Summarizing**, extract →
  **Extracting**. A stage outside the map (races around stage transitions) falls
  back to **Processing**.
- `statusBarText` composes the final string so it's testable to the character:
  - processing: `Summarizing "Q3 sync" — 17s · ~3m · 2 queued` (elapsed segment
    dropped when `stageStartedAt` is null; ETA segment uses `fmtEta` incl. the
    `(rough)` hedge and the `estimating…` fallback; queue suffix only when > 0)
  - paused, current still finishing: `Paused — finishing "Q3 sync" · 2 queued`
  - paused, nothing in flight: `Paused — 2 queued`
  - not paused, queue holding without a current: `2 queued`

### Status-bar component (`electron/renderer/src/components/PipelineStatusBar.tsx`, NEW) + App shell

Thin shell over the pure module:

- **Data:** meeting summaries come from the existing shared zustand store
  (`useMeetingsStore`); pipeline status comes from the existing
  `pipeline:status` pull + `pipeline.onStatusChange` push — the identical pattern
  `LibraryView` already uses. No new IPC channel. Because `LibraryView`'s 3s poll
  only runs while that view is mounted, the bar runs its own 3s
  `refresh()` interval **only while `currentId` is set** — from Settings/Weekly/
  detail this is what keeps title/stage/ETA fresh; on the Library it's a cheap
  duplicate guarded by the store's `shallowEqual`.
- **Elapsed:** `useElapsed(model.stageStartedAt, model.kind === 'processing')` —
  the same hook the timeline uses; the bar re-renders once a second only while
  something runs.
- **Click:** App.tsx owns view routing; the bar receives an `onOpenMeeting(id)`
  prop and App maps it to `setView({ kind: 'detail', id })`.
- **Placement:** in App.tsx's shell flex column, a `shrink-0` strip after the
  `flex-1` body slot, so it sits at the window bottom under every view. Rendered
  only once onboarding is done (the wizard owns the whole window). Renders `null`
  when the model is `null`.

The store's `MeetingSummary` interface gains `stageEtaMs` / `stageEtaRough` (the
handler already ships them on the wire) and `shallowEqual` compares `stageEtaMs` so
an estimate arriving mid-poll isn't swallowed.

## What does not change

`stage-eta`'s bucketing, `MAX_SAMPLES_PER_BUCKET`, the median, the
`stage_durations` table and repo, the recording side in the pipeline runner, the
`pipeline:status` payload (`{paused, currentId, queueLength, queueIds}`), the
`QueueBanner`, `LibraryRow`, the detail view's `StageTimeline` layout (it only
passes the new flag to `fmtEta`), `useElapsed`/`fmtElapsed`, `isRunningLong`, and
`stageEtaMs`'s type on the wire.

## Error handling

Unchanged in kind: estimate reads stay best-effort in the handlers (`null` on any
failure, never a broken meetings list), and a `null` estimate is always
`stageEtaRough: false`. The bar derives from data that already exists; if the
current meeting's summary hasn't arrived it degrades to a `"…"` title rather than
hiding or throwing.

## Testing strategy

- **`stage-eta.test.ts`** — `estimateStage`: `[]` → null; one sample → that value,
  rough; two samples → their average, rough; three+ → median, firm; outlier
  robustness and non-mutation carried over from `estimateMs`.
- **`stage-eta-for-meeting.test.ts`** — reshaped returns; rough propagation
  through the parallel max (firm+firm→firm, rough branch wins the max→rough,
  *slower branch firm but faster branch rough → still rough*, null sibling
  ignored → lone branch's flag).
- **`fmtEta.test.ts`** — `(rough)` suffix on seconds and minutes; `rough` ignored
  when `etaMs` is null; existing cases untouched.
- **`status-bar.test.ts`** — hidden states; label mapping per stage incl. the
  fallback; title fallback `"…"`; queue counts; paused variants; `statusBarText`
  exact strings for every branch (with/without elapsed, rough, estimating…,
  queue suffix).
- **Component/App wiring** — type-checked (`tsconfig.json` renderer config), plus a
  manual verification pass; the repo has no DOM test harness by policy.
