import { describe, it, expect } from 'vitest';
import { bucketForChars, estimateStage, MIN_SAMPLES } from './stage-eta.js';

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

describe('estimateStage', () => {
  it('returns null on a true cold start (zero samples)', () => {
    expect(estimateStage([])).toBeNull();
  });

  it('returns a rough estimate from 1-2 samples', () => {
    expect(MIN_SAMPLES).toBe(3);
    // One sample is already more useful than a shrug — surface it, hedged.
    expect(estimateStage([100])).toEqual({ etaMs: 100, rough: true });
    // Two samples: median degrades to the two-value average.
    expect(estimateStage([100, 200])).toEqual({ etaMs: 150, rough: true });
  });

  it('returns a firm median at MIN_SAMPLES or more', () => {
    expect(estimateStage([300, 100, 200])).toEqual({ etaMs: 200, rough: false });
    expect(estimateStage([100, 200, 300, 400])).toEqual({ etaMs: 250, rough: false });
  });

  it('is robust to a single runaway outlier (median, not mean)', () => {
    // A stage that limped to the 10-minute timeout must not skew the estimate.
    expect(estimateStage([100, 110, 120, 130, 600_000])).toEqual({ etaMs: 120, rough: false });
  });

  it('does not mutate the caller array', () => {
    const input = [300, 100, 200];
    estimateStage(input);
    expect(input).toEqual([300, 100, 200]);
  });
});
