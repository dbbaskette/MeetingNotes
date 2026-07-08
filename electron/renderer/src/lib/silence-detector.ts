// Pure "is this recording capturing anything?" detector for the live
// recording row. Fed the ~10Hz peak-held level events; reports silence only
// when the session is past its grace period AND no peak above the threshold
// has been seen for a full window. Time is injected (nowMs) so tests never
// sleep.

export interface SilenceDetectorOptions {
  /** Peaks at or below this dBFS count as silence. */
  thresholdDb: number;
  /** How long the signal must stay below threshold before we call it silent. */
  windowMs: number;
  /** Never report silence this early in the session — the user may still be
   *  unmuting / the target app may still be warming up. */
  graceMs: number;
}

export interface SilenceDetector {
  /** Record one level observation. The first feed anchors the session start. */
  feed(nowMs: number, peakDb: number): void;
  /** True when the session is past the grace period and nothing above the
   *  threshold has been heard for windowMs. */
  isSilent(nowMs: number): boolean;
}

export function createSilenceDetector(
  { thresholdDb, windowMs, graceMs }: SilenceDetectorOptions,
): SilenceDetector {
  let startMs: number | null = null;
  let lastLoudMs: number | null = null;

  return {
    feed(nowMs, peakDb) {
      if (startMs === null) startMs = nowMs;
      if (peakDb > thresholdDb) lastLoudMs = nowMs;
    },
    isSilent(nowMs) {
      if (startMs === null) return false; // nothing fed yet — can't judge
      if (nowMs - startMs < graceMs) return false;
      // With no loud peak ever heard, silence is measured from session start.
      const lastHeard = lastLoudMs ?? startMs;
      return nowMs - lastHeard >= windowMs;
    },
  };
}
