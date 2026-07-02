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

/** At/above this many samples in a (stage,bucket) the estimate is FIRM. With
 *  1-2 samples we still surface a number, flagged `rough` so the UI can hedge
 *  it ("~3m (rough)") — one real sample beats "estimating…". Zero samples is
 *  the only true cold start. */
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

/** A learned estimate plus how much to trust it. `rough` is true when it was
 *  derived from fewer than MIN_SAMPLES samples, so callers/UI can hedge it. */
export interface StageEstimate {
  etaMs: number;
  rough: boolean;
}

/** Median of the samples (ms) with a roughness grade, or null on a true cold
 *  start (zero samples). Median — not mean — so one runaway sample (e.g. a
 *  stage that limped to the request timeout) doesn't skew it. With 1-2 samples
 *  the median degrades naturally to the single value / two-value average and
 *  the result is flagged `rough`. Does not mutate the input. */
export function estimateStage(samples: readonly number[]): StageEstimate | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const etaMs = sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { etaMs, rough: samples.length < MIN_SAMPLES };
}
