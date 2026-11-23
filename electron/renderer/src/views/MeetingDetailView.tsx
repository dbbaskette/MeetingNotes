// electron/renderer/src/views/MeetingDetailView.tsx
// The meeting page. State and effects live in meeting-detail/hooks and the
// sub-components in meeting-detail/ (#256); this file keeps the layout.
import { MeetingRowMenu } from '../components/MeetingRowMenu';
import { MoveToGroupDialog } from '../components/MoveToGroupDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon, IconLabel } from '../components/icons';
import { fmtPlaybackRate, SKIP_SECONDS } from '../lib/audio-controls';
import { toFileUrl } from '../lib/file-url';
import { primaryProcessingStatus } from '../../../shared/processing-recovery';
import { useMeetingDetail } from './meeting-detail/hooks/useMeetingDetail';
import { EditableTitle } from './meeting-detail/EditableTitle';
import { DetailSkeleton, DetailUnavailable } from './meeting-detail/DetailStates';
import { FailureBanner, SpeakerIdControls } from './meeting-detail/PipelineBanners';
import { StageTimeline } from './meeting-detail/StageTimeline';
import { ProcessingMenu } from './meeting-detail/ProcessingMenu';
import { CenterPane } from './meeting-detail/CenterPane';
import { RightRail } from './meeting-detail/RightRail';

// Existing importers reach these through this module.
export type { MeetingDetail } from './meeting-detail/types';
export { FailureBanner } from './meeting-detail/PipelineBanners';

