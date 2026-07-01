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
