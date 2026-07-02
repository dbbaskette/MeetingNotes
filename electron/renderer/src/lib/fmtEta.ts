// electron/renderer/src/lib/fmtEta.ts
//
// Render helpers for the learned per-stage ETA. Kept out of the component so
// they're unit-tested without a DOM. Elapsed formatting stays in useElapsed;
// this module owns the estimate string + the "running long" overrun cue.

/** How far past the estimate a stage may run before we flag it as overrunning.
 *  1.5x gives real slack for normal variance while still surfacing a genuine
 *  hang well before the 10-minute request timeout fires. */
export const OVERRUN_FACTOR = 1.5;

/** "~45s" / "~3m" for a learned estimate in ms, or "estimating…" when we don't
 *  have a sample yet (etaMs === null). Rounded to a coarse figure so it reads as
 *  an estimate, not a stopwatch. When `rough` (derived from 1-2 samples), a
 *  " (rough)" suffix hedges it; `rough` is ignored when there's no estimate. */
export function fmtEta(etaMs: number | null, rough = false): string {
  if (etaMs === null) return 'estimating…';
  const seconds = etaMs / 1000;
  const figure = seconds < 60 ? `~${Math.round(seconds)}s` : `~${Math.round(seconds / 60)}m`;
  return rough ? `${figure} (rough)` : figure;
}

/** True when the current stage's elapsed time (seconds) has run past
 *  OVERRUN_FACTOR × the estimate — a cue that this may be a genuine hang.
 *  False when there's no estimate to compare against. */
export function isRunningLong(elapsedSeconds: number, etaMs: number | null): boolean {
  if (etaMs === null) return false;
  return elapsedSeconds * 1000 > etaMs * OVERRUN_FACTOR;
}
