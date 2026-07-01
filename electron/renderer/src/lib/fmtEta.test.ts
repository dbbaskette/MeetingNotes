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
