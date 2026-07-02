# Per-stage Progress with a Learned ETA — Design

**Date:** 2026-07-01
**Status:** Approved

## Problem

On a laptop-class local LLM, the **summarizing** and **extracting** stages each run
for minutes with no feedback, and the slow media stages (**transcribing**,
**diarizing**) are no better. The detail view's `StageTimeline` already shows the
current step spinning with an **elapsed** counter (`useElapsed(stageStartedAt, …)`),
but elapsed time alone can't distinguish "working" from "stuck": a stage sitting at
`4m 12s` looks identical whether it's halfway through a normal run or wedged against
the 10-minute request timeout. Users can't tell a genuine hang from a normal wait.

There is no *reference* to compare elapsed against — nothing that says "this usually
takes about 3 minutes on your machine." The app already records `stage_started_at`
per meeting (migration 2) and surfaces elapsed, but it throws the duration away the
moment the stage advances, so it can never learn.

## Decision

After each stage completes, record how long it took, keyed by **stage** and a coarse
**input-size bucket** (transcript character count). Compute a per-machine estimate as
the **median of the recent samples in the same (stage, bucket)** and show it next to
elapsed: *"summarize — 1m 40s · usually ~3m."* Estimates improve as more meetings are
processed. A genuine hang becomes obvious (elapsed far exceeds the estimate); a normal
wait becomes tolerable (elapsed tracking under a credible number).

The estimate math — bucketing + median + cold-start fallback — is a **pure function**
(`electron/main/lib/stage-eta.ts`) with no I/O, unit-tested in isolation. The timing
side-effects are a thin wrapper in the pipeline runner plus a small repo.

### Which stages get estimates

From `stage-machine.ts`, the ordered stages are `discovered → transcribing +
diarizing → merging → identifying → awaiting_speaker_id → summarizing → extracting →
done`. We record a duration for every stage the pipeline actually *invokes a handler*
for — the `WorkStage` set: `transcribing`, `diarizing`, `merging`, `identifying`,
`summarizing`, `extracting`. `awaiting_speaker_id` is a user-gate with no handler and
no duration; `discovered`/`done` are not work.

The renderer collapses these to five user steps (`transcribe`, `speaker ID`, `name
voices`, `summarize`, `extract` — see `pipeline-steps.ts`). The **transcribe** step
maps to two internal stages that run in parallel (`transcribing` + `diarizing`); its
displayed estimate is the **max** of the two stage estimates (they run concurrently,
so wall-clock is bounded by the slower one). All other user steps map 1:1.

### Considered alternatives

- **Rolling aggregate in settings (a per-(stage,bucket) running mean/count JSON blob):**
  no migration, cheap. Rejected — a running mean can't be made robust to outliers
  (one 10-minute timeout permanently skews it), a median needs the raw recent
  samples, and the settings DB is a separate database from the meetings DB (see
  Storage), so writing timing there splits pipeline state across two files.
- **Reuse `stage_started_at` deltas computed on read:** we already store the *start*;
  we could diff against `updated_at` at the next transition. Rejected — that only
  captures the *current* meeting's in-flight stage, is overwritten on every stage
  advance, and gives us no history to learn from.
- **Per-second progress percentage from the LLM/whisper:** the providers don't expose
  reliable token-rate progress across LM Studio / Ollama / whisper-server, and a fake
  percentage is worse than an honest ETA. Rejected.

## Storage

Two SQLite databases exist (`electron/main/index.ts`): the **library DB** (in
`libraryPath`, holds `meetings` + `action_items`) and a separate **settings DB**. The
meetings DB is where pipeline state lives, so stage timings belong there.

Add a new table `stage_durations` to the library DB via the existing numbered
migration pattern (`migrations.ts`, `MIGRATIONS` array, one transaction per version,
`schema_version` bookkeeping). New migration **version 12**:

```sql
CREATE TABLE IF NOT EXISTS stage_durations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage TEXT NOT NULL,          -- WorkStage: transcribing|diarizing|merging|identifying|summarizing|extracting
  size_bucket INTEGER NOT NULL, -- coarse transcript-size bucket index (see Bucketing)
  duration_ms INTEGER NOT NULL, -- wall-clock for this stage on this meeting
  recorded_at TEXT NOT NULL     -- ISO timestamp, used to keep only the most-recent N
);
CREATE INDEX IF NOT EXISTS idx_stage_durations_lookup
  ON stage_durations(stage, size_bucket, recorded_at);
```

