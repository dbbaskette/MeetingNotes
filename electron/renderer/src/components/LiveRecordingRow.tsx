import { useEffect, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { VuMeter } from './VuMeter';
import { Icon, IconLabel } from './icons';
import { ConfirmDialog } from './ConfirmDialog';
import { stopRecording } from '../lib/stop-recording';
import { recordingStartFeedback } from '../lib/recording-start-feedback';
import { fmtElapsed } from '../lib/useElapsed';
import {
  captureSummary, deriveCaptureHealth, type CaptureLevelSource,
} from '../lib/capture-health';
import { liveCapture, useCapturePeaks, useCaptureSignals } from '../lib/live-capture';
import { fmtCountdown, silencePrompts, useCountdownSeconds, useSilencePrompt } from '../lib/silence-prompt';

/** How long the "Confirm stop" state stays armed before reverting to the
 *  plain Stop button. Long enough for a deliberate second click, short
 *  enough that an accidental first click can't lie in wait. */
const CONFIRM_STOP_MS = 3000;

// Live levels and "what have we heard" live in lib/live-capture, outside this
// component (#297, #301). The row mounts in the Library and, inside the
// compact pill, on every other view; holding that history here reset it on
// each view switch and raised a false "no audio" warning mid-call.
function LiveVuMeter(): JSX.Element {
  return <VuMeter peakDb={useCapturePeaks().mixed} />;
}

function PeakReadout({ source }: { source: CaptureLevelSource }): JSX.Element {
  return <>{useCapturePeaks()[source].toFixed(1)} dBFS</>;
}

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
  const { received, lastAudibleAt } = useCaptureSignals();
  const [nowMs, setNowMs] = useState(Date.now());
  const [stopping, setStopping] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const operation = useRef(false);
  const mounted = useRef(true);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silence = useSilencePrompt(sessionId);
  const silenceSeconds = useCountdownSeconds(silence?.autoStopAtMs ?? null);

  const parsedStart = Date.parse(startedAt);
  // One 1 s tick (`nowMs`) drives both the elapsed label and capture health.
  const elapsedMs = nowMs - parsedStart;
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.floor(elapsedMs / 1000) : null;
  // The store belongs to this session only once it has attached to it; until
  // then (first render after a new recording starts) show no history at all.
  const ours = liveCapture.sessionId() === sessionId;
  const health = deriveCaptureHealth({
    startedAtMs: Number.isFinite(parsedStart) ? parsedStart : nowMs,
    nowMs,
    lastAudibleAt: ours ? lastAudibleAt : {},
    received: ours ? received : {},
    micEnabled,
  });

  useEffect(() => {
    const release = liveCapture.attach(sessionId);
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => { release(); clearInterval(tick); };
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
      if (result.stopped) onStopped(result.message ?? `${captureSummary(liveCapture.seen())}. Check finalized audio in Library.`);
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
      // Keep the user's microphone choice: a recording started without the
      // mic must not gain it on restart (#297).
      const startInput = { targetPid: 'system' as const, targetLabel: 'All system audio', mic: micEnabled, groupId, title };
      const next = await api.recording.start(startInput) as { sessionId: string };
      if (mounted.current) onRestarted({ sessionId: next.sessionId, label: 'All system audio', startedAt: new Date().toISOString(), startInput });
    } catch (error) {
      const feedback = await recordingStartFeedback(error, api.recording);
      if (mounted.current) onStopped(`Capture ended. ${feedback.message}`);
    } finally {
      operation.current = false;
      if (mounted.current) setStopping(false);
    }
  }

  async function continueRecording(): Promise<void> {
    setContinuing(true); setRestartError(null);
    try { await silencePrompts.continueRecording(sessionId); }
    catch (error) { if (mounted.current) setRestartError(`Could not keep recording: ${(error as Error).message}`); }
    finally { if (mounted.current) setContinuing(false); }
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

  const offerRestart = health.warning === 'app-silent' || health.warning === 'all-silent' || health.warning === 'app-starved';
  return (
    <div className="rounded-xl border border-danger-border bg-danger-bg/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="w-2 h-2 rounded-full bg-danger-solid animate-pulse shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink truncate">Recording: {label}</div>
          <div className="text-xs text-ink-muted tabular-nums">{elapsed !== null ? fmtElapsed(elapsed) : '0s'}</div>
        </div>
        {/* Always visible: at narrow widths the labels drop and the dots stay. */}
        <div className="flex items-center gap-2 sm:gap-3" role="group" aria-label="Capture source health">
          {micEnabled && <StreamIndicator label="Mic" active={health.active.mic} checking={health.state === 'checking'} />}
          <StreamIndicator label="App" active={health.active.system} checking={health.state === 'checking'} />
          <StreamIndicator label="File" active={health.active.mixed} checking={health.state === 'checking'} />
        </div>
        <LiveVuMeter />
        <button
          onClick={handleStopClick}
          disabled={stopping}
          className={confirmingStop
            ? 'text-xs font-semibold bg-danger-solid text-white px-3 py-1.5 rounded-md ring-2 ring-danger-border ring-offset-1 animate-pulse disabled:opacity-40'
            : 'text-xs font-semibold bg-danger-solid text-white px-3 py-1.5 rounded-md hover:brightness-90 disabled:opacity-40'}
        >
          {stopping ? 'Stopping…' : confirmingStop ? 'Confirm stop' : <IconLabel icon="stop" iconClassName="w-3 h-3 shrink-0">Stop</IconLabel>}
        </button>
        {/* The armed state is only a colour and label change; say it. */}
        <span className="sr-only" role="status" aria-live="polite">
          {confirmingStop ? 'Stop is armed. Press Confirm stop within three seconds to stop recording.' : ''}
        </span>
      </div>
      {/* "All audio stopped" prompt (#305). Main owns the countdown; if it
          runs out the recording is stopped and saved automatically. */}
      {silence && !stopping && (
        <div role="status" aria-live="polite" className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-status-warnBg text-status-warnText text-xs font-medium px-3 py-2">
          <Icon name="alert-triangle" className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 min-w-[12rem]">
            All audio stopped — stopping in <span className="tabular-nums font-semibold">{fmtCountdown(silenceSeconds)}</span>. Your recording is saved either way.
          </span>
          <button type="button" className="btn-secondary" disabled={continuing} onClick={() => void continueRecording()}>
            {continuing ? 'Continuing…' : 'Continue recording'}
          </button>
          <button type="button" className="btn-danger px-2.5 py-1 text-xs" onClick={() => void stop()}>Stop now</button>
        </div>
      )}
      {health.state === 'checking' && !stopping && (
        <div className="mt-2 text-xs text-ink-muted px-3 py-1">Checking microphone, app audio, and recording file…</div>
      )}
      {health.state === 'warning' && !stopping && !silence && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-status-warnBg text-status-warnText text-xs font-medium px-3 py-1.5">
          <Icon name="alert-triangle" className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">{health.message}</span>
          {offerRestart && (
            <button className="underline underline-offset-2 shrink-0" onClick={() => setConfirmRestart(true)}>
              Restart with All system audio
            </button>
          )}
        </div>
      )}
      {restartError && <div role="alert" className="mt-2 text-xs text-danger-solid">{restartError}</div>}
      <details className="mt-2 text-xs text-ink-muted">
        <summary className="cursor-pointer">Stream diagnostics</summary>
        <div className="flex flex-wrap gap-4 tabular-nums mt-1" aria-live="off">
          {(['mic', 'system', 'mixed'] as const).map(source => <span key={source}>{source === 'system' ? 'App' : source === 'mixed' ? 'File' : 'Mic'} peak: {source === 'mic' && !micEnabled ? 'disabled' : ours && received[source] ? <PeakReadout source={source} /> : 'waiting for samples'}</span>)}
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
  // State is carried by shape and text as well as color: a filled dot is
  // audible, a hollow ring is silent, and the state is spoken and in the tooltip.
  const state = checking ? 'checking' : active ? 'audio detected' : 'no audio detected';
  const dot = checking ? 'bg-ink-muted animate-pulse' : active ? 'bg-status-ok' : 'border border-status-warnText';
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-ink-muted" title={`${label}: ${state}`}>
      <span aria-hidden="true" className={`w-2 h-2 rounded-full ${dot}`} />
      {/* One letter below sm so three indicators still fit a phone-width window. */}
      <span className="hidden sm:inline">{label}</span><span aria-hidden="true" className="sm:hidden">{label[0]}</span>
      <span className="sr-only sm:hidden">{label.slice(1)}</span><span className="sr-only">: {state}</span>
    </span>
  );
}
