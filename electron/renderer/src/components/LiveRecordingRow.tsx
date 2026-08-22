import { useEffect, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { VuMeter } from './VuMeter';
import { Icon } from './icons';
import { useElapsed, fmtElapsed } from '../lib/useElapsed';
import {
  captureSummary, deriveCaptureHealth, type CaptureLevelSource,
} from '../lib/capture-health';

/** How long the "Confirm stop" state stays armed before reverting to the
 *  plain Stop button. Long enough for a deliberate second click, short
 *  enough that an accidental first click can't lie in wait. */
const CONFIRM_STOP_MS = 3000;

export function LiveRecordingRow({
  sessionId, label, startedAt, onStopped, onRestarted,
}: {
  sessionId: string;
  label: string;
  startedAt: string;
  onStopped: (summary: string) => void;
  onRestarted: (recording: { sessionId: string; label: string; startedAt: string }) => void;
}): JSX.Element {
  const elapsed = useElapsed(startedAt, true);
  const [peaks, setPeaks] = useState<Record<CaptureLevelSource, number>>({ mic: -60, system: -60, mixed: -60 });
  const [lastAudibleAt, setLastAudibleAt] = useState<Partial<Record<CaptureLevelSource, number>>>({});
  const [nowMs, setNowMs] = useState(Date.now());
  const [stopping, setStopping] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seen = useRef(new Set<CaptureLevelSource>());

  const parsedStart = Date.parse(startedAt);
  const health = deriveCaptureHealth({
    startedAtMs: Number.isFinite(parsedStart) ? parsedStart : nowMs,
    nowMs,
    lastAudibleAt,
  });

  useEffect(() => {
    const off = api.recording.onLevel((e) => {
      if (e.sessionId !== sessionId) return;
      const source = e.source ?? 'mixed';
      setPeaks((current) => ({ ...current, [source]: e.peakDb }));
      if (e.peakDb > -50) {
        const at = Date.now();
        seen.current.add(source);
        setLastAudibleAt((current) => ({ ...current, [source]: at }));
      }
    });
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
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
      onStopped(captureSummary(seen.current));
    }
  }

  async function restartWithSystemAudio(): Promise<void> {
    if (!window.confirm('Stop this recording and restart using All system audio?')) return;
    setStopping(true);
    setRestartError(null);
    try {
      await api.recording.stop(sessionId);
      const next = await api.recording.start({ targetPid: 'system', targetLabel: 'All system audio', mic: true }) as { sessionId: string };
      onRestarted({ sessionId: next.sessionId, label: 'All system audio', startedAt: new Date().toISOString() });
    } catch (error) {
      setRestartError(`Could not restart capture: ${(error as Error).message}`);
    } finally {
      setStopping(false);
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
        <div className="hidden sm:flex items-center gap-3" aria-label="Capture source health">
          <StreamIndicator label="Mic" active={health.active.mic} checking={health.state === 'checking'} />
          <StreamIndicator label="App" active={health.active.system} checking={health.state === 'checking'} />
          <StreamIndicator label="File" active={health.active.mixed} checking={health.state === 'checking'} />
        </div>
        <VuMeter peakDb={peaks.mixed} />
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
      {health.state === 'checking' && !stopping && (
        <div className="mt-2 text-xs text-ink-muted px-3 py-1">Checking microphone, app audio, and recording file…</div>
      )}
      {health.state === 'warning' && !stopping && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-status-warnBg text-status-warnText text-xs font-medium px-3 py-1.5">
          <Icon name="alert-triangle" className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">{health.message}</span>
          {(health.warning === 'app-silent' || health.warning === 'all-silent') && (
            <button className="underline underline-offset-2" onClick={() => void restartWithSystemAudio()}>
              Restart with All system audio
            </button>
          )}
        </div>
      )}
      {restartError && <div className="mt-2 text-xs text-danger-solid">{restartError}</div>}
    </div>
  );
}

function StreamIndicator({ label, active, checking }: { label: string; active: boolean; checking: boolean }): JSX.Element {
  const dot = checking ? 'bg-gray-400 animate-pulse' : active ? 'bg-emerald-500' : 'bg-amber-500';
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />{label}
    </span>
  );
}
