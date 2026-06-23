// electron/renderer/src/views/MeetingDetailView.tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../ipc/client';
import { useElapsed, fmtElapsed } from '../lib/useElapsed';
import { colorForSpeakerIndex } from '../theme/tokens';
import { MeetingRowMenu } from '../components/MeetingRowMenu';
import {
  parseTranscript, fmtTimestamp, groupConsecutiveBySpeaker,
  formatTranscriptForExport,
  type TranscriptLine, type TranscriptGroup, type ExportFormat,
} from '../lib/transcript-lines';
import { useToast } from '../components/Toasts';
import { shortcutMod } from '../lib/shortcut';
import { USER_STEPS, stepIndexFor } from '../lib/pipeline-steps';

// Audio is no longer a tab — it lives in a sticky footer below the
// center pane so playback stays alive while the user reads the summary
// or transcript. See #42. Actions tab exposes inline edit / add / delete
// for the action items that used to only surface in the export modal. #44
type Tab = 'summary' | 'transcript' | 'actions';

interface MeetingDetail {
  id: string;
  title: string;
  startedAt: string | null;
  durationS: number | null;
  pipelineStage: string;
  status: string;
  errorMessage: string | null;
  stageStartedAt: string | null;
  skipSpeakerId: boolean;
  transcriptMd: string | null;
  rawTranscriptText: string | null;
  summaryMd: string | null;
  audioPath: string;
  userIdentified: boolean;
  speakers: { localLabel: string; rosterId: string | null; displayName: string | null }[];
  actionItems: {
    id: string;
    text: string;
    ownerName: string | null;
    dueDate: string | null;
    status: string;
    exportedTo: string[];
    isMine: boolean;
  }[];
  models: { stt?: string; llm?: string };
}

// User-facing pipeline step model lives in lib/pipeline-steps so the
// LibraryRow chip and the StageTimeline below agree on counts and labels.

export function MeetingDetailView({
  id, onBack, seekSeconds, hint,
}: {
  id: string;
  onBack: () => void;
  /** When set (e.g. coming from the search palette), seek the audio to
   *  this time once it's loadable and switch to the Transcript tab so
   *  the matched line is visible. (#42 / #45) */
  seekSeconds?: number;
  /** Row hints captured at click-time so the loading skeleton can
   *  paint with real values (title, current pipeline stage) instead
   *  of "Loading…" placeholders. The full meetings:get IPC pulls
   *  hundreds of KB of transcript markdown for long meetings — the
   *  hint lets us paint the chrome immediately and only the body
   *  shows skeleton bars while the IPC resolves. */
  hint?: { title?: string; pipelineStage?: string; status?: string };
}): JSX.Element {
  const [m, setM] = useState<MeetingDetail | null>(null);
  const [tab, setTab] = useState<Tab>('summary');
  // Lifted audio state so the transcript's click-to-seek + current-line
  // highlight can reach the <audio> element in the sticky footer. The
  // ref survives tab switches; tab switches alone never unmount the
  // player. (#42)
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const seekTo = (seconds: number): void => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = seconds;
    if (el.paused) void el.play();
  };

  // Palette-driven jump (#45): when opened with `seekSeconds`, switch to
  // the transcript tab and seek the audio once it's ready. readyState >= 1
  // means metadata is loaded and `currentTime` writes will stick;
  // otherwise the seek silently drops.
  useEffect(() => {
    if (seekSeconds === undefined) return;
    setTab('transcript');
    const el = audioRef.current;
    if (!el) return;
    const apply = (): void => seekTo(seekSeconds);
    if (el.readyState >= 1) apply();
    else el.addEventListener('loadedmetadata', apply, { once: true });
  }, [seekSeconds]);

  // `kick` is a deliberate re-run trigger for the polling effect. Mutations
  // that change the meeting's live state (rerun, speaker assign) bump it so
  // the effect tears down its old timer and starts fresh — polling resumes
  // even after the meeting had already settled at 'done'.
  const [kick, setKick] = useState(0);
  const reload = async (): Promise<void> => {
    setKick((k) => k + 1);
  };

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function load(): Promise<void> {
      const d = (await api.meetings.get(id)) as MeetingDetail;
      if (!alive) return;
      setM(d);
      // Poll while anything is in flight. A rerun puts the meeting back into
      // 'processing', which re-enters this branch via the `kick` dependency.
      if (d.status === 'processing') {
        timer = setTimeout(load, 2000);
      }
    }
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, kick]);

  if (!m)
    return <DetailSkeleton hint={hint} onBack={onBack} />;

  return (
    // Detail card fills the available height inside App's flex column,
    // then internally splits into [pinned header] / [scrollable grid] /
    // [pinned audio]. Title bar, stage timeline, and parked-banner stay
    // on screen while the user reads a long summary or transcript.
    <div className="max-w-6xl mx-auto my-6 h-[calc(100%-3rem)] bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden flex flex-col">
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-surface-border">
        <button onClick={onBack} className="text-ink-muted hover:text-ink text-sm shrink-0">
          ← Library
        </button>
        {/* min-w-0 lets the truncate actually clip long titles instead of
            forcing the flex row to overflow — otherwise a long title would
            push the actions menu off the right edge. */}
        <div className="flex-1 min-w-0 text-center font-semibold truncate px-2">{m.title}</div>
        {/* Actions menu: rename/delete from the detail view. When the user
            deletes from here, route back to Library since the detail we're
            viewing no longer exists. */}
        <div className="relative w-[68px] flex justify-end shrink-0">
          <MeetingRowMenu
            meeting={{ id: m.id, title: m.title }}
            onChanged={() => void reload()}
            onDeleted={() => onBack()}
          />
        </div>
      </div>

      {/* Parked-at-gate banner renders ABOVE the timeline. The gate is the
          one moment in the pipeline where the UI is waiting for a human
          decision; hiding it below 8 pipeline chips hurt the time-to-
          action. Returns null when not parked. */}
      <div className="shrink-0">
        <SpeakerIdControls meeting={m} onReload={reload} placement="above-timeline" />
      </div>

      {/* Failure banner: when a run failed, surface WHY (the error string the
          pipeline caught, e.g. "whisper: not ready ...") with a one-click
          Retry — instead of leaving the user with a bare red X on the
          timeline and no explanation. Returns null when not failed. */}
      <div className="shrink-0">
        <FailureBanner meeting={m} onReload={reload} />
      </div>

      {/* The timeline is the canonical "where is this meeting in the pipeline"
          display. Always rendered — for never-processed meetings every stage
          is pending, while processing the current stage spins, after
          completion it's a persistent point-in-time record, and after a
          rerun kick the stages downstream of the rerun point flip back to
          pending so the progress is visible as it happens again. */}
      <div className="shrink-0">
        <StageTimeline meeting={m} />
      </div>

      {/* Quiet pre-gate skip-toggle row. Returns null when parked — the
          parked banner above already exposes the same control. */}
      <div className="shrink-0">
        <SpeakerIdControls meeting={m} onReload={reload} placement="below-timeline" />
      </div>

      {/* Responsive layout: stack single-column below lg (1024px) so the
          narrow rails don't clip center-pane content (transcript / audio
          player / summary). min-w-0 on each cell lets flex/grid children
          actually shrink — without it long lines of text force horizontal
          overflow and the whole detail view gets cut off on the right.
          On narrow, the CenterPane renders first (content first), then
          LeftRail and RightRail below, so users aren't scrolling past
          sidebar meta to reach the transcript. On lg+ the grid
          columns-order lands them back in their natural visual order.

          Scroll model:
            • lg+ (3 columns): each rail scrolls on its own — center
              pane can show a 50-page summary while the speakers/export
              rail stays visible.
            • Below lg (stacked): the grid itself scrolls as one column
              because per-section overflow would create awkward nested
              scrollbars on narrow widths. */}
      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_240px] flex-1 min-h-0 overflow-y-auto lg:overflow-hidden">
        <div className="order-1 lg:order-none min-w-0 lg:overflow-y-auto">
          <CenterPane
            meeting={m}
            tab={tab}
            onTab={setTab}
            currentTime={currentTime}
            onSeek={seekTo}
            onReload={reload}
          />
        </div>
        <div className="order-2 lg:order-first min-w-0 lg:overflow-y-auto"><LeftRail meeting={m} onReload={reload} /></div>
        <div className="order-3 min-w-0 lg:overflow-y-auto"><RightRail meeting={m} onReload={reload} /></div>
      </div>

      {/* Audio player pinned to the bottom of the card. Lives outside the
          CenterPane so it stays visible while the user reads the summary
          OR transcript — no more "switch tabs to play". Click-to-seek on
          transcript lines pipes through `seekTo` to this element. */}
      <div className="shrink-0 bg-surface-sunken border-t border-surface-border px-5 py-3">
        <audio
          ref={audioRef}
          controls
          src={`file://${m.audioPath}`}
          onTimeUpdate={(e) => setCurrentTime((e.target as HTMLAudioElement).currentTime)}
          className="w-full"
        />
      </div>
    </div>
  );
}

