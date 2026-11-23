// electron/renderer/src/views/meeting-detail/PipelineBanners.tsx
// Speaker-ID gate controls and the failure banner, moved out of
// MeetingDetailView.tsx (#256).
import { useEffect, useRef, useState } from 'react';
import { api } from '../../ipc/client';
import { IconLabel } from '../../components/icons';
import { isKnownReasoningModel } from '../../lib/reasoning-models';
import { REASONING_LOOP_MARKER } from '../../lib/reasoning-loop';
import { USER_STEPS, stepIndexFor } from '../../lib/pipeline-steps';
import { processingDiagnosis } from '../../../../shared/processing-recovery';
import { SpeakersPanel } from '../MeetingSpeakersPanel';
import type { MeetingDetail } from './types';

// Combined banner + toggle for the speaker-ID gate. Two modes:
//
// 1. Parked at the gate (status='awaiting_user'): amber banner with prominent
//    Continue button + summary of how many voices remain unidentified. The
//    skip checkbox becomes a "skip and continue" shortcut in this state.
//
// 2. Anywhere before the gate (status='processing' or 'pending' and stage is
//    at or before identifying): a quiet, always-visible row with just the
//    skip checkbox, so the user can set-and-forget while transcription runs.
//    Transcription takes long enough that the user has plenty of time to
//    make the call before the gate is reached.
//
// Past the gate (summarizing/extracting/done) or on a failed meeting: render
// nothing. The decision is already behind us.
// The speaker-ID UI has two modes that want different placements:
//   parked (awaiting_speaker_id) — critical gate, renders ABOVE the
//     StageTimeline so the user doesn't have to scan past pipeline chips
//     to find the action. That's the whole point of the gate.
//   pre-gate — quiet skip-toggle row, renders below the timeline where
//     it's available but doesn't shout.
// Kept as one component with a `placement` prop so each call site asks
// for its own half — returns null for the other mode.
export function SpeakerIdControls({
  meeting, onReload, placement,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
  placement: 'above-timeline' | 'below-timeline';
}): JSX.Element | null {
  const stage = meeting.pipelineStage;
  const parked = meeting.status === 'awaiting_user' && stage === 'awaiting_speaker_id';
  const preGate =
    stage === 'discovered' || stage === 'transcribing' || stage === 'diarizing' ||
    stage === 'merging' || stage === 'identifying';

  // Parked banner is the one moment in the pipeline that blocks on a human
  // decision. On a narrow viewport the banner can sit below the fold past
  // the back button and header — the user wonders why nothing's happening,
  // then scrolls and finds the CTA they were supposed to see immediately.
  // Centring it on first parked render keeps the gate from hiding.
  const bannerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (placement === 'above-timeline' && parked && bannerRef.current) {
      bannerRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [placement, parked]);

  if (placement === 'above-timeline' && !parked) return null;
  if (placement === 'below-timeline' && !preGate) return null;

  // Review metadata, once loaded, is the gate's own policy: a barely-heard
  // unnamed voice does not count as work for the user.
  const unidentified = meeting.speakers.filter((s) => s.needsReview ?? !s.rosterId).length;
  const totalSpeakers = meeting.speakers.length;

  async function setSkip(skip: boolean): Promise<void> {
    await api.meetings.setSkipSpeakerId(meeting.id, skip);
    await onReload();
  }
  async function continueNow(): Promise<void> {
    await api.meetings.continueFromSpeakerId(meeting.id);
    await onReload();
  }

  if (parked) {
    return (
      <div ref={bannerRef} className="px-5 py-4 border-b border-surface-border bg-status-warnBg">
        <div className="flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-status-warnText text-sm">
            Paused — name your speakers before summarize runs
          </div>
          <div className="text-xs text-status-warnText/80 mt-0.5">
            {totalSpeakers === 0
              ? 'No speakers detected yet.'
              : unidentified === 0
                ? `All ${totalSpeakers} voices identified. Click Continue to finish processing.`
                : `${unidentified} of ${totalSpeakers} voices need review. Name them below or open the full speaker panel. Existing audio and transcript are kept.`}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-status-warnText cursor-pointer select-none">
          <input
            type="checkbox"
            checked={meeting.skipSpeakerId}
            onChange={(e) => void setSkip(e.target.checked)}
            className="w-3.5 h-3.5 accent-status-warn"
          />
          Skip for this meeting
        </label>
        <button
          onClick={() => void continueNow()}
          className="text-sm font-semibold bg-status-warnSolid hover:brightness-90 text-white px-4 py-1.5 rounded-lg shadow-sm transition"
        >
          <IconLabel icon="arrow-right" className="flex-row-reverse">Continue</IconLabel>
        </button>
        </div>
        {unidentified > 0 && <div className="mt-3 max-w-xl"><SpeakersPanel meeting={meeting} onReload={onReload} compact /></div>}
      </div>
    );
  }

  // Pre-gate: quiet skip toggle only. No banner text, just a one-line row
  // so the user notices it exists without it feeling like a warning.
  return (
    <div className="px-5 py-2 border-b border-surface-border bg-surface-sunken/50 flex items-center justify-end gap-2 text-xs text-ink-muted">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={meeting.skipSpeakerId}
          onChange={(e) => void setSkip(e.target.checked)}
          className="w-3.5 h-3.5 accent-brand-indigo"
        />
        Skip speaker ID step — don&apos;t pause pipeline for this meeting
      </label>
    </div>
  );
}