A per-sample-row table (not a rolling aggregate) is required to compute a median over
*recent* samples and to trim outliers. Rows are cheap; a cap keeps the table bounded
(see Retention).

### `StageDurationsRepo` (`electron/main/storage/stage-durations-repo.ts`)

Matches the existing repo convention (constructor takes `Database.Database`,
snake_case columns mapped to a camelCase row type, prepared statements):

- `record(stage: string, sizeBucket: number, durationMs: number): void` — insert one
  sample. After insert, prune rows for that `(stage, size_bucket)` beyond the most
  recent `MAX_SAMPLES_PER_BUCKET` (keep the table bounded; old machines/models drift).
- `recentSamples(stage: string, sizeBucket: number, limit: number): number[]` — the
  most-recent `limit` `duration_ms` values for the exact `(stage, size_bucket)`,
  newest first. Pure read; the estimate math lives in `stage-eta.ts`.

## Bucketing and the estimate algorithm

All math is pure, in `electron/main/lib/stage-eta.ts`, and unit-tested.

### Size proxy

Transcript character count. `transcript.md` exists in the meeting folder by the time
any LLM stage runs; for the media stages (transcribing/diarizing) that run *before*
`transcript.md`, the bucket is derived from the same source once available and those
stages fall back to bucket 0 on the very first pass (see Recording timing). Character
count is a stable, dependency-free proxy — no tokenizer needed, and it correlates with
both transcript length and audio length closely enough for a coarse bucket.

### Buckets

Fixed, monotonic char-count thresholds → a small integer index:

```
bucketForChars(chars):
  < 5_000     -> 0   (short: < ~10 min meeting)
  < 20_000    -> 1   (medium)
  < 60_000    -> 2   (long)
  else        -> 3   (very long)
```

Four buckets keep samples-per-bucket high (so the median stabilizes fast) while still
separating a 5-minute standup from a 3-hour workshop, which have wildly different
stage times. Thresholds are constants, easy to retune.

### Estimate

```
estimateMs(samples): number | null
  - samples fewer than MIN_SAMPLES (3) -> null   (cold start: "estimating…")
  - otherwise -> median of the samples
```

Median (not mean) so a single runaway sample — e.g. a stage that limped to the
10-minute timeout — doesn't drag the estimate up. With an even sample count, average
the two middle values. No separate trimming step is needed: the median already
ignores tail outliers, and keeping the rule to "median of the recent N" is simpler and
robust. `recentSamples` bounds N to the last `MAX_SAMPLES_PER_BUCKET` so the estimate
tracks the user's *current* machine/model, not a year-old baseline.

### Cold-start fallback

- **Zero or few samples (< 3) in the exact bucket:** return `null`. The renderer shows
  no `~Xm` figure; instead the copy reads *"estimating…"* the first couple of times a
  bucket is seen. Honest — we don't fabricate a number we can't back.
- We deliberately do **not** fall back to a hardcoded "typical" duration: hardware and
  model choice vary so wildly (a 9B on an M3 Max vs. a 12B reasoning model on an
  8-core Intel) that a canned default would be misleading, which is the exact failure
  mode we're trying to fix. "Estimating…" for the first ~3 meetings of a given size is
  acceptable; after that the learned number is real.

### Public surface of `stage-eta.ts`

```
export const SIZE_BUCKETS = [5_000, 20_000, 60_000] as const;
export const MIN_SAMPLES = 3;
export const MAX_SAMPLES_PER_BUCKET = 20;
export function bucketForChars(chars: number): number;
export function estimateMs(samples: readonly number[]): number | null;
```

## How progress + elapsed + estimate reach the renderer

`stageStartedAt` and elapsed already flow through the `MeetingSummary` /
`MeetingDetail` IPC payloads and drive `StageTimeline`. The estimate rides the **same
payloads** — no new IPC channel, no new event:

- Add `stageEtaMs: number | null` to `MeetingSummarySchema` (inherited by
  `MeetingDetailSchema`) in `contracts.ts`.
- In the `meetings:list` and `meetings:get` handlers, compute the estimate for the
  meeting's **current** stage: read the transcript char count (or fall back to bucket
  0 pre-transcript), call `bucketForChars`, `stageDurations.recentSamples(...)`,
  `estimateMs(...)`. `null` when the stage has no work-handler (e.g. sitting in
  `awaiting_speaker_id`/`done`) or the bucket is cold.
