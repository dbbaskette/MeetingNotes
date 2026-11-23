// electron/renderer/src/lib/silence-prompt.ts
//
// Renderer side of the "all audio stopped" prompt (#305). The main process
// owns the state machine and the countdown; this store mirrors the pending
// prompt so the Library's recording row and the compact pill on other views
// show the same thing, and a view that mounts mid-countdown hydrates.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '../ipc/client';

/** Hand-kept twin of SILENCE_AUTO_STOP_REASON in electron/main/recording/
 *  manager.ts (renderer code cannot import main-process modules). It arrives
 *  as the `reason` of the `idle` state change after an automatic stop; a
 *  parity test keeps the two in sync. */
export const SILENCE_AUTO_STOP_REASON = 'Stopped automatically after audio went silent';

export interface SilencePrompt { sessionId: string; silentForMs: number; autoStopAtMs: number }
export type SilenceClearedReason = 'audio-resumed' | 'continued' | 'stopped' | 'auto-stopped';

/** The slice of the preload bridge this feature uses. Every member is
 *  optional so UI fixtures (hand-written fake bridges) and an older preload
 *  simply show no prompt instead of throwing on mount. */
export interface SilenceBridge {
  continueSilence?: (sessionId: string) => Promise<void>;
  silenceState?: () => Promise<SilencePrompt | null>;
  onSilencePrompt?: (cb: (prompt: SilencePrompt) => void) => () => void;
  onSilenceCleared?: (cb: (event: { sessionId: string; reason: SilenceClearedReason }) => void) => () => void;
}

export function createSilencePromptStore(bridge: () => SilenceBridge) {
  let prompt: SilencePrompt | null = null;
  let holders = 0;
  let stop: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const set = (next: SilencePrompt | null): void => {
    if (next === prompt) return;
    prompt = next;
    for (const listener of [...listeners]) listener();
  };
  function start(): () => void {
    const b = bridge();
    let live = true, sawEvent = false;
    const offPrompt = b.onSilencePrompt?.((next) => { sawEvent = true; set(next); });
    const offCleared = b.onSilenceCleared?.(({ sessionId }) => { sawEvent = true; if (prompt?.sessionId === sessionId) set(null); });
    // A pushed event is newer than the snapshot; never let the snapshot overwrite it.
    void b.silenceState?.().then((current) => { if (live && !sawEvent) set(current ?? null); }).catch(() => { /* no prompt shown */ });
    return () => { live = false; offPrompt?.(); offCleared?.(); };
  }
  return {
    get: (): SilencePrompt | null => prompt,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (holders++ === 0) stop = start();
      return () => {
        listeners.delete(listener);
        if (--holders === 0) { stop?.(); stop = null; }
      };
    },
    /** Keep recording. Clears locally at once; main confirms with a cleared event. */
    async continueRecording(sessionId: string): Promise<void> {
      await bridge().continueSilence?.(sessionId);
      if (prompt?.sessionId === sessionId) set(null);
    },
  };
}

export const silencePrompts = createSilencePromptStore(() => api.recording as unknown as SilenceBridge);

const NOT_RECORDING = (): (() => void) => () => {};

/** The pending prompt for `sessionId`, or null. Listens to the main process
 *  only while there is a recording to ask about. */
export function useSilencePrompt(sessionId: string | null | undefined): SilencePrompt | null {
  const prompt = useSyncExternalStore(sessionId ? silencePrompts.subscribe : NOT_RECORDING, silencePrompts.get);
  return prompt && prompt.sessionId === sessionId ? prompt : null;
}

/** Whole seconds until `atMs`, re-rendering once a second; 0 once it has passed. */
export function useCountdownSeconds(atMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (atMs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [atMs]);
  return atMs === null ? 0 : Math.max(0, Math.ceil((atMs - now) / 1000));
}

/** "0:45" / "1:05" for a countdown. */
export function fmtCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