// Shown only when status==='failed'. On failure the pipeline leaves the stage
// at a safe re-entry point (the failed stage itself for sequential stages, or
// a rollback to 'discovered' for the parallel transcribe/diarize block), so
// Retry re-runs from there via api.meetings.rerun — which clears stale
// artifacts before re-enqueuing; updateStatus clears the stored error so the
// banner disappears once the retry starts.
export function FailureBanner({
  meeting, onReload,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
}): JSX.Element | null {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  if (meeting.status !== 'failed') return null;

  const failedStep = USER_STEPS[stepIndexFor(meeting.pipelineStage)] ?? null;
  const diagnosis = processingDiagnosis(meeting.errorMessage);

  // Gate the inline recovery controls on the reasoning-runaway failure
  // signature so they only appear for the failure they actually fix, not
  // every unrelated error. Marker parity with the main-process client is
  // test-enforced (lib/reasoning-loop.test.ts).
  const isReasoningLoopFailure = (meeting.errorMessage ?? '').includes(REASONING_LOOP_MARKER);

  async function retry(): Promise<void> {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      // Retry from wherever the pipeline left us on failure, via the same
      // primitive the header's Processing menu uses.
      // meeting.pipelineStage is the failed stage for sequential stages, or
      // the rolled-back re-entry point ('discovered') for the parallel
      // transcribe/diarize block. Unlike api.meetings.start(), rerun() clears
      // any stale artifacts/action-items/speaker-links left behind by the
      // failed attempt before re-enqueuing.
      await api.meetings.rerun(meeting.id, meeting.pipelineStage);
      await onReload(); // bumps the poll loop; status flips to 'processing'
    } catch (error) { setRetryError((error as Error).message); }
    finally {
      setRetrying(false);
    }
  }

  return (
    <div className="px-5 py-4 border-b border-surface-border bg-danger-bg flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-danger-text text-sm">
          {diagnosis.title}{failedStep ? ` · ${failedStep}` : ''}
        </div>
        <p className="text-xs text-danger-text/90 mt-1">{diagnosis.action}</p>
        <p className="text-xs text-ink-muted mt-1">Retry replaces generated results from this step onward. Original audio is retained; existing notes and action items are saved in Notes history. Replaced transcripts are preserved as snapshots in the meeting folder. Dictionary corrections remain available.</p>
        <details className="mt-2 text-xs"><summary className="cursor-pointer">Technical details and retry history</summary>
        {meeting.errorMessage ? (
          <pre className="mt-1.5 text-xs text-danger-text/90 bg-danger-bg/60 border border-danger-border rounded-md px-2.5 py-1.5 max-h-28 overflow-auto whitespace-pre-wrap font-mono">
            {meeting.errorMessage}
          </pre>
        ) : (
          <div className="text-xs text-danger-text/80 mt-0.5">
            No error detail was recorded. Check the logs in Settings → Diagnostics.
          </div>
        )}
        {(meeting.processingHistory ?? []).map((entry, index) => <div key={index} className="mt-2 text-xs text-ink-muted break-words">{new Date(entry.createdAt).toLocaleString()} · {entry.kind} · {entry.stage}<pre className="whitespace-pre-wrap font-mono">{entry.message}</pre></div>)}
        </details>
        {retryError && <p role="alert" className="text-xs text-danger mt-2">Could not retry: {retryError}. Your previous results remain available.</p>}
        {isReasoningLoopFailure && <ReasoningRecoveryControls />}
      </div>
      <button
        onClick={() => void retry()}
        disabled={retrying}
        className="shrink-0 text-sm font-semibold bg-danger-solid hover:brightness-90 disabled:opacity-60 text-white px-4 py-1.5 rounded-lg shadow-sm transition"
      >
        {retrying ? 'Retrying…' : <IconLabel icon="rotate-cw" className="flex-row-reverse">Retry</IconLabel>}
      </button>
    </div>
  );
}

