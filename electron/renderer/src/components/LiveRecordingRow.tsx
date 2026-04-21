import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import { VuMeter } from './VuMeter';
import { useElapsed, fmtElapsed } from '../lib/useElapsed';

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

  useEffect(() => {
    const off = api.recording.onLevel((e) => {
      if (e.sessionId === sessionId) setPeakDb(e.peakDb);
    });
    return () => { off(); };
  }, [sessionId]);

  async function stop(): Promise<void> {
    setStopping(true);
    try {
      await api.recording.stop(sessionId);
    } finally {
      setStopping(false);
      onStopped();
    }
  }

  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50/40 px-4 py-3 flex items-center gap-4">
      <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-ink truncate">Recording: {label}</div>
        <div className="text-xs text-ink-muted tabular-nums">{elapsed !== null ? fmtElapsed(elapsed) : '0s'}</div>
      </div>
      <VuMeter peakDb={peakDb} />
      <button
        onClick={stop}
        disabled={stopping}
        className="text-xs font-semibold bg-rose-500 text-white px-3 py-1.5 rounded-md hover:bg-rose-600 disabled:opacity-40"
      >
        {stopping ? 'Stopping…' : '■ Stop'}
      </button>
    </div>
  );
}
