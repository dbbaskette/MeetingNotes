// electron/renderer/src/views/meeting-detail/StageTimeline.tsx
// Pipeline stage timeline and its icons, moved out of MeetingDetailView.tsx (#256).
import { useElapsed, fmtElapsed } from '../../lib/useElapsed';
import { fmtEta, isRunningLong } from '../../lib/fmtEta';
import { USER_STEPS, stepIndexFor } from '../../lib/pipeline-steps';
import type { MeetingDetail } from './types';

export function StageTimeline({ meeting }: { meeting: MeetingDetail }): JSX.Element {
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
                ${isCurrent && isProcessing ? 'bg-brand-solid text-white shadow-sm' : ''}
                ${isFailedHere ? 'bg-danger-bg text-danger-text' : ''}
                ${isAwaitingHere ? 'bg-status-warnBg text-status-warnText shadow-sm' : ''}
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
                <span className="font-normal opacity-80">
                  {fmtElapsed(elapsed)}
                  {' · '}
                  <span className={isRunningLong(elapsed, meeting.stageEtaMs) ? 'text-status-warnOnSolid font-semibold' : ''}>
                    {fmtEta(meeting.stageEtaMs, meeting.stageEtaRough)}
                    {isRunningLong(elapsed, meeting.stageEtaMs) ? ' · running long' : ''}
                  </span>
                </span>
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

export function MiniSpinner(): JSX.Element {
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
