import { describe, it, expect, vi } from 'vitest';
import { createPlaybackClock } from './playback-clock.js';

describe('createPlaybackClock', () => {
  it('notifies subscribers only when the position changes', () => {
    const clock = createPlaybackClock();
    const listener = vi.fn();
    const off = clock.subscribe(listener);
    clock.set(0);
    expect(listener).not.toHaveBeenCalled();
    clock.set(12);
    clock.set(12);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(clock.get()).toBe(12);
    off();
    clock.set(13);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(clock.get()).toBe(13);
  });

  it('tolerates a listener unsubscribing during a notification', () => {
    const clock = createPlaybackClock();
    const second = vi.fn();
    const offFirst = clock.subscribe(() => offFirst());
    clock.subscribe(second);
    clock.set(1);
    clock.set(2);
    expect(second).toHaveBeenCalledTimes(2);
  });
});
