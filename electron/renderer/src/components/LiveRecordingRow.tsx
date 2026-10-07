import { useEffect, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { VuMeter } from './VuMeter';
import { Icon } from './icons';
import { ConfirmDialog } from './ConfirmDialog';
import { stopRecording } from '../lib/stop-recording';
import { useElapsed, fmtElapsed } from '../lib/useElapsed';
import {
  captureSummary, deriveCaptureHealth, type CaptureLevelSource,
} from '../lib/capture-health';

/** How long the "Confirm stop" state stays armed before reverting to the
 *  plain Stop button. Long enough for a deliberate second click, short
 *  enough that an accidental first click can't lie in wait. */
const CONFIRM_STOP_MS = 3000;

export function LiveRecordingRow({
  sessionId, label, startedAt, groupId, title, micEnabled = true, onStopped, onRestarted,
}: {
  sessionId: string;
  label: string;
  startedAt: string;
  groupId?: string | null;
  title?: string;
  micEnabled?: boolean;
  onStopped: (summary: string) => void;
  onRestarted: (recording: { sessionId: string; label: string; startedAt: string;
    startInput?: { targetPid: number | 'system'; targetLabel: string; mic: boolean; groupId?: string | null; title?: string } }) => void;
}): JSX.Element {
  const elapsed = useElapsed(startedAt, true);
  const [peaks, setPeaks] = useState<Record<CaptureLevelSource, number>>({ mic: -60, system: -60, mixed: -60 });
  const [received, setReceived] = useState<Partial<Record<CaptureLevelSource, boolean>>>({});
  const [lastAudibleAt, setLastAudibleAt] = useState<Partial<Record<CaptureLevelSource, number>>>({});
  const [nowMs, setNowMs] = useState(Date.now());
  const [stopping, setStopping] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const operation = useRef(false);
  const mounted = useRef(true);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seen = useRef(new Set<CaptureLevelSource>());

  const parsedStart = Date.parse(startedAt);
  const health = deriveCaptureHealth({
    startedAtMs: Number.isFinite(parsedStart) ? parsedStart : nowMs,
    nowMs,
    lastAudibleAt,
    micEnabled,
  });

  useEffect(() => {
    const off = api.recording.onLevel((e) => {
      if (e.sessionId !== sessionId) return;
      const source = e.source ?? 'mixed';
      if (!Number.isFinite(e.peakDb)) return;
      setReceived(current => current[source] ? current : { ...current, [source]: true });
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

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (confirmTimer.current) clearTimeout(confirmTimer.current); };
  }, []);

  async function stop(): Promise<void> {
    if (operation.current) return;
    operation.current = true;
    setStopping(true);
    setRestartError(null);
    try {
      const result = await stopRecording(sessionId, api.recording);
      if (!mounted.current) return;
      if (result.stopped) onStopped(result.message ?? `${captureSummary(seen.current)}. Check finalized audio in Library.`);
      else setRestartError(result.message);
    } finally {
      operation.current = false;
      if (mounted.current) setStopping(false);
    }
  }

  async function restartWithSystemAudio(): Promise<void> {
    if (operation.current) return;
    operation.current = true;
    setConfirmRestart(false);
    setStopping(true);
    setRestartError(null);
    try {
      const result = await stopRecording(sessionId, api.recording);
      if (!mounted.current) return;
      if (!result.stopped) { setRestartError(result.message); return; }
      const startInput = { targetPid: 'system' as const, targetLabel: 'All system audio', mic: true, groupId, title };
      const next = await api.recording.start(startInput) as { sessionId: string };
      if (mounted.current) onRestarted({ sessionId: next.sessionId, label: 'All system audio', startedAt: new Date().toISOString(), startInput });
    } catch (error) {
      if (mounted.current) onStopped(`Capture ended, but could not restart: ${(error as Error).message}. Start a new recording when ready.`);
    } finally {
      operation.current = false;
      if (mounted.current) setStopping(false);
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
          {micEnabled && <StreamIndicator label="Mic" active={health.active.mic} checking={health.state === 'checking'} />}
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
            <button className="underline underline-offset-2" onClick={() => setConfirmRestart(true)}>
              Restart with All system audio
            </button>
          )}
        </div>
      )}
      {restartError && <div role="alert" className="mt-2 text-xs text-danger-solid">{restartError}</div>}
      <details className="mt-2 text-xs text-ink-muted">
        <summary className="cursor-pointer">Stream diagnostics</summary>
        <div className="flex flex-wrap gap-4 tabular-nums mt-1" aria-live="off">
          {(['mic', 'system', 'mixed'] as const).map(source => <span key={source}>{source === 'system' ? 'App' : source === 'mixed' ? 'File' : 'Mic'} peak: {source === 'mic' && !micEnabled ? 'disabled' : received[source] ? `${peaks[source].toFixed(1)} dBFS` : 'waiting for samples'}</span>)}
        </div>
        <p className="mt-1">Live sample peaks, not a guarantee of playable saved audio. Check the finalized recording in Library.</p>
      </details>
      <ConfirmDialog open={confirmRestart} title="Restart capture with All system audio?"
        body="Stop the current capture first, then record all audible apps. Existing audio and the selected group are kept."
        confirmLabel="Stop and restart" onCancel={() => setConfirmRestart(false)} onConfirm={() => void restartWithSystemAudio()} />
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
