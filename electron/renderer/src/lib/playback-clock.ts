// electron/renderer/src/lib/playback-clock.ts
//
// Playback position as an external store instead of React state at the
// MeetingDetailView root (#301). The <audio> element's timeupdate ticks used
// to set root state once a second, re-rendering the header, timeline, notes
// and right rail during playback even on the Summary/Actions tabs. Only the
// transcript needs the position, so it alone subscribes.
import { useSyncExternalStore } from 'react';

export interface PlaybackClock {
  get: () => number;
  /** Publishes a new position; a repeat of the current value notifies no one. */
  set: (seconds: number) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPlaybackClock(initial = 0): PlaybackClock {
  let seconds = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => seconds,
    set(next) {
      if (next === seconds) return;
      seconds = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export function usePlaybackTime(clock: PlaybackClock): number {
  return useSyncExternalStore(clock.subscribe, clock.get);
}
