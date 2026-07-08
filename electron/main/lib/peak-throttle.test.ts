import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPeakThrottle } from './peak-throttle.js';

describe('createPeakThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a sparse push through promptly', () => {
    const emit = vi.fn();
    const t = createPeakThrottle(100, emit);
    t.push('a', -12);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('a', -12);
  });

  it('coalesces rapid pushes into one emit per window carrying the peak', () => {
    const emit = vi.fn();
    const t = createPeakThrottle(100, emit);
    // Burst at t=0: first goes straight through.
    t.push('a', -30);
    expect(emit).toHaveBeenCalledTimes(1);
    // Nine more inside the window — none emit yet.
    for (const v of [-25, -40, -18, -22, -50, -19, -33, -21, -27]) {
      vi.advanceTimersByTime(10);
      t.push('a', v);
    }
    expect(emit).toHaveBeenCalledTimes(1);
    // Window closes → one emit with the MAX seen during the window.
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('a', -18);
  });

  it('emits immediately again once the interval has elapsed since the last emit', () => {
    const emit = vi.fn();
    const t = createPeakThrottle(100, emit);
    t.push('a', -20);
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(150); // no pending pushes — timer window empty
    t.push('a', -10);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('a', -10);
  });

  it('does not emit an empty window (no pushes → no timer emit)', () => {
    const emit = vi.fn();
    const t = createPeakThrottle(100, emit);
    t.push('a', -20);
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('tracks keys independently', () => {
    const emit = vi.fn();
    const t = createPeakThrottle(100, emit);
    t.push('a', -20);
    t.push('b', -35);
    // Both first pushes pass through — separate windows per key.
    expect(emit).toHaveBeenCalledTimes(2);
    t.push('a', -5);
    t.push('b', -60);
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(4);
    const calls = emit.mock.calls.slice(2);
    expect(calls).toContainEqual(['a', -5]);
    expect(calls).toContainEqual(['b', -60]);
  });

  it('caps sustained input at one emit per interval', () => {
    const emit = vi.fn();
    const t = createPeakThrottle(100, emit);
    // 60 pushes over 1s (~every 16ms) — a 60Hz VU stream.
    for (let i = 0; i < 60; i++) {
      t.push('a', -30 + (i % 7));
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(200); // flush the trailing window
    // 1s of input at 100ms windows → at most ~11 emits, far below 60.
    expect(emit.mock.calls.length).toBeLessThanOrEqual(11);
    expect(emit.mock.calls.length).toBeGreaterThanOrEqual(9);
  });
});
