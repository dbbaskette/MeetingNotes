import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPausableTimer, toastDuration, visibleToasts, TOAST_CAP } from './toast-queue';

describe('toastDuration', () => {
  it('defaults neutral toasts to 6s', () => { expect(toastDuration({})).toBe(6000); });
  it('keeps errors until dismissed', () => { expect(toastDuration({ variant: 'error' })).toBeNull(); });
  it('honours an explicit duration, including for errors', () => {
    expect(toastDuration({ variant: 'error', durationMs: 4000 })).toBe(4000);
    expect(toastDuration({ durationMs: null })).toBeNull();
  });
});

describe('visibleToasts', () => {
  it('keeps the newest up to the cap', () => {
    const list = [1, 2, 3, 4, 5, 6];
    expect(visibleToasts(list)).toEqual(list.slice(-TOAST_CAP));
    expect(visibleToasts([1])).toEqual([1]);
  });
});

describe('createPausableTimer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it('fires after the duration', () => {
    const done = vi.fn();
    createPausableTimer(1000, done);
    vi.advanceTimersByTime(999); expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(done).toHaveBeenCalledTimes(1);
  });
  it('pauses and resumes with the remaining time', () => {
    const done = vi.fn();
    const timer = createPausableTimer(1000, done);
    vi.advanceTimersByTime(600); timer.pause();
    vi.advanceTimersByTime(5000); expect(done).not.toHaveBeenCalled();
    timer.resume();
    vi.advanceTimersByTime(399); expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(done).toHaveBeenCalledTimes(1);
  });
  it('does nothing after cancel, and ignores double pause/resume', () => {
    const done = vi.fn();
    const timer = createPausableTimer(1000, done);
    timer.pause(); timer.pause(); timer.resume(); timer.resume();
    timer.cancel(); vi.advanceTimersByTime(5000);
    expect(done).not.toHaveBeenCalled();
  });
});
