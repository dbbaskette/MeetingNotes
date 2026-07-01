# Per-stage Progress with a Learned ETA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record how long each pipeline stage takes, bucketed by transcript size, and show a learned per-machine estimate ("summarize — 1m 40s · ~3m") next to the elapsed counter that already exists, so genuine hangs become obvious and normal waits tolerable.

**Architecture:** Six small, ordered changes per the approved spec (`docs/superpowers/specs/2026-07-01-per-stage-progress-eta-design.md`): (1) a PURE estimate module (`stage-eta.ts`) with bucketing + median + cold-start fallback, (2) a `stage_durations` table via a new migration, (3) a `StageDurationsRepo` matching the repo convention, (4) wire the repo into `PipelineContext` + `index.ts` and time each stage in the runner, (5) surface `stageEtaMs` through the `meetings:list`/`meetings:get` IPC payloads, (6) render `elapsed · ~estimate` with an overrun cue. Estimate math is isolated and unit-tested; timing side-effects are thin and swallow errors.

**Tech Stack:** TypeScript (Electron main + React renderer), better-sqlite3, vitest.

---

### Task 1: Pure estimate module (bucketing + median + cold-start)

**Files:**
- Create: `electron/main/lib/stage-eta.ts`
- Test: `electron/main/lib/stage-eta.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `electron/main/lib/stage-eta.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { bucketForChars, estimateMs, MIN_SAMPLES } from './stage-eta.js';

describe('bucketForChars', () => {
  it('maps char counts to monotonic bucket indices', () => {
    expect(bucketForChars(0)).toBe(0);
    expect(bucketForChars(4_999)).toBe(0);
    expect(bucketForChars(5_000)).toBe(1);
    expect(bucketForChars(19_999)).toBe(1);
    expect(bucketForChars(20_000)).toBe(2);
    expect(bucketForChars(59_999)).toBe(2);
    expect(bucketForChars(60_000)).toBe(3);
    expect(bucketForChars(5_000_000)).toBe(3);
  });

  it('treats negative/NaN input as the smallest bucket', () => {
    expect(bucketForChars(-1)).toBe(0);
    expect(bucketForChars(Number.NaN)).toBe(0);
  });
});

