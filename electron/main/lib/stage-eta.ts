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
