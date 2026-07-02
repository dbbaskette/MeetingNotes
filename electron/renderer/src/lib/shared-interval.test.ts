import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSharedInterval } from './shared-interval.js';

describe('createSharedInterval', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs one timer no matter how many holders acquire', () => {
    const fn = vi.fn();
    const shared = createSharedInterval(fn, 1000);
    const releaseA = shared.acquire();
    const releaseB = shared.acquire(); // second holder must NOT double the ticks
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    releaseA();
    releaseB();
  });

  it('keeps ticking until the last holder releases', () => {
    const fn = vi.fn();
    const shared = createSharedInterval(fn, 1000);
    const releaseA = shared.acquire();
    const releaseB = shared.acquire();
    releaseA();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1); // B still holds
    releaseB();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1); // fully stopped
  });

  it('restarts cleanly after a full stop', () => {
    const fn = vi.fn();
    const shared = createSharedInterval(fn, 1000);
    shared.acquire()();
    const release = shared.acquire();
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);
    release();
  });

  it('tolerates a double release without underflowing the count', () => {
    const fn = vi.fn();
    const shared = createSharedInterval(fn, 1000);
    const releaseA = shared.acquire();
    releaseA();
    releaseA(); // sloppy caller — must not push the count negative
    const releaseB = shared.acquire();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1); // B's hold still works
    releaseB();
  });
});