/** Lets the user fix a reasoning-model loop failure without leaving the
 *  meeting to visit Settings. Changing either field here updates the same
 *  global settings Settings would — this is a shortcut to that existing
 *  state, not a new per-run override concept — so the change also applies
 *  to future meetings until changed again. */
function ReasoningRecoveryControls(): JSX.Element {
  const [models, setModels] = useState<string[]>([]);
  const [llmModel, setLlmModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<'none' | 'minimal' | 'low' | 'default'>('none');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([api.models.list(), api.settings.getAll()]).then(([m, settings]) => {
      if (!alive) return;
      const modelList = m as string[];
      const current = settings as {
        llmModel: string;
        disableThinking: boolean;
        reasoningEffort?: 'none' | 'minimal' | 'low' | 'default';
      };
      setModels(modelList);
      setLlmModel(current.llmModel);
      setReasoningEffort(current.reasoningEffort ?? (current.disableThinking ? 'none' : 'default'));
      setLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  async function changeModel(next: string): Promise<void> {
    setLlmModel(next);
    await api.settings.set('llmModel', next);
  }

  async function changeReasoningEffort(next: 'none' | 'minimal' | 'low' | 'default'): Promise<void> {
    setReasoningEffort(next);
    await api.settings.set('reasoningEffort', next);
  }

  if (!loaded) {
    return <div className="text-xs text-danger-text/70 mt-2 italic">Loading recovery options…</div>;
  }

  return (
    <div className="mt-3 pt-3 border-t border-danger-border/60 space-y-2">
      <div className="text-xs font-semibold text-danger-text">
        This looks like a reasoning-model loop. Fix it here, then hit Retry:
      </div>
      <select
        aria-label="Summary LLM model"
        value={llmModel}
        onChange={(e) => void changeModel(e.target.value)}
        className="input text-xs"
      >
        <option value="">(choose)</option>
        {models.map((m) => (
          <option key={m} value={m}>{isKnownReasoningModel(m) ? `${m} (reasoning)` : m}</option>
        ))}
      </select>
      <label className="flex items-center gap-2 text-xs text-danger-text">
        <span>Reasoning effort</span>
        <select
          aria-label="Reasoning effort"
          value={reasoningEffort}
          onChange={(e) => void changeReasoningEffort(e.target.value as 'none' | 'minimal' | 'low' | 'default')}
          className="input text-xs flex-1"
        >
          <option value="none">Off (none)</option>
          <option value="minimal">Minimal</option>
          <option value="low">Low</option>
          <option value="default">Model default</option>
        </select>
      </label>
    </div>
  );
}