- For the collapsed **transcribe** user step, the handler takes `max(estimate for
  transcribing, estimate for diarizing)` (either may be `null`; `max` ignores nulls,
  and if both are null the step is `null`).

The renderer already polls `meetings:list` every 3s and re-fetches `meetings:get`
while `status === 'processing'`, so the estimate refreshes without new plumbing. The
`pipeline:status` / `pipeline:status-change` channels stay about *queue* state only.

### Renderer display

`StageTimeline` (and the `LibraryRow` chip) render the estimate next to the existing
elapsed value on the current step:

- estimate present → `1m 40s · ~3m` (elapsed · estimate), using `fmtElapsed` for both.
- estimate `null` → `1m 40s · estimating…`.
- **Overrun cue:** when `elapsed > 1.5 × estimate`, the estimate text switches to a
  warning treatment (amber) reading `~3m · running long` so a genuine hang is visually
  obvious well before the 10-minute timeout fires. Threshold is a renderer constant.

## Recording timing

The single measurement point is `Pipeline.process()` in `pipeline.ts`, where stage
handlers are invoked:

- **Linear stages** (line ~214–215): wrap `await this.deps.stages[s](input, ctx)` —
  capture `performance.now()` before, compute `durationMs` after a successful return,
  and call `ctx.stageDurations.record(s, bucket, durationMs)`. On throw, record
  nothing (a failed/aborted stage isn't a representative sample).
- **Parallel block** (line ~182–185): time `transcribing` and `diarizing`
  individually by wrapping each handler inside the `Promise.all`, so each gets its own
  sample. (They overlap in wall-clock; the renderer recombines them with `max`.)
- **Bucket source:** read the meeting's `transcript.md` char count at record time via a
  small helper `transcriptChars(ctx.libraryRoot, meeting.slug)` (returns 0 if the file
  doesn't exist yet). For `transcribing`/`diarizing` on a first run the transcript may
  not exist when they *start*, but by the time they *finish* — which is when we record
  — merging hasn't run yet, so `transcript.md` is still absent and the bucket is 0.
  That's acceptable: media-stage estimates converge to bucket 0 on short libraries and
  are refined for larger meetings as `transcript.raw.json` size could later be used;
  keeping it to `transcript.md`/0 keeps the first cut simple. (Open decision below.)

`PipelineContext` gains `stageDurations: StageDurationsRepo`, wired in `index.ts`
alongside the other repos.

## What does not change

`useElapsed`/`fmtElapsed`, `stage_started_at` (migration 2) and its use, the queue
`pipeline:status` channel, the stage machine order, the `USER_STEPS` model, and every
existing stage handler's own logic. This feature is additive: one table, one repo, one
pure module, a context field, a timing wrapper, one schema field, and renderer copy.

## Error handling

- `stageDurations.record` is wrapped so a timing/DB error is logged and swallowed — a
  telemetry write must never fail a real pipeline run.
- A failed stage records no sample (see Recording timing).
- Estimate reads in the IPC handlers are best-effort: any error → `stageEtaMs: null`
  (renderer shows "estimating…"), never a broken meetings list.

## Testing strategy

- **`stage-eta.test.ts`** (pure, no native deps): `bucketForChars` boundary cases
  (0, 4_999/5_000, 19_999/20_000, 59_999/60_000, huge); `estimateMs` cold start
  (`[]`, `[1]`, `[1,2]` → null), odd/even medians, outlier robustness (`[100, 110,
  120, 600_000]` → ~115, not skewed).
- **`stage-durations-repo.test.ts`** (better-sqlite3 native bindings, mirrors
  `meetings-repo.test.ts` with an `openDb(tmp)` per test): `record` + `recentSamples`
  round-trip, keying by `(stage, size_bucket)`, newest-first ordering, `limit`
  honored, pruning past `MAX_SAMPLES_PER_BUCKET`.
- **`pipeline.test.ts`**: assert a successful stage calls `ctx.stageDurations.record`
  with the right stage/bucket and a positive duration; assert a throwing stage records
  nothing.
- Manual: process meetings of two different lengths; confirm the third meeting of a
  given size shows a `~Xm` estimate and the overrun cue appears when a stage is
  deliberately stalled.
