// electron/renderer/src/views/meeting-detail/DetailStates.tsx
// Unavailable and loading states of the meeting page, moved out of
// MeetingDetailView.tsx (#256).
import { IconLabel } from '../../components/icons';
import { USER_STEPS, stepIndexFor } from '../../lib/pipeline-steps';

/** Shown instead of an endless skeleton when a meeting cannot be shown. */
export function DetailUnavailable({ problem, onBack, onRetry }: {
  problem: { kind: 'missing' | 'error'; message?: string };
  onBack: () => void;
  onRetry: () => void;
}): JSX.Element {
  const missing = problem.kind === 'missing';
  return (
    <div className="detail-view max-w-6xl mx-auto my-6 bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-surface-border">
        <button onClick={onBack} className="text-ink-muted hover:text-ink text-sm shrink-0"><IconLabel icon="arrow-left">Back</IconLabel></button>
      </div>
      <div role="alert" className="px-6 py-16 text-center">
        <h2 className="text-base font-semibold text-ink">
          {missing ? 'This meeting is no longer available' : 'Could not open this meeting'}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          {missing ? 'It may have been deleted or moved to another library.' : problem.message ?? 'The meeting could not be read.'}
        </p>
        <div className="mt-4 flex justify-center gap-2">
          {!missing && <button type="button" onClick={onRetry}
            className="px-3 py-1.5 text-sm font-semibold rounded-lg bg-brand-solid text-white">Try again</button>}
          <button type="button" onClick={onBack}
            className="px-3 py-1.5 text-sm rounded-lg border border-surface-border text-ink">Back to Library</button>
        </div>
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
export function DetailSkeleton({
  hint, onBack,
}: {
  hint?: { title?: string; pipelineStage?: string; status?: string };
  onBack: () => void;
}): JSX.Element {
  const stageIdx = hint?.pipelineStage ? stepIndexFor(hint.pipelineStage) : -1;
  const isFullyDone = hint?.pipelineStage === 'done';
  const showLiveStage = hint?.status === 'processing';
  return (
    <div className="detail-view max-w-6xl mx-auto my-6 bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden">
      {/* Title bar — uses real title when available */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-surface-border">
        <button onClick={onBack} className="text-ink-muted hover:text-ink text-sm shrink-0">
          <IconLabel icon="arrow-left">Back</IconLabel>
        </button>
        <div className="flex-1 min-w-0 text-center font-semibold truncate px-2">
          {hint?.title ?? (
            <span className="inline-block h-4 w-48 bg-skeleton/80 rounded animate-pulse align-middle" />
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
                ${isCurrent ? 'bg-brand-solid text-white shadow-sm' : ''}
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
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_260px] min-h-[560px]">
        {/* Center pane */}
        <div className="order-1 lg:order-none p-6">
          <div className="flex gap-4 mb-6">
            <div className="h-3 w-16 bg-skeleton/70 rounded animate-pulse" />
            <div className="h-3 w-16 bg-skeleton/70 rounded animate-pulse" />
            <div className="h-3 w-16 bg-skeleton/70 rounded animate-pulse" />
          </div>
          <div className="space-y-2.5 animate-pulse">
            <div className="h-3 bg-skeleton/80 rounded w-[96%]" />
            <div className="h-3 bg-skeleton/80 rounded w-[90%]" />
            <div className="h-3 bg-skeleton/80 rounded w-[94%]" />
            <div className="h-3 bg-skeleton/80 rounded w-[40%] mb-3" />
            <div className="h-3 bg-skeleton/80 rounded w-[88%]" />
            <div className="h-3 bg-skeleton/80 rounded w-[92%]" />
            <div className="h-3 bg-skeleton/80 rounded w-[55%]" />
          </div>
        </div>
        {/* Right rail */}
        <div className="order-3 border-l border-surface-border p-4 space-y-3 animate-pulse">
          <div className="h-2 w-16 bg-skeleton/70 rounded" />
          <div className="h-9 w-full bg-skeleton/60 rounded-lg" />
          <div className="h-9 w-full bg-skeleton/60 rounded-lg" />
          <div className="h-9 w-full bg-skeleton/60 rounded-lg" />
        </div>
      </div>

      {/* Audio player placeholder */}
      <div className="sticky bottom-0 bg-surface-sunken border-t border-surface-border px-5 py-4">
        <div className="h-8 bg-skeleton/60 rounded-md animate-pulse" />
      </div>
    </div>
  );
}