/** "Apr 20, 2026 · 53m" for the header; empty when the date is unknown. */
function meetingWhen(m: { startedAt: string | null; durationS: number | null }): string {
  if (!m.startedAt) return '';
  const date = new Date(m.startedAt);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const minutes = m.durationS ? Math.max(1, Math.round(m.durationS / 60)) : 0;
  return minutes ? `${day} · ${minutes}m` : day;
}

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
   *  of "Loading…" placeholders while the lightweight shell resolves. */
  hint?: { title?: string; pipelineStage?: string; status?: string };
}): JSX.Element {
  const {
    m, problem, setProblem, moveGroupOpen, setMoveGroupOpen, artifacts, transcript, speakerReview,
    tab, setTab, railOpen, toggleRail, provenance, showSource, playback, notes, reload, retrySpeakerReview,
  } = useMeetingDetail({ id, seekSeconds });
  const { audioRef, playbackClock, onTimeUpdate, seekRevision, seekTo, rate, cycleRate, applyRate, skipBy } = playback;
  const {
    summaryMode, setSummaryMode, summaryDraft, setSummaryDraft, summarySaved, setSummarySaved,
    discardOpen, settleDiscard,
  } = notes;

  if (!m && problem?.id === id)
    return <DetailUnavailable problem={problem} onBack={onBack} onRetry={() => { setProblem(null); void reload(); }} />;
  if (!m)
    return <DetailSkeleton hint={hint} onBack={onBack} />;

  return (
    // Detail card fills the available height inside App's flex column,
    // then internally splits into [pinned header] / [scrollable grid] /
    // [pinned audio]. Title bar, stage timeline, and parked-banner stay
    // on screen while the user reads a long summary or transcript.
    <div className="detail-view max-w-6xl mx-auto my-6 h-[calc(100%-3rem)] bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden flex flex-col">
      <div className="app-chrome detail-chrome shrink-0 flex items-center gap-3 px-5 py-3 border-b border-surface-border">
        {/* onBack (App's history goBack) consults the unsaved-edits guard
            itself — do NOT guard again here, or a dirty summary would
            prompt the discard dialog twice. */}
        <button
          onClick={onBack}
          className="text-ink-muted hover:text-ink text-sm shrink-0"
        >
          <IconLabel icon="arrow-left">Back</IconLabel>
        </button>
        {/* min-w-0 lets the truncate actually clip long titles instead of
            forcing the flex row to overflow — otherwise a long title would
            push the actions menu off the right edge. Click-to-edit (#A5):
            the same rename IPC the ⋯ menu uses, without the modal. */}
        <div className="flex-1 min-w-0 text-center px-2">
          <EditableTitle id={m.id} title={m.title} onRenamed={() => void reload()} />
          <button type="button" title={`Change group (currently ${m.groupName ?? 'Ungrouped'})`}
            aria-label={`Change group for ${m.title} (currently ${m.groupName ?? 'Ungrouped'})`}
            onClick={() => setMoveGroupOpen(true)}
            className="mt-0.5 max-w-full inline-flex items-center gap-1 text-[11px] text-ink-muted hover:text-brand-indigo focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40 rounded px-1">
            <svg viewBox="0 0 20 20" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M2 5h6l2 2h8v9H2z" /></svg>
            <span className="truncate">{m.groupName ?? 'Add to group'}</span>
          </button>
          {meetingWhen(m) && <span className="ml-2 text-[11px] text-ink-muted">{meetingWhen(m)}</span>}
        </div>
        {/* Actions menu: rename/delete from the detail view. When the user
            deletes from here, route back to Library since the detail we're
            viewing no longer exists. */}
        <div className="relative flex items-center justify-end gap-2 shrink-0">
          <ProcessingMenu meeting={m} onReload={reload} />
          <button
            type="button"
            aria-pressed={railOpen}
            title={railOpen ? 'Hide speakers and export' : 'Show speakers and export'}
            aria-label={railOpen ? 'Hide speakers and export' : 'Show speakers and export'}
            onClick={toggleRail}
            className="hidden lg:inline-flex text-ink-muted hover:text-ink border border-surface-border rounded-lg p-1.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo"
          >
            <svg viewBox="0 0 20 20" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="M12.5 3.5v13" />
              {railOpen && <path d="M14.5 7h1M14.5 10h1" strokeLinecap="round" />}
            </svg>
          </button>
          <MeetingRowMenu
            meeting={{ id: m.id, title: m.title, groupId: m.groupId, groupName: m.groupName }}
            onChanged={() => void reload()}
            onDeleted={() => onBack()}
          />
        </div>
      </div>

      {moveGroupOpen && <MoveToGroupDialog ids={[m.id]} meeting={m} onClose={() => setMoveGroupOpen(false)} onChanged={() => void reload()} />}

      {/* Parked-at-gate banner renders ABOVE the timeline. The gate is the
          one moment in the pipeline where the UI is waiting for a human
          decision; hiding it below 8 pipeline chips hurt the time-to-
          action. Returns null when not parked. */}
      <div className="shrink-0">
        {primaryProcessingStatus(m) === 'speaker' && <SpeakerIdControls meeting={m} onReload={reload} placement="above-timeline" />}
      </div>

      {/* Failure banner: when a run failed, surface WHY (the error string the
          pipeline caught, e.g. "speech engine: not ready ...") with a one-click
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
        {m.status !== 'failed' && <SpeakerIdControls meeting={m} onReload={reload} placement="below-timeline" />}
      </div>

      {/* Responsive layout: stack single-column below lg (1024px) so the
          narrow rails don't clip center-pane content (transcript / audio
          player / summary). min-w-0 on each cell lets flex/grid children
          actually shrink — without it long lines of text force horizontal
          overflow and the whole detail view gets cut off on the right.
          On narrow, the CenterPane renders first (content first), then
          the speakers/export rail below. On lg+ the rail sits to the right
          and can be hidden from the header so notes use the full width.

          Scroll model:
            • lg+ (2 columns): notes and rail scroll on their own — center
              pane can show a 50-page summary while the speakers/export
              rail stays visible.
            • Below lg (stacked): the grid itself scrolls as one column
              because per-section overflow would create awkward nested
              scrollbars on narrow widths. */}
      <div className={`grid grid-cols-1 ${railOpen ? 'lg:grid-cols-[minmax(0,1fr)_260px]' : ''} flex-1 min-h-0 overflow-y-auto lg:overflow-hidden`}>
        <div className="order-1 lg:order-none min-w-0 lg:overflow-y-auto">
          <CenterPane
            meeting={m}
            tab={tab}
            onTab={setTab}
            playbackClock={playbackClock}
            seekRevision={seekRevision}
            onSeek={seekTo}
            onReload={reload}
            onShowSource={showSource}
            provenance={provenance}
            summaryMode={summaryMode}
            onSummaryMode={setSummaryMode}
            summaryDraft={summaryDraft}
            onSummaryDraft={setSummaryDraft}
            summarySaved={summarySaved}
            onSummaryBaseline={setSummarySaved}
            transcriptState={transcript}
            onRetryTranscript={() => void artifacts.request(id, 'transcript')}
          />
        </div>
        <div className={`detail-inspector order-3 min-w-0 lg:overflow-y-auto ${railOpen ? '' : 'lg:hidden'}`}><RightRail meeting={m} onReload={reload}
          speakerReviewState={speakerReview} onRetrySpeakerReview={retrySpeakerReview} /></div>
      </div>

      {/* Audio player pinned to the bottom of the card. Lives outside the
          CenterPane so it stays visible while the user reads the summary
          OR transcript — no more "switch tabs to play". Click-to-seek on
          transcript lines pipes through `seekTo` to this element. */}
      <div className="audio-chrome shrink-0 bg-surface-sunken border-t border-surface-border px-5 py-3 flex items-center gap-2">
        {/* Transport controls (#A3). Keyboard: Space play/pause, ←/→ ∓/±15s. */}
        <button
          type="button"
          onClick={() => skipBy(-SKIP_SECONDS)}
          title="Back 15 seconds (←)"
          aria-label="Back 15 seconds"
          className="shrink-0 text-xs font-semibold text-ink-muted hover:text-ink bg-surface border border-surface-border rounded-lg px-2.5 py-1.5 tabular-nums transition inline-flex items-center gap-1"
        >
          <Icon name="rotate-ccw" className="w-3 h-3" />
          15s
        </button>
        <button
          type="button"
          onClick={() => skipBy(SKIP_SECONDS)}
          title="Forward 15 seconds (→)"
          aria-label="Forward 15 seconds"
          className="shrink-0 text-xs font-semibold text-ink-muted hover:text-ink bg-surface border border-surface-border rounded-lg px-2.5 py-1.5 tabular-nums transition inline-flex items-center gap-1"
        >
          15s
          <Icon name="rotate-cw" className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={cycleRate}
          title="Playback speed — click to cycle"
          aria-label={`Playback speed ${fmtPlaybackRate(rate)} — click to cycle`}
          className="shrink-0 min-w-[3.75rem] text-xs font-semibold text-ink-muted hover:text-ink bg-surface border border-surface-border rounded-lg px-2.5 py-1.5 tabular-nums transition"
        >
          {fmtPlaybackRate(rate)}
        </button>
        <audio
          ref={audioRef}
          controls
          src={toFileUrl(m.audioPath)}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={applyRate}
          className="flex-1 min-w-0"
        />
      </div>

      {/* Unsaved-summary discard confirmation (#192). Opened by the async
          unsaved-edits guard registered above; resolves the pending
          navigation promise with the user's answer. */}
      <ConfirmDialog
        open={discardOpen}
        title="Discard unsaved summary edits?"
        body="Your edits to the summary haven't been saved. Leaving this meeting now discards them."
        confirmLabel="Discard"
        destructive
        onConfirm={() => settleDiscard(true)}
        onCancel={() => settleDiscard(false)}
      />
    </div>
  );
}
