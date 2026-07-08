import { describe, it, expect } from 'vitest';
import { nextPlaybackRate, fmtPlaybackRate, guardedSeek } from './audio-controls';

describe('nextPlaybackRate', () => {
  it('cycles 1 → 1.25 → 1.5 → 2 → 1', () => {
    expect(nextPlaybackRate(1)).toBe(1.25);
    expect(nextPlaybackRate(1.25)).toBe(1.5);
    expect(nextPlaybackRate(1.5)).toBe(2);
    expect(nextPlaybackRate(2)).toBe(1);
  });

  it('resets unknown rates to 1×', () => {
    expect(nextPlaybackRate(0.5)).toBe(1);
    expect(nextPlaybackRate(3)).toBe(1);
    expect(nextPlaybackRate(NaN)).toBe(1);
  });
});

describe('fmtPlaybackRate', () => {
  it('renders compact labels', () => {
    expect(fmtPlaybackRate(1)).toBe('1×');
    expect(fmtPlaybackRate(1.25)).toBe('1.25×');
    expect(fmtPlaybackRate(1.5)).toBe('1.5×');
    expect(fmtPlaybackRate(2)).toBe('2×');
  });
});

describe('guardedSeek', () => {
  it('applies the delta inside the clamp range', () => {
    expect(guardedSeek(60, 15, 300)).toBe(75);
    expect(guardedSeek(60, -15, 300)).toBe(45);
  });

  it('clamps at 0 when skipping back near the start', () => {
    expect(guardedSeek(5, -15, 300)).toBe(0);
    expect(guardedSeek(0, -15, 300)).toBe(0);
  });

  it('clamps at duration when skipping past the end', () => {
    expect(guardedSeek(295, 15, 300)).toBe(300);
    expect(guardedSeek(300, 15, 300)).toBe(300);
  });

  it('only clamps the lower bound when duration is unknown', () => {
    expect(guardedSeek(10, 15, NaN)).toBe(25);
    expect(guardedSeek(10, 15, Infinity)).toBe(25);
    expect(guardedSeek(10, 15, 0)).toBe(25);
    expect(guardedSeek(5, -15, NaN)).toBe(0);
  });
});