describe('estimateMs', () => {
  it('returns null on a cold start (fewer than MIN_SAMPLES)', () => {
    expect(MIN_SAMPLES).toBe(3);
    expect(estimateMs([])).toBeNull();
    expect(estimateMs([100])).toBeNull();
    expect(estimateMs([100, 200])).toBeNull();
  });

  it('returns the median for an odd sample count', () => {
    expect(estimateMs([300, 100, 200])).toBe(200);
  });

  it('averages the two middle values for an even sample count', () => {
    expect(estimateMs([100, 200, 300, 400])).toBe(250);
  });

  it('is robust to a single runaway outlier (median, not mean)', () => {
    // A stage that limped to the 10-minute timeout must not skew the estimate.
    expect(estimateMs([100, 110, 120, 130, 600_000])).toBe(120);
  });

  it('does not mutate the caller array', () => {
    const input = [300, 100, 200];
    estimateMs(input);
    expect(input).toEqual([300, 100, 200]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/main/lib/stage-eta.test.ts`
Expected: FAIL — module `./stage-eta.js` does not exist.

- [ ] **Step 3: Implement the module**

Create `electron/main/lib/stage-eta.ts`:

```ts
// electron/main/lib/stage-eta.ts
//
// PURE estimate math for the learned per-stage ETA. No I/O, no DB, no clock —
// so it is trivially unit-tested and can't fail a pipeline run. The repo
// (stage-durations-repo) supplies recent samples; this module turns them into
// a bucket key and a median estimate with an honest cold-start fallback.

/** Upper bounds (exclusive) for transcript-char size buckets. A char count
 *  below SIZE_BUCKETS[i] lands in bucket i; anything at/above the last
 *  threshold is the final bucket. Four buckets total (indices 0..3):
 *  short / medium / long / very-long. Constants so they're easy to retune. */
export const SIZE_BUCKETS = [5_000, 20_000, 60_000] as const;

/** Below this many samples in a (stage,bucket) we don't trust an estimate and
 *  return null ("estimating…"). Keeps the first couple of meetings honest. */
export const MIN_SAMPLES = 3;

/** Only ever keep/consider the most-recent N samples per (stage,bucket) so the
 *  estimate tracks the user's current machine + model, not a stale baseline. */
export const MAX_SAMPLES_PER_BUCKET = 20;

/** Map a transcript char count to a bucket index (0..SIZE_BUCKETS.length).
 *  Non-finite or negative input collapses to bucket 0 (smallest). */
export function bucketForChars(chars: number): number {
  if (!Number.isFinite(chars) || chars < 0) return 0;
  for (let i = 0; i < SIZE_BUCKETS.length; i++) {
    if (chars < SIZE_BUCKETS[i]!) return i;
  }
  return SIZE_BUCKETS.length;
}

/** Median of the samples in milliseconds, or null on a cold start
 *  (fewer than MIN_SAMPLES). Median — not mean — so one runaway sample
 *  (e.g. a stage that limped to the request timeout) doesn't skew it.
 *  Does not mutate the input. */
export function estimateMs(samples: readonly number[]): number | null {
  if (samples.length < MIN_SAMPLES) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/main/lib/stage-eta.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add electron/main/lib/stage-eta.ts electron/main/lib/stage-eta.test.ts
git commit -m "feat(eta): pure stage-eta module (bucketing + median + cold-start)"
```

---

### Task 2: `stage_durations` table migration

**Files:**
- Modify: `electron/main/storage/migrations.ts` (append to the `MIGRATIONS` array, after version 11)

- [ ] **Step 1: Add migration version 12**

In `electron/main/storage/migrations.ts`, add this object as the last element of the `MIGRATIONS` array (after the `version: 11` entry, before the closing `];`):

```ts
  {
    version: 12,
    // Learned per-stage ETA (per-stage-progress-eta). Store one duration
    // sample per stage run, keyed by stage + a coarse transcript-size bucket,
    // so the UI can show "usually ~3m for a meeting this long on your machine"
    // next to elapsed time. Per-sample rows (not a rolling aggregate) because
    // the estimate is a median over the recent samples — that needs the raw
    // values and is what makes it robust to a single stage that limped to the
    // request timeout. The runner prunes each (stage, size_bucket) to the most
    // recent N (see StageDurationsRepo), so the table stays bounded. Lives in
    // the meetings/library DB alongside the pipeline state it describes.
    up: `
      CREATE TABLE IF NOT EXISTS stage_durations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stage TEXT NOT NULL,
        size_bucket INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stage_durations_lookup
        ON stage_durations(stage, size_bucket, recorded_at);
    `,
  },
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors (the migration is a plain data literal matching the `Migration` interface).

- [ ] **Step 3: Commit**

```bash
git add electron/main/storage/migrations.ts
git commit -m "feat(storage): stage_durations table for learned per-stage ETAs (migration 12)"
```

---

### Task 3: `StageDurationsRepo`

**Files:**
- Create: `electron/main/storage/stage-durations-repo.ts`
- Test: `electron/main/storage/stage-durations-repo.test.ts`

- [ ] **Step 1: Write the failing tests** (mirrors `meetings-repo.test.ts`; needs better-sqlite3 native bindings)

Create `electron/main/storage/stage-durations-repo.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { StageDurationsRepo } from './stage-durations-repo.js';

let repo: StageDurationsRepo;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sd-'));
  repo = new StageDurationsRepo(openDb(path.join(dir, 'db.sqlite')));
});

describe('StageDurationsRepo', () => {
  it('record + recentSamples round-trips for the same (stage, bucket)', () => {
    repo.record('summarizing', 1, 1000);
    repo.record('summarizing', 1, 2000);
    expect(repo.recentSamples('summarizing', 1, 10).sort((a, b) => a - b)).toEqual([1000, 2000]);
  });

  it('keys samples by stage AND size bucket', () => {
    repo.record('summarizing', 1, 1000);
    repo.record('summarizing', 2, 9999); // different bucket
    repo.record('extracting', 1, 5555);  // different stage
    expect(repo.recentSamples('summarizing', 1, 10)).toEqual([1000]);
    expect(repo.recentSamples('summarizing', 2, 10)).toEqual([9999]);
    expect(repo.recentSamples('extracting', 1, 10)).toEqual([5555]);
  });

  it('returns newest-first and honors the limit', () => {
    for (let i = 1; i <= 5; i++) repo.record('extracting', 0, i * 100);
    // Newest first → 500, 400, 300 ...; limit caps the count.
    expect(repo.recentSamples('extracting', 0, 3)).toEqual([500, 400, 300]);
  });

  it('prunes each (stage, bucket) to MAX_SAMPLES_PER_BUCKET most-recent rows', () => {
    for (let i = 1; i <= 25; i++) repo.record('summarizing', 0, i);
    const all = repo.recentSamples('summarizing', 0, 1000);
    expect(all.length).toBe(20); // MAX_SAMPLES_PER_BUCKET
    // The 5 oldest (1..5) were pruned; the newest (25) survives.
    expect(all[0]).toBe(25);
    expect(Math.min(...all)).toBe(6);
  });

  it('returns [] for an unseen (stage, bucket)', () => {
    expect(repo.recentSamples('merging', 3, 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/main/storage/stage-durations-repo.test.ts`
Expected: FAIL — `./stage-durations-repo.js` does not exist.

- [ ] **Step 3: Implement the repo**

Create `electron/main/storage/stage-durations-repo.ts`:

```ts
import type Database from 'better-sqlite3';
import { MAX_SAMPLES_PER_BUCKET } from '../lib/stage-eta.js';

/** Per-stage duration samples for the learned ETA. One row per stage run,
 *  keyed by (stage, size_bucket). Reads hand raw samples to the pure
 *  stage-eta module, which turns them into a median estimate. */
export class StageDurationsRepo {
  constructor(private readonly db: Database.Database) {}

  /** Insert one duration sample, then prune this (stage, size_bucket) to the
   *  most-recent MAX_SAMPLES_PER_BUCKET rows so the table stays bounded and the
   *  estimate tracks the user's current machine/model. */
  record(stage: string, sizeBucket: number, durationMs: number): void {
    const insert = this.db.prepare(
      'INSERT INTO stage_durations (stage, size_bucket, duration_ms, recorded_at) VALUES (?, ?, ?, ?)',
    );
    // Delete every row for this (stage, bucket) except the most-recent N by id.
    // id is a monotonic AUTOINCREMENT, so ordering by id DESC == newest-first
    // and avoids ties on recorded_at when several land in the same millisecond.
    const prune = this.db.prepare(`
      DELETE FROM stage_durations
       WHERE stage = ? AND size_bucket = ?
         AND id NOT IN (
           SELECT id FROM stage_durations
            WHERE stage = ? AND size_bucket = ?
            ORDER BY id DESC
            LIMIT ?
         )
    `);
    const tx = this.db.transaction(() => {
      insert.run(stage, sizeBucket, Math.round(durationMs), new Date().toISOString());
      prune.run(stage, sizeBucket, stage, sizeBucket, MAX_SAMPLES_PER_BUCKET);
    });
    tx();
  }

  /** The most-recent `limit` duration_ms values for this (stage, size_bucket),
   *  newest first. Empty array when the bucket has never been seen. */
  recentSamples(stage: string, sizeBucket: number, limit: number): number[] {
    const rows = this.db.prepare(`
      SELECT duration_ms FROM stage_durations
       WHERE stage = ? AND size_bucket = ?
       ORDER BY id DESC
       LIMIT ?
    `).all(stage, sizeBucket, limit) as { duration_ms: number }[];
    return rows.map((r) => r.duration_ms);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/main/storage/stage-durations-repo.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/storage/stage-durations-repo.ts electron/main/storage/stage-durations-repo.test.ts
git commit -m "feat(storage): StageDurationsRepo (record + recent samples, bounded)"
```

---

### Task 4: Wire the repo into context + runner, time each stage

**Files:**
- Modify: `electron/main/pipeline/context.ts` (add `stageDurations` to `PipelineContext`)
- Create: `electron/main/pipeline/transcript-chars.ts` (bucket-source helper)
- Modify: `electron/main/pipeline/pipeline.ts` (time each stage handler)
- Modify: `electron/main/index.ts` (construct + inject the repo)
- Test: `electron/main/pipeline/pipeline.test.ts`

- [ ] **Step 1: Add the context field**

In `electron/main/pipeline/context.ts`, add the import and the interface field.

After the existing `import type { SettingsRepo } ...` line, add:

```ts
import type { StageDurationsRepo } from '../storage/stage-durations-repo.js';
```

Inside `interface PipelineContext`, after the `settings: SettingsRepo;` line, add:

```ts
  /** Per-stage duration samples for the learned ETA. The runner records one
   *  sample per successful stage; the IPC layer reads recent samples to
   *  compute the estimate shown next to elapsed time. */
  stageDurations: StageDurationsRepo;
```

- [ ] **Step 2: Add the transcript-size helper**

Create `electron/main/pipeline/transcript-chars.ts`:

```ts
// electron/main/pipeline/transcript-chars.ts
import fs from 'node:fs';
import path from 'node:path';
import { meetingFolderPath } from '../storage/meeting-folder.js';

/** Char count of transcript.md for a meeting, or 0 if it doesn't exist yet.
 *  The size proxy for the learned ETA's bucket. Media stages that run before
 *  merge writes transcript.md fall to 0 (bucket 0) on a first pass — accepted
 *  in the design; refined as larger meetings accumulate samples. */
export function transcriptChars(libraryRoot: string, slug: string): number {
  const p = path.join(meetingFolderPath(libraryRoot, slug), 'transcript.md');
  try {
    return fs.existsSync(p) ? fs.statSync(p).size : 0;
  } catch {
    return 0;
  }
}
```

(`statSync().size` is byte length, a fine proxy for char count on the mostly-ASCII transcripts here — and avoids reading the whole file into memory just to `.length` it.)

- [ ] **Step 3: Write the failing runner tests**

Append to `electron/main/pipeline/pipeline.test.ts` (inside the existing top-level `describe`, or a new `describe('stage timing', ...)` — match the file's existing helper for building `ctx`/`deps`; the snippet below constructs its own minimal deps so it's self-contained):

```ts
  describe('stage timing (learned ETA)', () => {
    function timingDeps(summarizing: StageHandler) {
      const recorded: Array<{ stage: string; bucket: number; ms: number }> = [];
      const ctx: any = {
        libraryRoot: '/nowhere',
        meetings: {
          findById: () => ({ id: 'm', slug: 's', pipelineStage: 'summarizing', status: 'processing' }),
          updateStage: () => {},
          updateStatus: () => {},
        },
        stageDurations: {
          record: (stage: string, bucket: number, ms: number) => recorded.push({ stage, bucket, ms }),
          recentSamples: () => [],
        },
        logger: { error: () => {}, info: () => {} },
      };
      const noop: StageHandler = async () => {};
      const deps: any = {
        ctx,
        stages: {
          transcribing: noop, diarizing: noop, merging: noop, identifying: noop,
          summarizing, extracting: noop,
        },
      };
      return { deps, recorded };
    }

    it('records a positive duration sample for a stage that completes', async () => {
      const { deps, recorded } = timingDeps(async () => {});
      const pipeline = new Pipeline(deps);
      await pipeline.run('m');
      // transcript.md is absent at /nowhere → bucket 0. summarizing must be recorded.
      const s = recorded.find((r) => r.stage === 'summarizing');
      expect(s).toBeDefined();
      expect(s!.bucket).toBe(0);
      expect(s!.ms).toBeGreaterThanOrEqual(0);
    });

    it('records nothing for a stage that throws', async () => {
      const { deps, recorded } = timingDeps(async () => { throw new Error('boom'); });
      const pipeline = new Pipeline(deps);
      await pipeline.run('m'); // process() catches; run() rejects only via tick — use run() directly:
      expect(recorded.find((r) => r.stage === 'summarizing')).toBeUndefined();
    });
  });
```

> Note: if `pipeline.test.ts` doesn't already import `StageHandler`, add `import type { StageHandler } from './context.js';` at the top. The second test relies on `run()` propagating the throw; if the file's `run()` wrapper swallows it, wrap the call in `await expect(pipeline.run('m')).rejects.toThrow()` instead — either way the assertion on `recorded` is the real check.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run electron/main/pipeline/pipeline.test.ts`
Expected: FAIL — the runner doesn't call `ctx.stageDurations.record` yet.

- [ ] **Step 5: Add timing to the runner**

In `electron/main/pipeline/pipeline.ts`, add the import at the top (after the existing imports):

```ts
import { bucketForChars } from '../lib/stage-eta.js';
import { transcriptChars } from './transcript-chars.js';
```

Add a private timing helper method to the `Pipeline` class (e.g. right after `process()`):

```ts
  /** Run a stage handler and record its wall-clock duration as an ETA sample,
   *  bucketed by the meeting's transcript size. Timing must never break a real
   *  run: a failing stage records nothing (its time isn't representative), and
   *  a failing telemetry write is logged and swallowed. */
  private async timeStage(stage: WorkStage, input: StageInput, slug: string): Promise<void> {
    const start = performance.now();
    await this.deps.stages[stage](input, this.deps.ctx);
    const durationMs = performance.now() - start;
    try {
      const bucket = bucketForChars(transcriptChars(this.deps.ctx.libraryRoot, slug));
      this.deps.ctx.stageDurations.record(stage, bucket, durationMs);
    } catch (e) {
      this.deps.ctx.logger.error('pipeline:eta-record-failed', { stage, err: String(e) });
    }
  }
```

In the **parallel block** (currently `await Promise.all([...])`), replace the two direct handler calls with timed ones. Change:

```ts
      await Promise.all([
        this.deps.stages.transcribing(input, this.deps.ctx),
        this.deps.stages.diarizing(input, this.deps.ctx),
      ]);
```

to:

```ts
      await Promise.all([
        this.timeStage('transcribing', input, m.slug),
        this.timeStage('diarizing', input, m.slug),
      ]);
```

In the **linear loop**, replace the direct handler call. Change:

```ts
        this.deps.ctx.meetings.updateStage(meetingId, s);
        await this.deps.stages[s as WorkStage](input, this.deps.ctx);
```

to:

```ts
        this.deps.ctx.meetings.updateStage(meetingId, s);
        await this.timeStage(s as WorkStage, input, m.slug);
```

(`m` is already in scope in `process()` from the `findById` above the parallel block; it carries `slug`.)

- [ ] **Step 6: Construct + inject the repo in `index.ts`**

In `electron/main/index.ts`, add the import (near the other storage imports):

```ts
import { StageDurationsRepo } from './storage/stage-durations-repo.js';
```

After `const actionItems = new ActionItemsRepo(db);` (line ~128), add:

```ts
  const stageDurations = new StageDurationsRepo(db);
```

In the `PipelineContext` object literal (`const ctx = { ... }` that feeds `new Pipeline`), add `stageDurations,` alongside the other repo fields (`meetings`, `actionItems`, `settings`, …).

- [ ] **Step 7: Run tests + type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx vitest run electron/main/pipeline/pipeline.test.ts`
Expected: no type errors (every `PipelineContext` construction now supplies `stageDurations`); the two new timing tests pass; existing pipeline tests still pass.

> If any *other* test builds a `PipelineContext` and now fails to type-check for the missing `stageDurations`, add a minimal stub (`stageDurations: { record: () => {}, recentSamples: () => [] } as any`) to that test's ctx, matching how those tests already stub repos.

- [ ] **Step 8: Commit**

```bash
git add electron/main/pipeline/context.ts electron/main/pipeline/transcript-chars.ts electron/main/pipeline/pipeline.ts electron/main/pipeline/pipeline.test.ts electron/main/index.ts
git commit -m "feat(pipeline): time each stage and record a bucketed duration sample"
```

---

### Task 5: Surface `stageEtaMs` through the IPC payloads

**Files:**
- Modify: `electron/main/ipc/contracts.ts` (add `stageEtaMs` to `MeetingSummarySchema`)
- Create: `electron/main/ipc/stage-eta-for-meeting.ts` (compose repo read + pure estimate)
- Test: `electron/main/ipc/stage-eta-for-meeting.test.ts`
- Modify: `electron/main/ipc/handlers.ts` (populate `stageEtaMs` in `meetings:list` + `meetings:get`)

- [ ] **Step 1: Add the schema field**

In `electron/main/ipc/contracts.ts`, inside `MeetingSummarySchema` (after `actionItemsCount: z.number(),`), add:

```ts
  /** Learned estimate (ms) for the meeting's CURRENT stage, or null on a cold
   *  start / non-work stage. The renderer shows it next to elapsed time
   *  ("summarize — 1m 40s · ~3m"). Median of recent same-size samples on this
   *  machine; see stage-eta.ts. */
  stageEtaMs: z.number().nullable(),
```

- [ ] **Step 2: Write the failing composer tests**

Create `electron/main/ipc/stage-eta-for-meeting.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stageEtaForMeeting } from './stage-eta-for-meeting.js';

function repoWith(samples: Record<string, number[]>) {
  return {
    recentSamples: (stage: string, bucket: number, _limit: number) =>
      samples[`${stage}:${bucket}`] ?? [],
  };
}

describe('stageEtaForMeeting', () => {
  it('returns null for a non-work stage (done / awaiting_speaker_id / discovered)', () => {
    const repo = repoWith({});
    expect(stageEtaForMeeting(repo as any, 'done', 0)).toBeNull();
    expect(stageEtaForMeeting(repo as any, 'awaiting_speaker_id', 0)).toBeNull();
    expect(stageEtaForMeeting(repo as any, 'discovered', 0)).toBeNull();
  });

  it('returns null on a cold start (too few samples)', () => {
    const repo = repoWith({ 'summarizing:1': [1000, 2000] }); // < MIN_SAMPLES
    expect(stageEtaForMeeting(repo as any, 'summarizing', 8000)).toBeNull();
  });

  it('returns the median estimate for a warm single-stage step', () => {
    const repo = repoWith({ 'summarizing:1': [1000, 3000, 2000] }); // bucket for 8000 chars = 1
    expect(stageEtaForMeeting(repo as any, 'summarizing', 8000)).toBe(2000);
  });

  it('combines transcribing+diarizing with max for the transcribe step', () => {
    const repo = repoWith({
      'transcribing:0': [1000, 1000, 1000],
      'diarizing:0': [4000, 4000, 4000],
    });
    // Parallel stages: wall-clock is bounded by the slower one.
    expect(stageEtaForMeeting(repo as any, 'transcribing', 0)).toBe(4000);
    expect(stageEtaForMeeting(repo as any, 'diarizing', 0)).toBe(4000);
  });

  it('returns the sibling estimate when one parallel stage is still cold', () => {
    const repo = repoWith({
      'transcribing:0': [2000, 2000, 2000],
      'diarizing:0': [], // cold
    });
    // max(2000, null) → 2000: a warm sibling still gives a usable number.
    expect(stageEtaForMeeting(repo as any, 'transcribing', 0)).toBe(2000);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run electron/main/ipc/stage-eta-for-meeting.test.ts`
Expected: FAIL — `./stage-eta-for-meeting.js` does not exist.

- [ ] **Step 4: Implement the composer**

Create `electron/main/ipc/stage-eta-for-meeting.ts`:

```ts
// electron/main/ipc/stage-eta-for-meeting.ts
import { bucketForChars, estimateMs, MAX_SAMPLES_PER_BUCKET } from '../lib/stage-eta.js';

interface SampleSource {
  recentSamples(stage: string, sizeBucket: number, limit: number): number[];
}

/** Stages the pipeline actually times (WorkStage). Anything else — the
 *  awaiting_speaker_id gate, discovered, done — has no estimate. */
const WORK_STAGES = new Set([
  'transcribing', 'diarizing', 'merging', 'identifying', 'summarizing', 'extracting',
]);

function estimateForStage(repo: SampleSource, stage: string, bucket: number): number | null {
  return estimateMs(repo.recentSamples(stage, bucket, MAX_SAMPLES_PER_BUCKET));
}

/** Learned estimate (ms) for a meeting's CURRENT pipeline stage, or null on a
 *  cold start / non-work stage. `transcribing` and `diarizing` run in parallel
 *  and collapse to one user "transcribe" step, so their estimate is the max of
 *  the two (wall-clock is bounded by the slower branch); max ignores a null
 *  sibling so a single warm branch still yields a number. */
export function stageEtaForMeeting(
  repo: SampleSource,
  pipelineStage: string,
  transcriptCharCount: number,
): number | null {
  if (!WORK_STAGES.has(pipelineStage)) return null;
  const bucket = bucketForChars(transcriptCharCount);
  if (pipelineStage === 'transcribing' || pipelineStage === 'diarizing') {
    const t = estimateForStage(repo, 'transcribing', bucket);
    const d = estimateForStage(repo, 'diarizing', bucket);
    if (t === null && d === null) return null;
    return Math.max(t ?? 0, d ?? 0);
  }
  return estimateForStage(repo, pipelineStage, bucket);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run electron/main/ipc/stage-eta-for-meeting.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Populate `stageEtaMs` in the handlers**

In `electron/main/ipc/handlers.ts`, add the imports near the top (with the other pipeline/lib imports):

```ts
import { stageEtaForMeeting } from './stage-eta-for-meeting.js';
import { transcriptChars } from '../pipeline/transcript-chars.js';
```

In the `meetings:list` handler, inside the `.map((m) => { ... })`, before the returned object, compute:

```ts
      const stageEtaMs = stageEtaForMeeting(
        s.stageDurations,
        m.pipelineStage,
        transcriptChars(s.libraryRoot, m.slug),
      );
```

and add `stageEtaMs,` to the returned object (next to `actionItemsCount`).

In the `meetings:get` handler, before the returned object, compute the same (reusing the `folder`/`m` already in scope — you can pass `transcriptChars(s.libraryRoot, m.slug)`), and add `stageEtaMs,` to the returned object.

> `s.stageDurations` must be on the handler's service bag `s`. It already carries `meetings`, `actionItems`, `settings`, `pipeline`, `libraryRoot`, etc.; add `stageDurations` when the bag is constructed in `index.ts` (the same object passed to `registerHandlers`/`createHandlers`). Grep for where `s.actionItems` is set and add `stageDurations` beside it.

- [ ] **Step 7: Type-check + run the IPC tests**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx vitest run electron/main/ipc/`
Expected: no type errors; the new composer tests pass; existing handler tests pass (they mock the service bag — if a handler test asserts the exact `meetings:list` shape, add `stageEtaMs: null` to its expectation and a `stageDurations: { recentSamples: () => [] }` stub to its bag).

- [ ] **Step 8: Commit**

```bash
git add electron/main/ipc/contracts.ts electron/main/ipc/stage-eta-for-meeting.ts electron/main/ipc/stage-eta-for-meeting.test.ts electron/main/ipc/handlers.ts
git commit -m "feat(ipc): expose learned stageEtaMs on meeting summary/detail payloads"
```

---

### Task 6: Render `elapsed · ~estimate` with an overrun cue

**Files:**
- Create: `electron/renderer/src/lib/fmtEta.ts`
- Test: `electron/renderer/src/lib/fmtEta.test.ts`
- Modify: `electron/renderer/src/views/MeetingDetailView.tsx` (the `MeetingDetail` interface + `StageTimeline`)

- [ ] **Step 1: Write the failing formatter tests**

Create `electron/renderer/src/lib/fmtEta.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fmtEta, isRunningLong } from './fmtEta.js';

describe('fmtEta', () => {
  it('shows "estimating…" when no estimate is available', () => {
    expect(fmtEta(null)).toBe('estimating…');
  });

  it('formats a sub-minute estimate as ~Ns', () => {
    expect(fmtEta(45_000)).toBe('~45s');
  });

  it('formats a multi-minute estimate as ~Mm', () => {
    // Round to the nearest minute for a credible, non-jittery figure.
    expect(fmtEta(180_000)).toBe('~3m');
    expect(fmtEta(200_000)).toBe('~3m');
    expect(fmtEta(150_000)).toBe('~3m'); // 2.5m rounds to 3m
  });
});

describe('isRunningLong', () => {
  it('is false without an estimate (nothing to overrun)', () => {
    expect(isRunningLong(999, null)).toBe(false);
  });

  it('is false while elapsed is within 1.5x the estimate', () => {
    // estimate 120s, elapsed 150s → 1.25x, still fine.
    expect(isRunningLong(150, 120_000)).toBe(false);
  });

  it('is true once elapsed exceeds 1.5x the estimate', () => {
    // estimate 120s, elapsed 200s → 1.66x → running long.
    expect(isRunningLong(200, 120_000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/renderer/src/lib/fmtEta.test.ts`
Expected: FAIL — `./fmtEta.js` does not exist.

- [ ] **Step 3: Implement the formatter**

Create `electron/renderer/src/lib/fmtEta.ts`:

```ts
// electron/renderer/src/lib/fmtEta.ts
//
// Render helpers for the learned per-stage ETA. Kept out of the component so
// they're unit-tested without a DOM. Elapsed formatting stays in useElapsed;
// this module owns the estimate string + the "running long" overrun cue.

/** How far past the estimate a stage may run before we flag it as overrunning.
 *  1.5x gives real slack for normal variance while still surfacing a genuine
 *  hang well before the 10-minute request timeout fires. */
export const OVERRUN_FACTOR = 1.5;

/** "~45s" / "~3m" for a learned estimate in ms, or "estimating…" when we don't
 *  have enough samples yet (etaMs === null). Rounded to a coarse figure so it
 *  reads as an estimate, not a stopwatch. */
export function fmtEta(etaMs: number | null): string {
  if (etaMs === null) return 'estimating…';
  const seconds = etaMs / 1000;
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  return `~${Math.round(seconds / 60)}m`;
}

/** True when the current stage's elapsed time (seconds) has run past
 *  OVERRUN_FACTOR × the estimate — a cue that this may be a genuine hang.
 *  False when there's no estimate to compare against. */
export function isRunningLong(elapsedSeconds: number, etaMs: number | null): boolean {
  if (etaMs === null) return false;
  return elapsedSeconds * 1000 > etaMs * OVERRUN_FACTOR;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/renderer/src/lib/fmtEta.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Thread `stageEtaMs` into the detail view**

In `electron/renderer/src/views/MeetingDetailView.tsx`:

Add the import (with the other lib imports near the top):

```ts
import { fmtEta, isRunningLong } from '../lib/fmtEta';
```

Add the field to the `MeetingDetail` interface (after `stageStartedAt: string | null;`):

```ts
  stageEtaMs: number | null;
```

In `StageTimeline`, the current-step block already renders elapsed:

```tsx
              {isCurrent && isProcessing && elapsed !== null && (
                <span className="font-normal opacity-80">{fmtElapsed(elapsed)}</span>
              )}
```

Replace that block with the elapsed value plus the estimate and overrun cue:

```tsx
              {isCurrent && isProcessing && elapsed !== null && (
                <span className="font-normal opacity-80">
                  {fmtElapsed(elapsed)}
                  {' · '}
                  <span className={isRunningLong(elapsed, meeting.stageEtaMs) ? 'text-status-warnText font-semibold' : ''}>
                    {fmtEta(meeting.stageEtaMs)}
                    {isRunningLong(elapsed, meeting.stageEtaMs) ? ' · running long' : ''}
                  </span>
                </span>
              )}
```

- [ ] **Step 6: Type-check the renderer + run its tests**

Run: `npx tsc -p tsconfig.web.json --noEmit && npx vitest run electron/renderer/src/lib/fmtEta.test.ts`
Expected: no type errors (the IPC `MeetingDetail` shape from Task 5 carries `stageEtaMs`, so the interface field is satisfied by real data); formatter tests pass.

> If the renderer maps the IPC payload into its local `MeetingDetail` explicitly (rather than spreading), add `stageEtaMs: d.stageEtaMs ?? null` to that mapping so the field is populated.

- [ ] **Step 7: Full suite + type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add electron/renderer/src/lib/fmtEta.ts electron/renderer/src/lib/fmtEta.test.ts electron/renderer/src/views/MeetingDetailView.tsx
git commit -m "feat(ui): show learned ETA next to elapsed time with a running-long cue"
```

---

## Self-Review

**Spec coverage:** Storage choice (library DB, per-sample `stage_durations` table) → Task 2. `StageDurationsRepo` with pruning → Task 3. Pure estimate math (bucketing + median + cold-start `null`) → Task 1. Timing at the single runner measurement point, parallel stages timed individually, errors swallowed → Task 4. Estimate rides the existing `MeetingSummary`/`MeetingDetail` payloads (no new channel), `transcribe` step combines the two parallel stages with `max` → Task 5. Renderer shows `elapsed · ~estimate`, "estimating…" cold start, and the `1.5×` overrun cue → Task 6. Which stages get estimates (the `WorkStage` set, `awaiting_speaker_id`/`discovered`/`done` excluded) → enforced in Task 5's `WORK_STAGES`. No gaps against the spec's Design questions.

**Placeholder scan:** Every implementation step shows complete code; every run step has a command and an expected outcome. The two `>` notes (test-bag stubs, renderer mapping) are conditional guards for codebase-specific wiring the plan can't see verbatim, each with the exact fix to apply — not TBDs in the delivered code.

**Purity isolation:** All estimate math is in `stage-eta.ts` (bucketing + median + fallback) and the thin `stage-eta-for-meeting.ts` composer, both unit-tested with zero I/O. Side-effects are confined to the repo (SQLite), the runner wrapper (`timeStage`, which swallows telemetry errors), and one render block. No math lives in a side-effecting path.

**Type consistency:** `stageEtaMs` is added once to `MeetingSummarySchema` and inherited by `MeetingDetailSchema`; the renderer interface mirrors it. `PipelineContext.stageDurations` is a `StageDurationsRepo`; the composer depends only on a structural `recentSamples` interface, so tests stub it without the concrete class. `MAX_SAMPLES_PER_BUCKET` is defined once in `stage-eta.ts` and reused by the repo (prune limit) and the composer (read limit) — no divergent magic numbers.

**Migration correctness:** Version 12 follows the existing pattern exactly — appended to `MIGRATIONS`, single `up` string, run inside the array loop's `BEGIN`/`COMMIT` transaction with `schema_version` bookkeeping already handled by `runMigrations`. `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` are idempotent, matching migrations 1/6/9.

**Ordering note:** Tasks are strictly dependency-ordered — Task 3 imports `MAX_SAMPLES_PER_BUCKET` from Task 1; Task 4 injects the Task 3 repo; Task 5 reads it; Task 6 renders Task 5's field. Each task's own tests pass in isolation at the point it lands.