/** Layout-matching loading state. Paints the title bar, a static
 *  approximation of the StageTimeline (every chip in pending state),
 *  and skeleton bars in the center pane. Replaces the old double
 *  "Loading…" placeholder which felt like the app had frozen.
 *
 *  When a hint is provided (Library row click, search palette hit),
 *  we render the real title and — if pipelineStage is known —
 *  highlight the current stage chip so the user perceives this as
 *  "the page is here" not "we're starting from scratch." */
function DetailSkeleton({
  hint, onBack,
}: {
  hint?: { title?: string; pipelineStage?: string; status?: string };
  onBack: () => void;
}): JSX.Element {
  const stageIdx = hint?.pipelineStage ? stepIndexFor(hint.pipelineStage) : -1;
  const isFullyDone = hint?.pipelineStage === 'done';
  const showLiveStage = hint?.status === 'processing';
  return (
    <div className="max-w-6xl mx-auto my-6 bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden">
      {/* Title bar — uses real title when available */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-surface-border">
        <button onClick={onBack} className="text-ink-muted hover:text-ink text-sm shrink-0">
          ← Library
        </button>
        <div className="flex-1 min-w-0 text-center font-semibold truncate px-2">
          {hint?.title ?? (
            <span className="inline-block h-4 w-48 bg-stone-200/80 rounded animate-pulse align-middle" />
          )}
        </div>
        <div className="w-[68px]" />
      </div>

      {/* Stage timeline approximation */}
      <div className="flex items-center gap-1 px-5 py-3 border-b border-surface-border bg-surface-sunken overflow-x-auto">
        {USER_STEPS.map((step, i) => {
          const isDone = !isFullyDone && stageIdx > i;
          const isCurrent = !isFullyDone && stageIdx === i && showLiveStage;
          const isAllDone = isFullyDone;
          return (
            <div key={step} className="flex items-center gap-1 shrink-0">
              <div className={`
                flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold tabular-nums
                ${isAllDone || isDone ? 'bg-status-okBg/70 text-status-ok' : ''}
                ${isCurrent ? 'bg-brand-indigo text-white shadow-sm' : ''}
                ${!isCurrent && !isDone && !isAllDone ? 'bg-transparent text-ink-muted' : ''}
              `}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  isCurrent ? 'bg-white/70 animate-pulse'
                  : (isAllDone || isDone) ? 'bg-status-ok/40'
                  : 'bg-ink-muted/40'
                }`} />
                <span>{step}</span>
              </div>
              {i < USER_STEPS.length - 1 && (
                <div className={`w-3 h-px ${isAllDone || isDone ? 'bg-status-ok/40' : 'bg-surface-border'}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Three-column body — skeletons sized to match the real layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_240px] min-h-[560px]">
        {/* Left rail */}
        <div className="order-2 lg:order-first border-r border-surface-border p-4 space-y-4 animate-pulse">
          <div className="space-y-1.5">
            <div className="h-2 w-12 bg-stone-200/70 rounded" />
            <div className="h-4 w-32 bg-stone-200/80 rounded" />
          </div>
          <div className="space-y-1.5">
            <div className="h-2 w-10 bg-stone-200/70 rounded" />
            <div className="h-3 w-24 bg-stone-200/80 rounded" />
          </div>
          <div className="space-y-1.5">
            <div className="h-2 w-14 bg-stone-200/70 rounded" />
            <div className="h-3 w-28 bg-stone-200/80 rounded" />
            <div className="h-3 w-20 bg-stone-200/80 rounded" />
          </div>
        </div>
        {/* Center pane */}
        <div className="order-1 lg:order-none p-6">
          <div className="flex gap-4 mb-6">
            <div className="h-3 w-16 bg-stone-200/70 rounded animate-pulse" />
            <div className="h-3 w-16 bg-stone-200/70 rounded animate-pulse" />
            <div className="h-3 w-16 bg-stone-200/70 rounded animate-pulse" />
          </div>
          <div className="space-y-2.5 animate-pulse">
            <div className="h-3 bg-stone-200/80 rounded w-[96%]" />
            <div className="h-3 bg-stone-200/80 rounded w-[90%]" />
            <div className="h-3 bg-stone-200/80 rounded w-[94%]" />
            <div className="h-3 bg-stone-200/80 rounded w-[40%] mb-3" />
            <div className="h-3 bg-stone-200/80 rounded w-[88%]" />
            <div className="h-3 bg-stone-200/80 rounded w-[92%]" />
            <div className="h-3 bg-stone-200/80 rounded w-[55%]" />
          </div>
        </div>
        {/* Right rail */}
        <div className="order-3 border-l border-surface-border p-4 space-y-3 animate-pulse">
          <div className="h-2 w-16 bg-stone-200/70 rounded" />
          <div className="h-9 w-full bg-stone-200/60 rounded-lg" />
          <div className="h-9 w-full bg-stone-200/60 rounded-lg" />
          <div className="h-9 w-full bg-stone-200/60 rounded-lg" />
        </div>
      </div>

      {/* Audio player placeholder */}
      <div className="sticky bottom-0 bg-surface-sunken border-t border-surface-border px-5 py-4">
        <div className="h-8 bg-stone-200/60 rounded-md animate-pulse" />
      </div>
    </div>
  );
}

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
function SpeakerIdControls({
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

  const unidentified = meeting.speakers.filter((s) => !s.rosterId).length;
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
      <div ref={bannerRef} className="px-5 py-4 border-b border-surface-border bg-status-warnBg flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-status-warnText text-sm">
            Paused — name your speakers before summarize runs
          </div>
          <div className="text-xs text-status-warnText/80 mt-0.5">
            {totalSpeakers === 0
              ? 'No speakers detected yet.'
              : unidentified === 0
                ? `All ${totalSpeakers} voices identified. Click Continue to finish processing.`
                : `${unidentified} of ${totalSpeakers} voices still unidentified. Use the Speakers panel on the right to label them, then Continue.`}
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
          className="text-sm font-semibold bg-status-warn hover:opacity-90 text-white px-4 py-1.5 rounded-lg shadow-sm transition"
        >
          Continue →
        </button>
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

// Shown only when status==='failed'. The pipeline rolls the stage back to a
// safe re-entry point on failure, so Retry === re-enqueue from there (the
// same api.meetings.start path the Process button uses); updateStatus clears
// the stored error so the banner disappears once the retry starts.
function FailureBanner({
  meeting, onReload,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
}): JSX.Element | null {
  const [retrying, setRetrying] = useState(false);
  if (meeting.status !== 'failed') return null;

  const failedStep = USER_STEPS[stepIndexFor(meeting.pipelineStage)] ?? null;

  async function retry(): Promise<void> {
    if (retrying) return;
    setRetrying(true);
    try {
      await api.meetings.start(meeting.id);
      await onReload(); // bumps the poll loop; status flips to 'processing'
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="px-5 py-4 border-b border-surface-border bg-rose-50 flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-rose-800 text-sm">
          Processing failed{failedStep ? ` during ${failedStep}` : ''}
        </div>
        {meeting.errorMessage ? (
          <pre className="mt-1.5 text-xs text-rose-700/90 bg-rose-100/60 border border-rose-200 rounded-md px-2.5 py-1.5 max-h-28 overflow-auto whitespace-pre-wrap font-mono">
            {meeting.errorMessage}
          </pre>
        ) : (
          <div className="text-xs text-rose-700/80 mt-0.5">
            No error detail was recorded. Check the logs in Settings → Diagnostics.
          </div>
        )}
      </div>
      <button
        onClick={() => void retry()}
        disabled={retrying}
        className="shrink-0 text-sm font-semibold bg-rose-600 hover:bg-rose-700 disabled:opacity-60 text-white px-4 py-1.5 rounded-lg shadow-sm transition"
      >
        {retrying ? 'Retrying…' : 'Retry ↻'}
      </button>
    </div>
  );
}

function StageTimeline({ meeting }: { meeting: MeetingDetail }): JSX.Element {
  // Three visual states per step: done (check), current (spinner or X), pending.
  // - pipelineStage='done' => every step is done (full row of checkmarks,
  //   so you can see "yes, it ran the whole pipeline").
  // - status='processing'  => steps before currentIdx are done, currentIdx is
  //   the live spinner with elapsed time, rest are pending.
  // - status='failed'      => steps before currentIdx are done, currentIdx is
  //   a red X (this is where it died), rest are pending.
  // The user-facing step model is shared with LibraryRow so the row's
  // "PROCESSING N/<total>" matches the position highlighted here.
  const isFullyDone = meeting.pipelineStage === 'done';
  const rawIdx = stepIndexFor(meeting.pipelineStage);
  const currentIdx = isFullyDone ? USER_STEPS.length : rawIdx;
  const elapsed = useElapsed(meeting.stageStartedAt, meeting.status === 'processing');
  const isFailed = meeting.status === 'failed';
  const isProcessing = meeting.status === 'processing';
  const isAwaiting = meeting.status === 'awaiting_user';

  return (
    <div className="flex items-center gap-1 px-5 py-3 border-b border-surface-border bg-surface-sunken overflow-x-auto">
      {USER_STEPS.map((step, i) => {
        const isDone = currentIdx > i;
        const isCurrent = !isFullyDone && currentIdx === i;
        const isPending = currentIdx < i;
        const isFailedHere = isCurrent && isFailed;
        const isAwaitingHere = isCurrent && isAwaiting;
        return (
          <div key={step} className="flex items-center gap-1 shrink-0">
            <div
              className={`
                flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold tabular-nums
                ${isDone ? 'bg-status-okBg/70 text-status-ok' : ''}
                ${isCurrent && isProcessing ? 'bg-brand-indigo text-white shadow-sm' : ''}
                ${isFailedHere ? 'bg-rose-100 text-rose-700' : ''}
                ${isAwaitingHere ? 'bg-amber-200 text-amber-900 shadow-sm' : ''}
                ${isPending ? 'bg-transparent text-ink-muted' : ''}
              `}
            >
              {isDone && <CheckMark />}
              {isCurrent && isProcessing && <MiniSpinner />}
              {isFailedHere && <XMark />}
              {isAwaitingHere && <PauseMark />}
              {isPending && <EmptyDot />}
              <span>{step}</span>
              {isCurrent && isProcessing && elapsed !== null && (
                <span className="font-normal opacity-80">{fmtElapsed(elapsed)}</span>
              )}
              {/* No "waiting" word — the pause icon + amber color already say it.
                  Adding the word made the chip wrap to two lines on narrow widths. */}
            </div>
            {i < USER_STEPS.length - 1 && (
              <div className={`w-3 h-px ${isDone ? 'bg-status-ok/40' : 'bg-surface-border'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Timeline icons are deliberately at 14px (w-3.5 h-3.5) with thick
// strokes — 12px was glanceable for sighted users but too small to do
// the work of conveying state on its own for users who can't read the
// chip's color (red/green color-blindness, sun glare, etc.). At 14px
// the icon shape (✓ / ✕ / ⏸ / spinner) is identifiable at a meter's
// distance from the screen, regardless of color.
function XMark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function CheckMark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8l3.5 3.5L13 5" />
    </svg>
  );
}

function MiniSpinner(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
      <path d="M8 2a6 6 0 1 1-6 6" opacity="0.9" />
    </svg>
  );
}

function EmptyDot(): JSX.Element {
  return <span className="w-1.5 h-1.5 rounded-full bg-ink-muted/40" />;
}

function PauseMark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="currentColor">
      <rect x="4" y="3" width="2.5" height="10" rx="0.5" />
      <rect x="9.5" y="3" width="2.5" height="10" rx="0.5" />
    </svg>
  );
}

function LeftRail({
  meeting, onReload,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
}): JSX.Element {
  async function startProcessing(): Promise<void> {
    await api.meetings.start(meeting.id);
    await onReload();
  }
  async function rerunFrom(stage: string): Promise<void> {
    await api.meetings.rerun(meeting.id, stage);
    await onReload();
  }

  // "Never been processed" = still sitting in the Inbox. The appropriate
  // control here is Process, not Re-run. Re-run only makes sense once there's
  // something to re-do (i.e. the pipeline has at least started).
  const neverProcessed =
    meeting.pipelineStage === 'discovered' && meeting.status === 'pending';
  const isProcessing = meeting.status === 'processing';

  // Field labels in the left rail (`Title`, `Date`, `Models`) use a
  // quieter sans-serif treatment than the tracked-monospace section
  // headers (`SPEAKERS`, `EXPORT`, `RE-RUN PIPELINE FROM…`). Earlier
  // both used the same treatment, which collapsed the hierarchy and
  // made every label fight for attention. Now: tracked-mono for
  // section headers, plain small caps for fields.
  return (
    <div className="border-r border-surface-border p-4 space-y-3">
      <div>
        <div className="text-[11px] text-ink-muted font-medium">Title</div>
        <div className="font-semibold">{meeting.title}</div>
      </div>
      <div>
        <div className="text-[11px] text-ink-muted font-medium">Date</div>
        <div className="text-sm">{meeting.startedAt?.slice(0, 10) ?? '—'}</div>
      </div>
      <div>
        <div className="text-[11px] text-ink-muted font-medium">Models</div>
        {meeting.models.stt && <div className="text-xs">STT: {meeting.models.stt}</div>}
        {meeting.models.llm && <div className="text-xs">LLM: {meeting.models.llm}</div>}
      </div>
      <div className="pt-3 border-t border-surface-border">
        {neverProcessed ? (
          <button
            onClick={startProcessing}
            className="w-full bg-brand-indigo text-white text-sm font-semibold rounded-lg py-2 hover:bg-brand-indigo/90 transition"
          >
            ▶ Process recording
          </button>
        ) : isProcessing ? (
          <div className="text-xs text-ink-muted italic px-1">
            Processing in progress — re-run options will be available once it
            finishes or fails.
          </div>
        ) : (
          <div className="space-y-2">
            <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold mb-1">Re-run pipeline from…</div>
            {([
              ['transcribing', 'transcribe + everything after'],
              ['diarizing', 'diarize + everything after'],
              ['summarizing', 'just summary + actions'],
            ] as const).map(([stage, label]) => (
              <button
                key={stage}
                onClick={() => rerunFrom(stage)}
                className="group w-full text-left bg-surface border-l-2 border-l-brand-indigo/40 border border-surface-border rounded-lg py-2 px-3 text-[13px] text-ink-soft transition-all duration-150 hover:border-l-brand-indigo hover:bg-brand-indigo/5 hover:text-brand-indigo hover:shadow-sm"
                title={label}
              >
                <span className="inline-block transition-transform duration-200 group-hover:rotate-[-45deg] mr-1.5">↻</span>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CenterPane({
  meeting, tab, onTab, currentTime, onSeek, onReload,
}: {
  meeting: MeetingDetail;
  tab: Tab;
  onTab: (t: Tab) => void;
  currentTime: number;
  onSeek: (seconds: number) => void;
  onReload: () => Promise<void>;
}): JSX.Element {
  const showRaw = meeting.transcriptMd === null && meeting.rawTranscriptText !== null;
  return (
    <div>
      {/* Tab labels share the ALL-CAPS tracked treatment used by the
          Library/Inbox section headings, so section-level typography is
          consistent across views. Audio is now a sticky footer, not a
          tab — keeps playback alive while reading either tab.
          Sticky-pinned to the top of the center-pane scroll container
          so SUMMARY/TRANSCRIPT/ACTIONS stay reachable while paging
          through a long summary or transcript. */}
      <div className="sticky top-0 z-10 bg-surface flex border-b border-surface-border px-4">
        {(['summary', 'transcript', 'actions'] as const).map((t) => (
          <button
            key={t}
            onClick={() => onTab(t)}
            className={`px-3 py-3 font-mono text-[11px] tracking-[0.2em] uppercase transition
              ${tab === t
                ? 'text-brand-indigo border-b-2 border-brand-indigo font-semibold -mb-px'
                : 'text-ink-muted hover:text-ink'}`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="p-5">
        {tab === 'summary' && <SummaryPanel meeting={meeting} onReload={onReload} />}
        {tab === 'transcript' && (
          <TranscriptPanel
            meeting={meeting}
            showRaw={showRaw}
            currentTime={currentTime}
            onSeek={onSeek}
          />
        )}
        {tab === 'actions' && <ActionItemsPanel meeting={meeting} onReload={onReload} />}
      </div>
    </div>
  );
}

// Click-to-seek transcript (#42). Each parsed line becomes a button that
// calls onSeek. A timeupdate-driven currentTime highlights the line
// covering that second. Falls back to plain-text rendering for raw
// pre-merge transcripts (no speaker prefixes to parse).
//
// Two view modes (toggle in the header):
//   - Per-line: every timestamped row gets its own clickable line.
//     Closest to the on-disk transcript.md, finest-grained seek.
//   - Grouped: consecutive same-speaker lines are collapsed into one
//     paragraph, so a 30-line monologue reads as a paragraph instead
//     of 30 timestamped fragments. Click anywhere in a group to seek
//     to its start.
//
// The user's choice is persisted to localStorage so it survives view
// navigation; defaults to per-line for backward compatibility with
// users who already know that layout.
type TranscriptViewMode = 'lines' | 'grouped';
const VIEW_MODE_KEY = 'mn:transcript-view-mode';

function readStoredViewMode(): TranscriptViewMode {
  if (typeof localStorage === 'undefined') return 'lines';
  const v = localStorage.getItem(VIEW_MODE_KEY);
  return v === 'grouped' ? 'grouped' : 'lines';
}

function TranscriptPanel({
  meeting, showRaw, currentTime, onSeek,
}: {
  meeting: MeetingDetail;
  showRaw: boolean;
  currentTime: number;
  onSeek: (seconds: number) => void;
}): JSX.Element {
  const body = meeting.transcriptMd ?? meeting.rawTranscriptText ?? '';
  const parsed = useMemo(() => parseTranscript(body), [body]);
  const groups = useMemo(
    () => groupConsecutiveBySpeaker(parsed.lines),
    [parsed.lines],
  );
  const [viewMode, setViewMode] = useState<TranscriptViewMode>(readStoredViewMode);
  useEffect(() => {
    try { localStorage.setItem(VIEW_MODE_KEY, viewMode); } catch { /* private mode */ }
  }, [viewMode]);

  // Active line = the one whose [start, nextStart) window covers currentTime.
  const activeIdx = useMemo(() => {
    if (parsed.lines.length === 0) return -1;
    let lo = 0, hi = parsed.lines.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (parsed.lines[mid]!.seconds <= currentTime) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }, [parsed, currentTime]);

  // Active group = the group whose lineIndices range contains activeIdx.
  // Stored as a number for the same scrollIntoView trigger; -1 means none.
  const activeGroupIdx = useMemo(() => {
    if (activeIdx < 0) return -1;
    return groups.findIndex(
      (g) => activeIdx >= g.lineIndices[0]! && activeIdx <= g.lineIndices[g.lineIndices.length - 1]!,
    );
  }, [groups, activeIdx]);

  // Auto-scroll the active line into view — but only when the user hasn't
  // scrolled manually in the last few seconds (don't fight them). A
  // "lastUserScrollAt" timestamp bumps on any wheel/touch event inside the
  // scroll container.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const lastManualScrollAt = useRef(0);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const onScroll = (): void => { lastManualScrollAt.current = Date.now(); };
    el.addEventListener('wheel', onScroll, { passive: true });
    el.addEventListener('touchmove', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onScroll);
      el.removeEventListener('touchmove', onScroll);
    };
  }, []);
  useEffect(() => {
    if (Date.now() - lastManualScrollAt.current < 3000) return;
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx, activeGroupIdx, viewMode]);

  if (body === '') {
    return (
      <div className="text-sm text-ink-muted italic">
        No transcript yet. Waiting for the transcribe stage to finish.
      </div>
    );
  }
  if (parsed.hasUnparsed || parsed.lines.length === 0) {
    // Raw / partial transcript — just render as prose.
    return (
      <>
        {showRaw && (
          <div className="mb-3 text-xs text-status-warnText bg-status-warnBg border border-status-warn/40 rounded-lg px-3 py-2">
            Early preview — raw whisper output. Speaker labels and timestamps
            will be filled in once diarization + merge finish.
          </div>
        )}
        <div className="text-sm leading-relaxed whitespace-pre-wrap font-sans">
          {body}
        </div>
      </>
    );
  }

  return (
    <div className="space-y-2">
      {/* View toggle + export. Right-aligned so they sit in the
          existing tab-row's empty space without forcing the transcript
          text down. The view toggle's two buttons share a pill so the
          active state is unambiguous; export is a separate group with
          a menu for the format choice. */}
      <div className="flex items-center justify-end gap-2 -mt-2 mb-1">
        <div className="inline-flex items-center text-[11px] font-semibold rounded-full border border-surface-border bg-surface overflow-hidden">
          <ViewToggleButton
            active={viewMode === 'lines'}
            onClick={() => setViewMode('lines')}
            label="Per line"
            title="Show every timestamped line as its own row"
          />
          <ViewToggleButton
            active={viewMode === 'grouped'}
            onClick={() => setViewMode('grouped')}
            label="Grouped"
            title="Collapse consecutive same-speaker lines into one paragraph"
          />
        </div>
        <ExportTranscriptButton
          lines={parsed.lines}
          viewMode={viewMode}
          meeting={meeting}
        />
      </div>

      {/* Scrolling is delegated to the parent rail now that the detail
          view caps its own height — a nested scroll container here would
          give the user two scrollbars to fight. The wheel/touchmove
          listeners below still fire on this element regardless of who
          actually scrolls, so "don't fight manual scroll" keeps working. */}
      <div ref={panelRef} className="text-sm leading-relaxed font-sans pr-1">
        {viewMode === 'lines' ? (
          parsed.lines.map((line, i) => {
            const active = i === activeIdx;
            return (
              <button
                key={i}
                ref={active ? activeRef : undefined}
                onClick={() => onSeek(line.seconds)}
                title={`Jump to ${fmtTimestamp(line.seconds)}`}
                className={`w-full text-left rounded-md px-2 py-1 mb-0.5 transition-colors
                  ${active
                    ? 'bg-brand-indigo/10 ring-1 ring-brand-indigo/30'
                    : 'hover:bg-surface-sunken'}`}
              >
                <TranscriptLineRow line={line} />
              </button>
            );
          })
        ) : (
          groups.map((g, i) => {
            const active = i === activeGroupIdx;
            return (
              <button
                key={i}
                ref={active ? activeRef : undefined}
                onClick={() => onSeek(g.startSeconds)}
                title={`Jump to ${fmtTimestamp(g.startSeconds)}`}
                className={`w-full text-left rounded-md px-3 py-2 mb-2 transition-colors
                  ${active
                    ? 'bg-brand-indigo/10 ring-1 ring-brand-indigo/30'
                    : 'hover:bg-surface-sunken'}`}
              >
                <TranscriptGroupRow group={g} />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function ViewToggleButton({
  active, onClick, label, title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`px-2.5 py-1 transition-colors ${
        active ? 'bg-ink text-surface' : 'text-ink-muted hover:text-ink hover:bg-surface-sunken'
      }`}
    >
      {label}
    </button>
  );
}

/** Export-as menu next to the view toggle. Click → small popover with
 *  "Markdown (.md)" / "Plain text (.txt)" choices. The chosen format
 *  uses formatTranscriptForExport() with the active view mode, then
 *  hands the string off to the transcript:export IPC which shows the
 *  native save dialog and writes the file. */
function ExportTranscriptButton({
  lines, viewMode, meeting,
}: {
  lines: readonly TranscriptLine[];
  viewMode: 'lines' | 'grouped';
  meeting: { title: string; startedAt: string | null };
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

  // Click-outside to dismiss. Mounted only while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  // Slug-from-title helper — for the default save filename. Falls back
  // to the literal "transcript" when the title is empty/all-symbols.
  function defaultName(format: ExportFormat): string {
    const slug = (meeting.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'transcript';
    const suffix = viewMode === 'grouped' ? '-grouped' : '';
    return `${slug}${suffix}.transcript.${format}`;
    // Note: `.transcript.<ext>` keeps the filename distinct from the
    // summary export the user might do later.
  }

  async function exportAs(format: ExportFormat): Promise<void> {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    try {
      const content = formatTranscriptForExport(lines, {
        title: meeting.title,
        startedAt: meeting.startedAt,
        viewMode,
        format,
      });
      const result = await api.meetings.exportTranscript({
        content,
        defaultName: defaultName(format).replace(/\.(md|txt)$/, ''),
        format,
      });
      if (result.path) {
        toast.show({ message: `Exported to ${result.path}`, durationMs: 4000 });
      } else {
        // Cancelled — fall back to clipboard so the keystrokes
        // weren't wasted. Same pattern the WeeklyView export uses.
        await navigator.clipboard.writeText(content);
        toast.show({
          message: `Save cancelled — transcript copied to clipboard instead`,
          durationMs: 3500,
        });
      }
    } catch (e) {
      toast.show({
        message: `Export failed: ${(e as Error).message}`,
        durationMs: 5000,
      });
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || lines.length === 0;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Export transcript"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[11px] font-semibold rounded-full border border-surface-border bg-surface px-2.5 py-1
                   text-ink-muted hover:text-ink hover:border-ink/30
                   disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <span>Export</span>
        <svg viewBox="0 0 24 24" className="w-2.5 h-2.5 opacity-70" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 min-w-[200px] bg-surface rounded-lg border border-surface-border shadow-pop overflow-hidden text-sm"
        >
          <ExportMenuItem
            label="Markdown (.md)"
            sublabel="Bold names, blockquoted text"
            onClick={() => void exportAs('md')}
          />
          <ExportMenuItem
            label="Plain text (.txt)"
            sublabel="No formatting, sharable anywhere"
            onClick={() => void exportAs('txt')}
          />
        </div>
      )}
    </div>
  );
}

function ExportMenuItem({
  label, sublabel, onClick,
}: {
  label: string;
  sublabel: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onClick}
      className="w-full text-left px-3 py-2 hover:bg-surface-sunken transition"
    >
      <div className="font-medium text-ink">{label}</div>
      <div className="text-[11px] text-ink-muted">{sublabel}</div>
    </button>
  );
}

function TranscriptLineRow({ line }: { line: TranscriptLine }): JSX.Element {
  return (
    <>
      <span className="font-mono text-[11px] text-ink-muted tabular-nums mr-2">
        {fmtTimestamp(line.seconds)}
      </span>
      <span className="font-semibold text-ink-muted mr-2">{line.speaker}</span>
      <span>{line.text}</span>
    </>
  );
}

/** Grouped-view row: speaker name on its own line above the merged
 *  paragraph, with the start–end range to its right. Cleaner than
 *  inlining everything when the merged text is long. */
function TranscriptGroupRow({ group }: { group: TranscriptGroup }): JSX.Element {
  const showRange = group.endSeconds > group.startSeconds;
  return (
    <>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="font-semibold text-ink">{group.speaker}</span>
        <span className="font-mono text-[11px] text-ink-muted tabular-nums">
          {fmtTimestamp(group.startSeconds)}
          {showRange && (
            <>
              {' '}
              <span className="opacity-60">–</span>
              {' '}
              {fmtTimestamp(group.endSeconds)}
            </>
          )}
        </span>
      </div>
      <div className="text-ink-soft">{group.text}</div>
    </>
  );
}

// Inline-editable list of action items (#44). Click a row → expands to
// text / owner / due-date inputs. Add-item row at the bottom. Delete is
// hard-delete (no undo — users can retype if they change their mind).
function ActionItemsPanel({
  meeting, onReload,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const items = meeting.actionItems;

  return (
    <div>
      <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold mb-3 flex items-center gap-2">
        <span>Action items</span>
        <span className="font-normal opacity-70">
          {items.length > 0 ? `· ${items.length}` : ''}
        </span>
      </div>
      {items.length === 0 && !adding && (
        <div className="text-sm text-ink-muted italic mb-3">
          No action items yet. Run Summarize + Extract to get some, or click
          &ldquo;Add item&rdquo; below to write one by hand.
        </div>
      )}
      <div className="space-y-2">
        {items.map((it) => (
          editing === it.id ? (
            <ActionItemEditor
              key={it.id}
              initial={it}
              onCancel={() => setEditing(null)}
              onSaved={async () => { setEditing(null); await onReload(); }}
              onDeleted={async () => { setEditing(null); await onReload(); }}
            />
          ) : (
            <ActionItemDisplay
              key={it.id}
              item={it}
              onOpen={() => setEditing(it.id)}
            />
          )
        ))}
        {adding && (
          <ActionItemEditor
            key="__new__"
            meetingId={meeting.id}
            onCancel={() => setAdding(false)}
            onSaved={async () => { setAdding(false); await onReload(); }}
          />
        )}
      </div>
      {!adding && (
        <button
          onClick={() => setAdding(true)}
          className="mt-3 text-xs font-semibold text-brand-indigo hover:underline"
        >
          + Add item
        </button>
      )}
    </div>
  );
}

function ActionItemDisplay({
  item, onOpen,
}: {
  item: MeetingDetail['actionItems'][number];
  onOpen: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onOpen}
      className="w-full text-left rounded-lg border border-surface-border bg-surface
                 hover:border-brand-indigo/60 hover:shadow-pop px-3 py-2 transition"
    >
      <div className="text-sm text-ink">{item.text}</div>
      <div className="text-xs text-ink-muted mt-1 flex items-center gap-3">
        {item.ownerName && <span>👤 {item.ownerName}</span>}
        {item.dueDate && <span>📅 {item.dueDate}</span>}
        {item.status === 'done' && (
          <span className="bg-status-okBg text-status-ok font-semibold px-1.5 rounded">DONE</span>
        )}
        {item.exportedTo.length > 0 && (
          <span className="text-ink-muted/70">
            exported to {item.exportedTo.join(', ')}
          </span>
        )}
      </div>
    </button>
  );
}

function ActionItemEditor({
  initial, meetingId, onCancel, onSaved, onDeleted,
}: {
  /** When editing an existing item, `initial` carries the current values.
   *  When creating a new one, `meetingId` is set and `initial` is absent. */
  initial?: MeetingDetail['actionItems'][number];
  meetingId?: string;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onDeleted?: () => Promise<void>;
}): JSX.Element {
  const [text, setText] = useState(initial?.text ?? '');
  const [owner, setOwner] = useState(initial?.ownerName ?? '');
  const [due, setDue] = useState(initial?.dueDate ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { textareaRef.current?.focus(); }, []);

  async function save(): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) { setErr('Text cannot be empty.'); return; }
    setBusy(true); setErr(null);
    try {
      if (initial) {
        await api.actionItems.update(initial.id, {
          text: trimmed,
          ownerName: owner.trim() || null,
          dueDate: due || null,
        });
      } else if (meetingId) {
        await api.actionItems.create(meetingId, {
          text: trimmed,
          ownerName: owner.trim() || null,
          dueDate: due || null,
        });
      }
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  async function deleteItem(): Promise<void> {
    if (!initial) return;
    setBusy(true); setErr(null);
    try {
      await api.actionItems.delete(initial.id);
      await onDeleted?.();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-brand-indigo/40 bg-brand-indigo/5 p-3 space-y-2">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        placeholder="What needs to happen?"
        rows={2}
        className="w-full text-sm p-2 border border-surface-border rounded-md bg-surface
                   focus:outline-none focus:border-brand-indigo focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)]
                   resize-y min-h-[44px]"
      />
      <div className="flex gap-2">
        <input
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          placeholder="Owner (optional)"
          maxLength={200}
          className="flex-1 text-sm p-2 border border-surface-border rounded-md bg-surface
                     focus:outline-none focus:border-brand-indigo"
        />
        <input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          className="text-sm p-2 border border-surface-border rounded-md bg-surface
                     focus:outline-none focus:border-brand-indigo"
        />
      </div>
      {err && <div className="text-xs text-rose-600">{err}</div>}
      <div className="flex items-center gap-2">
        {initial && onDeleted && (
          <button
            onClick={() => void deleteItem()}
            disabled={busy}
            className="text-xs font-semibold text-rose-600 hover:text-rose-700 px-2 py-1
                       rounded hover:bg-rose-50 disabled:opacity-50"
          >
            Delete
          </button>
        )}
        <span className="text-[11px] text-ink-muted">
          <kbd className="font-mono">{shortcutMod()}+Enter</kbd> to save · <kbd className="font-mono">Esc</kbd> to cancel
        </span>
        <div className="flex-1" />
        <button
          onClick={onCancel}
          disabled={busy}
          className="text-xs text-ink-muted hover:text-ink px-3 py-1.5 rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="text-xs font-semibold text-white bg-brand-indigo hover:bg-brand-indigo/90
                     px-3 py-1.5 rounded-lg disabled:opacity-50"
        >
          {busy ? 'Saving…' : initial ? 'Save' : 'Add'}
        </button>
      </div>
    </div>
  );
}

function Placeholder({ text }: { text: string }): JSX.Element {
  return <div className="text-sm text-ink-muted italic">{text}</div>;
}

// ─── Summary panel ─────────────────────────────────────────────────────────
//
// Two modes for the LLM-generated summary:
//   view — rendered markdown only
//   edit — textarea + live preview side-by-side
// The previous third mode (full-width textarea, no preview) overlapped with
// edit's editor pane and added decision-fatigue without unique value.
// Anyone wanting more horizontal room can resize the window.
//
// The user owns the final text — the summarize stage gives a starting draft,
// but cleanup is almost always needed (model hallucinations, formatting
// tweaks, redactions). Saved markdown is written straight to summary.md on
// disk; the next pipeline run that touches summarize will overwrite, so
// users wanting to preserve edits across re-runs should avoid re-summarizing.
//
// Edits are kept in component state and only persisted on Save. Disk writes
// happen via the meetings:save-summary IPC, NOT via re-running the pipeline.
type SummaryMode = 'view' | 'edit';

function SummaryPanel({
  meeting, onReload,
}: { meeting: MeetingDetail; onReload: () => Promise<void> }): JSX.Element {
  const original = meeting.summaryMd ?? '';
  const [mode, setMode] = useState<SummaryMode>('view');
  // `savedValue` is the local baseline — what we believe is on disk. It
  // advances on save, ahead of the parent's `meeting.summaryMd` prop, so
  // `dirty` (and the view) reflect the just-saved content even while the
  // parent prop is still catching up to the reload.
  const [savedValue, setSavedValue] = useState(original);
  const [draft, setDraft] = useState(original);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-seed when summary.md actually changes (summarize re-ran, or the user
  // switched meetings without unmounting). We track the previous prop via
  // ref so a mode flip alone doesn't trigger a reset — without this, saving
  // would clobber `draft` back to the stale prop value the instant we drop
  // into view mode, and the user would see their edit "disappear" even
  // though the write succeeded. Edit-mode is still never clobbered.
  const prevOriginalRef = useRef(original);
  useEffect(() => {
    if (prevOriginalRef.current === original) return;
    prevOriginalRef.current = original;
    if (mode === 'view') {
      setDraft(original);
      setSavedValue(original);
    }
  }, [original, mode]);

  const dirty = draft !== savedValue;

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    setSaving(true); setError(null);
    try {
      await api.meetings.saveSummary(meeting.id, draft);
      setSavedValue(draft);
      setSavedAt(new Date());
      // After a successful save, drop back into view so the rendered
      // markdown reflects what's now on disk.
      setMode('view');
      // Refresh the parent so other panes keying off `meeting.summaryMd`
      // (e.g. RightRail's "has summary" check) see the new content.
      void onReload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!original && !dirty) {
    return <Placeholder text="Summary will appear after the summarize stage." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <SummaryToolbar
        mode={mode}
        onMode={setMode}
        dirty={dirty}
        saving={saving}
        savedAt={savedAt}
        error={error}
        onSave={save}
        onRevert={() => { setDraft(original); setError(null); }}
      />
      {mode === 'view' && <MarkdownPreview source={draft} />}
      {mode === 'edit' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <MarkdownEditor value={draft} onChange={setDraft} />
          <div className="border border-surface-border rounded-lg p-4 bg-surface-sunken/40 overflow-auto max-h-[60vh]">
            <MarkdownPreview source={draft} />
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryToolbar({
  mode, onMode, dirty, saving, savedAt, error, onSave, onRevert,
}: {
  mode: SummaryMode;
  onMode: (m: SummaryMode) => void;
  dirty: boolean;
  saving: boolean;
  savedAt: Date | null;
  error: string | null;
  onSave: () => Promise<void> | void;
  onRevert: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <div className="inline-flex bg-surface-sunken rounded-lg p-0.5 text-xs font-semibold">
        {(['view', 'edit'] as const).map((m) => (
          <button
            key={m}
            onClick={() => onMode(m)}
            className={`px-2.5 py-1 rounded-md transition-colors ${
              mode === m ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {m === 'view' ? 'View' : 'Edit'}
          </button>
        ))}
      </div>
      <div className="flex-1 min-w-0">
        {error && <span className="text-xs text-rose-600 truncate" title={error}>{error}</span>}
        {!error && dirty && <span className="text-xs text-ink-muted">Unsaved changes</span>}
        {!error && !dirty && savedAt && (
          <span className="text-xs text-status-ok">
            ✓ Saved {savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
      {dirty && (
        <button
          onClick={onRevert}
          className="text-xs text-ink-muted hover:text-ink px-2 py-1 rounded hover:bg-surface-sunken"
        >
          Revert
        </button>
      )}
      <button
        onClick={() => void onSave()}
        disabled={!dirty || saving}
        className="text-xs font-semibold bg-brand-indigo text-white px-3 py-1 rounded-md
                   hover:bg-brand-indigo/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

function MarkdownPreview({ source }: { source: string }): JSX.Element {
  // `prose` gives us reasonable defaults for headings, lists, code blocks,
  // tables (via remark-gfm), and links — without us having to hand-style
  // every element. `whitespace-pre-wrap` is intentionally absent: the
  // markdown renderer handles its own line breaks via paragraph splitting.
  return (
    <div className="prose prose-sm max-w-none prose-headings:mt-3 prose-p:my-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
}

function MarkdownEditor({
  value, onChange,
}: { value: string; onChange: (v: string) => void }): JSX.Element {
  // Simple textarea — no codemirror / monaco. Keeps the bundle slim and the
  // editing experience predictable. Tab key inserts two spaces (otherwise
  // it'd shift focus away, which is awful in a long edit).
  const ref = useRef<HTMLTextAreaElement>(null);
  // Track line count so we can grow the textarea proportionally without
  // clipping; capped at 60vh so the toolbar stays visible.
  const lineCount = useMemo(() => Math.max(8, value.split('\n').length + 2), [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const ta = e.currentTarget;
          const { selectionStart: ss, selectionEnd: se, value: v } = ta;
          const next = `${v.slice(0, ss)}  ${v.slice(se)}`;
          onChange(next);
          // Restore caret after React rerenders.
          requestAnimationFrame(() => {
            ta.selectionStart = ta.selectionEnd = ss + 2;
          });
        }
      }}
      spellCheck
      className="w-full font-mono text-[13px] leading-relaxed text-ink bg-surface-sunken/40
                 border border-surface-border rounded-lg p-3 resize-none
                 focus:outline-none focus:ring-2 focus:ring-brand-indigo/40 focus:border-brand-indigo
                 max-h-[60vh] overflow-auto"
      style={{ minHeight: `${Math.min(lineCount, 30) * 1.5}rem` }}
    />
  );
}

function RightRail({ meeting, onReload }: { meeting: MeetingDetail; onReload: () => Promise<void> }): JSX.Element {
  // Two-step export: clicking a destination opens a modal listing every action
  // item with a checkbox, so the user can opt out of the ones that aren't
  // theirs (LLMs love to turn "somebody should do X" into an action item
  // regardless of who X is). `exporting` holds both the exporter id and a
  // human label so the modal knows where it's sending.
  const [exporting, setExporting] = useState<{ id: string; label: string } | null>(null);
  const [markdownError, setMarkdownError] = useState<string | null>(null);
  const hasItems = meeting.actionItems.length > 0;
  // Markdown export includes the summary + a checklist of action items,
  // so it's useful whenever there's something on disk to export — even a
  // summary with zero action items is worth downloading. Apple Reminders
  // and (future) Google Tasks only sync action items, so those stay
  // gated on hasItems.
  const hasSummary = Boolean(meeting.summaryMd && meeting.summaryMd.trim().length > 0);
  const canMarkdown = hasItems || hasSummary;
  // Task-app exports (Reminders, Google Tasks) only send items assigned to
  // the user, so they're gated on the user having identified themselves AND
  // actually owning at least one open item.
  const myOpenItemCount = meeting.actionItems.filter((it) => it.isMine && it.status !== 'done').length;
  const canTaskExport = meeting.userIdentified && myOpenItemCount > 0;
  const taskDisabledReason = !meeting.userIdentified
    ? 'Set who you are in Settings → "You are…" to export your action items'
    : myOpenItemCount === 0
      ? 'No open action items are assigned to you'
      : undefined;

  // When there are action items the user probably wants to pick which ones
  // to include, so open the item-picker modal. When there aren't (summary-
  // only export), bypass the modal — just prompt for a save location and
  // write the file with an empty items array (the markdown exporter
  // renders just the summary + an empty "## Action Items" section).
  async function exportMarkdown(): Promise<void> {
    if (hasItems) { setExporting({ id: 'markdown', label: 'Markdown' }); return; }
    setMarkdownError(null);
    try {
      const safeTitle = meeting.title.replace(/[^\w\s-]+/g, '').trim() || 'meeting';
      const picked = await api.dialog.save({
        defaultPath: `${safeTitle}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (!picked) return;
      await api.export.run('markdown', meeting.id, [], picked);
      await onReload();
    } catch (e) {
      setMarkdownError((e as Error).message);
    }
  }

  return (
    <div className="border-l border-surface-border p-4 space-y-3">
      <SpeakersPanel meeting={meeting} onReload={onReload} />
      <div className="pt-3 border-t border-surface-border space-y-2">
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold flex items-center justify-between">
          <span>Export</span>
          {hasItems && (
            <span className="text-ink-muted/80 font-normal tabular-nums">
              {meeting.actionItems.length} action{meeting.actionItems.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {/* All available exporters render with the same ghost-button
            treatment so the panel doesn't claim a winner. The earlier
            design painted Apple Reminders as the hero (saturated
            indigo) and Markdown as the quiet alternative — but most
            users export to Markdown for distribution and Reminders is
            the platform-specific niche. Equal weight lets the user
            choose without the UI nudging. Disabled exporters keep the
            muted treatment so it's clear which options are live. */}
        <button
          disabled={!canTaskExport}
          onClick={() => setExporting({ id: 'reminders', label: 'Apple Reminders' })}
          className="w-full bg-surface border border-surface-border text-xs font-semibold rounded-lg py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:border-ink/30 hover:text-ink transition"
          title={taskDisabledReason ?? (hasItems ? undefined : 'Needs action items — run Extract first')}
        >
          → Apple Reminders
        </button>
        <button
          disabled={!canMarkdown}
          onClick={() => void exportMarkdown()}
          className="w-full bg-surface border border-surface-border text-xs font-semibold rounded-lg py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:border-ink/30 hover:text-ink transition"
          title={canMarkdown ? undefined : 'Needs a summary — run Summarize first'}
        >
          ↓ Markdown
        </button>
        {markdownError && (
          <div className="text-[11px] text-rose-600">{markdownError}</div>
        )}
        <button
          disabled
          className="w-full bg-surface-sunken text-ink-muted/70 text-xs font-semibold rounded-lg py-2 cursor-not-allowed border border-transparent"
        >
          → Google Tasks (soon)
        </button>
        {/* Persistent reminder: task-app exports are scoped to the user's own
            items, so this is never a surprise. */}
        <div className="text-[11px] text-ink-muted flex items-start gap-1.5 pt-0.5">
          <span aria-hidden>🔒</span>
          <span>
            Reminders &amp; Google Tasks send <strong className="font-semibold">only items assigned to you</strong>
            {meeting.userIdentified ? '.' : ' — set "You are…" in Settings first.'}
          </span>
        </div>
        {!hasItems && hasSummary && (
          <div className="text-[11px] text-ink-muted italic mt-1">
            Summary ready — no action items extracted. Markdown download
            still works; Reminders needs action items.
          </div>
        )}
        {!hasSummary && !hasItems && (
          <div className="text-[11px] text-ink-muted italic mt-1">
            No summary or action items yet. Run Summarize + Extract.
          </div>
        )}
      </div>
      {exporting && (
        <ExportPickerModal
          meeting={meeting}
          exporter={exporting}
          onClose={() => setExporting(null)}
          onReload={onReload}
        />
      )}
    </div>
  );
}

function ExportPickerModal({
  meeting, exporter, onClose, onReload,
}: {
  meeting: MeetingDetail;
  exporter: { id: string; label: string };
  onClose: () => void;
  onReload: () => Promise<void>;
}): JSX.Element {
  // Task-app exporters only send the user's own items, so the picker lists
  // only those (the rest of the meeting's items aren't relevant to a personal
  // to-do list). Document exporters list everything.
  const isTaskApp = exporter.id === 'reminders' || exporter.id === 'google-tasks';
  const visibleItems = isTaskApp
    ? meeting.actionItems.filter((it) => it.isMine)
    : meeting.actionItems;
  // Default: every open visible item pre-selected. Done items (already checked
  // off in the app) start unchecked because you rarely want to re-export them.
  const [selected, setSelected] = useState<Set<string>>(() => {
    return new Set(visibleItems.filter((it) => it.status !== 'done').map((it) => it.id));
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAll(): void { setSelected(new Set(visibleItems.map((it) => it.id))); }
  function selectNone(): void { setSelected(new Set()); }

  async function run(): Promise<void> {
    if (selected.size === 0) return;
    setBusy(true); setError(null);
    try {
      let outputPath: string | undefined;
      // Markdown is the only file-based exporter right now — ask where to
      // save before running so the user doesn't have to hunt for the file
      // inside the meeting folder afterwards. Apple Reminders writes into
      // the OS, not a file, so no prompt needed.
      if (exporter.id === 'markdown') {
        const safeTitle = meeting.title.replace(/[^\w\s-]+/g, '').trim() || 'action-items';
        const picked = await api.dialog.save({
          defaultPath: `${safeTitle} — Action Items.md`,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        });
        if (!picked) { setBusy(false); return; } // user cancelled; stay open
        outputPath = picked;
      }
      const message = (await api.export.run(exporter.id, meeting.id, [...selected], outputPath)) as string;
      setResult(message);
      await onReload();
      // Auto-close after a beat so the ✓ message is visible but the user
      // doesn't have to click Close.
      setTimeout(onClose, 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-2xl shadow-2xl border border-surface-border w-full max-w-xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-surface-border flex items-baseline gap-3">
          <h3 className="font-semibold text-sm">Send to {exporter.label}</h3>
          <span className="text-xs text-ink-muted tabular-nums">
            {selected.size}/{visibleItems.length} selected
          </span>
          <div className="flex-1" />
          <button
            onClick={selectAll}
            className="text-[11px] font-semibold text-brand-indigo hover:underline"
          >All</button>
          <button
            onClick={selectNone}
            className="text-[11px] font-semibold text-ink-muted hover:underline"
          >None</button>
        </div>

        {isTaskApp && (
          <div className="mx-3 mt-2 text-[11px] text-ink-soft bg-brand-indigo/5 border border-brand-indigo/20 rounded-lg px-3 py-2 flex items-start gap-1.5">
            <span aria-hidden>🔒</span>
            <span>Only action items assigned to <strong className="font-semibold">you</strong> are sent to {exporter.label}.</span>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
          {visibleItems.length === 0 && (
            <div className="text-sm text-ink-muted italic p-3">
              None of this meeting&apos;s action items are assigned to you.
            </div>
          )}
          {visibleItems.map((it) => {
            const checked = selected.has(it.id);
            return (
              <label
                key={it.id}
                className={`flex items-start gap-3 p-2.5 rounded-lg cursor-pointer transition-colors
                  ${checked ? 'bg-brand-indigo/5' : 'hover:bg-surface-sunken'}
                  ${it.status === 'done' ? 'opacity-60' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(it.id)}
                  className="mt-1 w-4 h-4 accent-brand-indigo shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ink">{it.text}</div>
                  <div className="text-[11px] text-ink-muted mt-0.5 flex items-center gap-2">
                    {it.ownerName && <span>👤 {it.ownerName}</span>}
                    {it.dueDate && <span>📅 {it.dueDate}</span>}
                    {it.status === 'done' && (
                      <span className="bg-status-okBg text-status-ok font-semibold px-1.5 rounded">DONE</span>
                    )}
                    {it.exportedTo.includes(exporter.id) && (
                      <span className="bg-surface-sunken text-ink-muted font-semibold px-1.5 rounded">
                        already sent
                      </span>
                    )}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-surface-border flex items-center gap-3">
          {error && <div className="text-xs text-rose-600 flex-1 truncate" title={error}>{error}</div>}
          {result && <div className="text-xs text-status-ok flex-1 truncate" title={result}>✓ {result}</div>}
          {!error && !result && <div className="flex-1" />}
          <button
            onClick={onClose}
            className="text-sm text-ink-muted hover:text-ink px-3 py-1.5 rounded-lg hover:bg-surface-sunken transition"
          >
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              disabled={busy || selected.size === 0}
              onClick={run}
              className="text-sm font-semibold bg-brand-indigo text-white px-4 py-1.5 rounded-lg hover:bg-brand-indigo/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {busy ? 'Sending…' : `Send ${selected.size}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Speakers panel ────────────────────────────────────────────────────────
//
// The roster lives cross-meeting; the per-meeting concern here is "who is
// this SPEAKER_03 voice?" We let the user click a speaker, play a short clip
// of that voice, then either pick a known name from the roster dropdown or
// type a new one. On a successful assign, the averaged embedding gets merged
// into the roster entry so future meetings auto-match that voice.

interface RosterEntry { id: string; displayName: string; }

function SpeakersPanel({
  meeting, onReload,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
}): JSX.Element {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Bump on every assign/unlink so the roster dropdown re-fetches (newly-
  // created entries appear immediately).
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void (async () => {
      const list = (await api.speakers.list()) as { id: string; displayName: string }[];
      setRoster(list);
    })();
  }, [version]);

  async function reloadMeeting(): Promise<void> {
    // Re-fetch roster (new entries may have been created) AND the meeting
    // detail (so the assigned name shows up immediately without waiting on
    // the parent's polling, which may have stopped after 'done').
    setVersion((v) => v + 1);
    await onReload();
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold">Speakers</div>
        {meeting.speakers.length > 0 && (
          <div className="text-[10px] text-ink-muted tabular-nums">
            {meeting.speakers.filter((sp) => sp.rosterId).length}/{meeting.speakers.length} named
          </div>
        )}
      </div>

      {meeting.speakers.length === 0 && (
        <div className="text-xs text-ink-muted italic">
          No speakers yet. Available after diarize + identify.
        </div>
      )}

      <div className="space-y-1.5">
        {meeting.speakers.map((sp, i) => (
          <SpeakerRow
            key={sp.localLabel}
            meetingId={meeting.id}
            localLabel={sp.localLabel}
            displayName={sp.displayName}
            rosterId={sp.rosterId}
            colorIdx={i}
            roster={roster}
            isOpen={expanded === sp.localLabel}
            onToggle={() => setExpanded((prev) => (prev === sp.localLabel ? null : sp.localLabel))}
            onChanged={reloadMeeting}
          />
        ))}
      </div>
    </div>
  );
}

function SpeakerRow({
  meetingId, localLabel, displayName, rosterId, colorIdx, roster,
  isOpen, onToggle, onChanged,
}: {
  meetingId: string;
  localLabel: string;
  displayName: string | null;
  rosterId: string | null;
  colorIdx: number;
  roster: RosterEntry[];
  isOpen: boolean;
  onToggle: () => void;
  onChanged: () => void;
}): JSX.Element {
  const named = rosterId !== null;
  const color = colorForSpeakerIndex(colorIdx);

  return (
    <div
      className={`
        rounded-lg text-xs transition-colors
        ${named ? 'bg-surface-sunken' : 'bg-status-warnBg border border-dashed border-status-warn'}
        ${isOpen ? 'ring-2 ring-brand-indigo/40' : ''}
      `}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 p-2 text-left"
        aria-expanded={isOpen}
      >
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
          style={{ background: color }}
        >
          {(displayName?.[0] ?? localLabel.replace('SPEAKER_', '').slice(-1) ?? '?').toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{displayName ?? localLabel}</div>
          {named && <div className="text-[10px] text-ink-muted font-mono">{localLabel}</div>}
        </div>
        <svg
          viewBox="0 0 16 16"
          className={`w-3 h-3 text-ink-muted shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        >
          <path d="M3 6l5 5 5-5" />
        </svg>
      </button>
      {isOpen && (
        <SpeakerEditor
          meetingId={meetingId}
          localLabel={localLabel}
          rosterId={rosterId}
          roster={roster}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

function SpeakerEditor({
  meetingId, localLabel, rosterId, roster, onChanged,
}: {
  meetingId: string;
  localLabel: string;
  rosterId: string | null;
  roster: RosterEntry[];
  onChanged: () => void;
}): JSX.Element {
  const [sample, setSample] = useState<{ dataUri: string; startS: number; endS: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Lazy-load the sample the first time the row expands; keeps Library scroll
  // snappy when the user is just browsing through 10 speakers without playing.
  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const s = await api.speakers.sample(meetingId, localLabel);
        if (!alive) return;
        setSample(s ?? null);
        if (!s) setError('No clip available — speaker has no segments long enough.');
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [meetingId, localLabel]);

  async function assignExisting(rid: string): Promise<void> {
    setBusy(true); setError(null);
    try {
      await api.speakers.assign({ meetingId, localLabel, mode: 'existing', rosterId: rid });
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function createNew(): Promise<void> {
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setError(null);
    try {
      await api.speakers.assign({ meetingId, localLabel, mode: 'new', displayName: name });
      setNewName('');
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function unlink(): Promise<void> {
    setBusy(true); setError(null);
    try {
      await api.speakers.unlink(meetingId, localLabel);
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  // Narrow the roster dropdown options to not include the currently-linked
  // entry (it'd be a no-op) so the user always sees actionable choices.
  const assignableRoster = roster.filter((r) => r.id !== rosterId);

  return (
    <div className="border-t border-surface-border px-2 py-2 space-y-2">
      {/* Audio player */}
      {loading && (
        <div className="text-[11px] text-ink-muted italic flex items-center gap-1.5">
          <MiniSpinner /> Loading sample…
        </div>
      )}
      {sample && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => audioRef.current?.play()}
            className="shrink-0 w-7 h-7 rounded-full bg-brand-indigo text-white flex items-center justify-center hover:bg-brand-indigo/90 transition"
            aria-label="Play sample"
          >
            <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor">
              <path d="M4 3v10l9-5z" />
            </svg>
          </button>
          <audio ref={audioRef} src={sample.dataUri} preload="auto" controls className="flex-1 h-7" />
        </div>
      )}
      {sample && (
        <div className="text-[10px] text-ink-muted tabular-nums">
          Clip from {fmtSec(sample.startS)} – {fmtSec(sample.endS)} ({(sample.endS - sample.startS).toFixed(1)}s)
        </div>
      )}

      {/* Assign to existing roster entry */}
      {assignableRoster.length > 0 && (
        <div>
          <div className="text-[10px] font-bold text-ink-muted uppercase mb-1">Assign to</div>
          <select
            disabled={busy}
            value=""
            onChange={(e) => {
              if (e.target.value) void assignExisting(e.target.value);
              e.target.value = '';
            }}
            className="w-full text-xs border border-surface-border rounded-md bg-surface px-2 py-1
                       focus:outline-none focus:border-brand-indigo"
          >
            <option value="">— pick a known speaker —</option>
            {assignableRoster.map((r) => (
              <option key={r.id} value={r.id}>{r.displayName}</option>
            ))}
          </select>
        </div>
      )}

      {/* Create a new roster entry */}
      <div>
        <div className="text-[10px] font-bold text-ink-muted uppercase mb-1">Or add new</div>
        <div className="flex gap-1.5">
          <input
            disabled={busy}
            value={newName}
            placeholder="Full name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void createNew(); }}
            className="flex-1 text-xs border border-surface-border rounded-md bg-surface px-2 py-1
                       focus:outline-none focus:border-brand-indigo placeholder:text-ink-muted"
          />
          <button
            disabled={busy || newName.trim().length === 0}
            onClick={createNew}
            className="text-xs font-semibold px-2.5 py-1 rounded-md bg-brand-indigo text-white
                       disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand-indigo/90 transition"
          >
            Save
          </button>
        </div>
      </div>

      {rosterId !== null && (
        <button
          disabled={busy}
          onClick={unlink}
          className="text-[11px] text-ink-muted hover:text-rose-600 transition underline decoration-dotted"
        >
          Unassign
        </button>
      )}

      {error && <div className="text-[11px] text-rose-600">{error}</div>}
    </div>
  );
}

function fmtSec(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}
