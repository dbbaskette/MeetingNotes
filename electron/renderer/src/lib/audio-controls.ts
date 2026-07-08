// electron/renderer/src/lib/audio-controls.ts
//
// Pure helpers behind the detail view's audio control row (#A3):
// the speed-cycle button and the ±15s skip / arrow-key seeks. Kept
// DOM-free so they're unit-testable without a renderer harness.

/** The playback-rate cycle for the speed button, in click order. */
export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

/** Seconds jumped by the skip buttons / arrow keys. */
export const SKIP_SECONDS = 15;

/** Next rate in the 1× → 1.25× → 1.5× → 2× → 1× cycle. An unknown
 *  current rate (e.g. something set via devtools) resets to 1×. */
export function nextPlaybackRate(current: number): number {
  const i = (PLAYBACK_RATES as readonly number[]).indexOf(current);
  return PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length]!;
}

/** Compact label for the speed button — trailing zeros trimmed the way
 *  players usually render them: 1×, 1.25×, 1.5×, 2×. */
export function fmtPlaybackRate(rate: number): string {
  return `${rate}×`;
}

/** Seek target for a relative skip, clamped to [0, duration]. A missing
 *  or not-yet-known duration (NaN/Infinity/0 before loadedmetadata)
 *  only clamps the lower bound — the <audio> element itself refuses
 *  writes past the real end. */
export function guardedSeek(current: number, delta: number, duration: number): number {
  const next = current + delta;
  const max = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return Math.min(Math.max(0, next), max);
}
