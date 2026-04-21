import { useEffect, useState } from 'react';

/** Re-renders the caller every `tickMs` (default 1s) and returns the number of
 *  seconds elapsed since `sinceIso`. Returns null if `sinceIso` is null/invalid.
 *  Stops ticking when `active` is false so finished meetings don't keep timers. */
export function useElapsed(sinceIso: string | null, active: boolean, tickMs = 1000): number | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active || !sinceIso) return;
    const t = setInterval(() => setTick((x) => x + 1), tickMs);
    return () => clearInterval(t);
  }, [active, sinceIso, tickMs]);
  if (!sinceIso) return null;
  const ms = Date.now() - Date.parse(sinceIso);
  if (Number.isNaN(ms) || ms < 0) return null;
  return Math.floor(ms / 1000);
}

export function fmtElapsed(s: number | null): string {
  if (s === null) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}m ${sec}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
