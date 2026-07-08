// electron/main/lib/peak-throttle.ts
//
// Per-key peak-hold throttle for high-rate scalar streams (VU meter
// levels). The recording helper emits a level line per audio buffer
// (30–60/sec); forwarding each one over IPC to every window burns CPU
// in both processes for meter movement no eye can follow. This module
// coalesces pushes per key and emits at most once per `intervalMs`,
// carrying the MAX value seen in the window — peaks are what a VU
// meter must not miss, so we hold the loudest sample rather than the
// latest.
//
// Pure Node (timers only, no Electron imports) so it unit-tests with
// fake timers and stays reusable.

export interface PeakThrottle {
  /** Feed one sample for `key`. Emits immediately when the interval has
   *  already elapsed since the last emit for that key; otherwise tracks
   *  the running max and emits it when the window closes. */
  push(key: string, value: number): void;
}

interface Entry {
  lastEmitAt: number;
  pending: number | null;
  timer: NodeJS.Timeout | null;
}

export function createPeakThrottle(
  intervalMs: number,
  emit: (key: string, peak: number) => void,
): PeakThrottle {
  const entries = new Map<string, Entry>();
  return {
    push(key: string, value: number): void {
      let e = entries.get(key);
      if (!e) {
        e = { lastEmitAt: -Infinity, pending: null, timer: null };
        entries.set(key, e);
      }
      const now = Date.now();
      // Fast path: window is open (nothing queued, interval elapsed) —
      // pass the sample straight through so sparse streams stay snappy.
      if (e.timer === null && now - e.lastEmitAt >= intervalMs) {
        e.lastEmitAt = now;
        emit(key, value);
        return;
      }
      // Inside a window: hold the peak, schedule the flush for the
      // moment the interval since the last emit elapses.
      e.pending = e.pending === null ? value : Math.max(e.pending, value);
      if (e.timer === null) {
        const entry = e;
        const delay = Math.max(0, intervalMs - (now - entry.lastEmitAt));
        entry.timer = setTimeout(() => {
          entry.timer = null;
          const peak = entry.pending;
          entry.pending = null;
          if (peak !== null) {
            entry.lastEmitAt = Date.now();
            emit(key, peak);
          }
        }, delay);
        // Don't hold the process open for a meter flush.
        entry.timer.unref?.();
      }
    },
  };
}
