// electron/renderer/src/lib/live-capture.ts
//
// Live capture levels and health for the active recording, held OUTSIDE any
// component (#297). The Library's inline row and the compact pill on other
// views each used to keep this in local state, so switching views mid-call
// threw away "which sources have we heard" and "when did we last hear them".
// Past the 5 s grace period that produced a false "No microphone or app audio
// detected" warning and a wrong stop summary.
//
// One store, one `onLevel` subscription, any number of readers. Peaks change
// many times a second and are read only by meters; health changes about once
// a second and drives the warnings.
import { useSyncExternalStore } from 'react';
import { api } from '../ipc/client';
import type { CaptureLevelSource } from './capture-health';

export type Peaks = Record<CaptureLevelSource, number>;
export interface CaptureSignals {
  /** Sources that have delivered at least one level event (any loudness). */
  received: Partial<Record<CaptureLevelSource, boolean>>;
  /** When each source was last above the audible threshold. */
  lastAudibleAt: Partial<Record<CaptureLevelSource, number>>;
}
interface LevelEvent { sessionId: string; source?: CaptureLevelSource; peakDb: number }
type Subscribe = (cb: (event: LevelEvent) => void) => () => void;

const QUIET: Peaks = { mic: -60, system: -60, mixed: -60 };
const AUDIBLE_DB = -50;
/** A still-audible source refreshes its "last heard" time at most this often;
 *  capture health works in whole seconds. */
const AUDIBLE_REFRESH_MS = 1000;

export function createLiveCapture(subscribe: Subscribe, now: () => number = Date.now) {
  let sessionId: string | null = null;
  let peaks: Peaks = QUIET;
  let signals: CaptureSignals = { received: {}, lastAudibleAt: {} };
  let seen = new Set<CaptureLevelSource>();
  let holders = 0;
  let off: (() => void) | null = null;
  const peakListeners = new Set<() => void>();
  const signalListeners = new Set<() => void>();
  const notify = (listeners: Set<() => void>): void => { for (const listener of [...listeners]) listener(); };

  function onLevel(event: LevelEvent): void {
    if (event.sessionId !== sessionId || !Number.isFinite(event.peakDb)) return;
    const source = event.source ?? 'mixed';
    if (peaks[source] !== event.peakDb) { peaks = { ...peaks, [source]: event.peakDb }; notify(peakListeners); }
    let next = signals;
    if (!next.received[source]) next = { ...next, received: { ...next.received, [source]: true } };
    if (event.peakDb > AUDIBLE_DB) {
      seen.add(source);
      const at = now(), previous = next.lastAudibleAt[source];
      if (previous === undefined || at - previous >= AUDIBLE_REFRESH_MS) {
        next = { ...next, lastAudibleAt: { ...next.lastAudibleAt, [source]: at } };
      }
    }
    if (next !== signals) { signals = next; notify(signalListeners); }
  }

  return {
    /** Start following `id`. History is kept across attach/detach for the same
     *  session and reset only when a different session attaches. */
    attach(id: string): () => void {
      if (id !== sessionId) {
        sessionId = id; peaks = QUIET; signals = { received: {}, lastAudibleAt: {} }; seen = new Set();
        notify(peakListeners); notify(signalListeners);
      }
      holders++;
      if (!off) off = subscribe(onLevel);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--holders === 0 && off) { off(); off = null; }
      };
    },
    sessionId: (): string | null => sessionId,
    getPeaks: (): Peaks => peaks,
    getSignals: (): CaptureSignals => signals,
    /** Sources heard at an audible level at any point in this session. */
    seen: (): ReadonlySet<CaptureLevelSource> => seen,
    subscribePeaks(listener: () => void): () => void { peakListeners.add(listener); return () => { peakListeners.delete(listener); }; },
    subscribeSignals(listener: () => void): () => void { signalListeners.add(listener); return () => { signalListeners.delete(listener); }; },
  };
}

export type LiveCapture = ReturnType<typeof createLiveCapture>;
export const liveCapture = createLiveCapture((cb) => api.recording.onLevel(cb));

export function useCapturePeaks(store: LiveCapture = liveCapture): Peaks {
  return useSyncExternalStore(store.subscribePeaks, store.getPeaks);
}
export function useCaptureSignals(store: LiveCapture = liveCapture): CaptureSignals {
  return useSyncExternalStore(store.subscribeSignals, store.getSignals);
}
