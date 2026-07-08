import { useEffect, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { VuMeter } from './VuMeter';
import { useElapsed, fmtElapsed } from '../lib/useElapsed';
import { createSilenceDetector } from '../lib/silence-detector';

/** How long the "Confirm stop" state stays armed before reverting to the
 *  plain Stop button. Long enough for a deliberate second click, short
 *  enough that an accidental first click can't lie in wait. */
const CONFIRM_STOP_MS = 3000;

export function LiveRecordingRow({
  sessionId, label, startedAt, onStopped,
}: {
  sessionId: string;
  label: string;
  startedAt: string;
  onStopped: () => void;
}): JSX.Element {
  const elapsed = useElapsed(startedAt, true);
  const [peakDb, setPeakDb] = useState(-60);
  const [stopping, setStopping] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [silent, setSilent] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // No-audio watchdog: silent when nothing above -50 dBFS has been heard for
  // 20s (after a 5s startup grace). Anchored to the session's real start so
  // a remount doesn't restart the grace period.
  const detector = useRef(createSilenceDetector({ thresholdDb: -50, windowMs: 20_000, graceMs: 5_000 }));
  useEffect(() => {
    const startMs = Date.parse(startedAt);
    detector.current.feed(Number.isFinite(startMs) ? startMs : Date.now(), -Infinity);
  }, [startedAt]);

  useEffect(() => {
    const off = api.recording.onLevel((e) => {
      if (e.sessionId !== sessionId) return;
      setPeakDb(e.peakDb);
      detector.current.feed(Date.now(), e.peakDb);
      setSilent(detector.current.isSilent(Date.now()));
    });
    // Level events normally arrive ~10Hz, but if they stall entirely (helper
    // wedged) this 1s tick still lets the warning appear.
    const tick = setInterval(() => setSilent(detector.current.isSilent(Date.now())), 1000);
    return () => { off(); clearInterval(tick); };
  }, [sessionId]);

  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }, []);

  async function stop(): Promise<void> {
    setStopping(true);
    try {
      await api.recording.stop(sessionId);
    } finally {
      setStopping(false);
      onStopped();
    }
  }

  // Two-step stop: the first click arms a danger-styled "Confirm stop" that
  // auto-reverts after a few seconds; only a second click actually stops.
  function handleStopClick(): void {
    if (!confirmingStop) {
      setConfirmingStop(true);
      confirmTimer.current = setTimeout(() => setConfirmingStop(false), CONFIRM_STOP_MS);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmingStop(false);
    void stop();
  }

  return (
    <div className="rounded-xl border border-danger-border bg-danger-bg/40 px-4 py-3">
      <div className="flex items-center gap-4">
        <span className="w-2 h-2 rounded-full bg-danger-solid animate-pulse shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink truncate">Recording: {label}</div>
          <div className="text-xs text-ink-muted tabular-nums">{elapsed !== null ? fmtElapsed(elapsed) : '0s'}</div>
        </div>
        <VuMeter peakDb={peakDb} />
        <button
          onClick={handleStopClick}
          disabled={stopping}
          className={confirmingStop
            ? 'text-xs font-semibold bg-danger-solid text-white px-3 py-1.5 rounded-md ring-2 ring-danger-border ring-offset-1 animate-pulse disabled:opacity-40'
            : 'text-xs font-semibold bg-danger-solid text-white px-3 py-1.5 rounded-md hover:bg-danger-solid disabled:opacity-40'}
        >
          {stopping ? 'Stopping…' : confirmingStop ? 'Confirm stop' : '■ Stop'}
        </button>
      </div>
      {silent && !stopping && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-status-warnBg text-status-warnText text-xs font-medium px-3 py-1.5">
          <span aria-hidden>⚠︎</span>
          No audio detected — check the selected source.
        </div>
      )}
    </div>
  );
}
