// electron/renderer/src/components/LibraryRow.tsx
//
// One row component for every meeting state — unprocessed, in-flight,
// done, failed. Previously there were two zones with two components
// (InboxRow vs LibraryRow); collapsing to one list with a filter chip
// removed duplicated rendering logic and made search work across every
// state, including pending.
//
// For pending meetings the row exposes a checkbox (for bulk Process)
// and an inline ▶ Process button. For everything else it shows the
// speakers/status/action-items side, and clicking the row opens detail.
import { colorForSpeakerIndex } from '../theme/tokens';
import { useElapsed, fmtElapsed } from '../lib/useElapsed';
import { stepIndexFor, TOTAL_USER_STEPS } from '../lib/pipeline-steps';
import { MeetingRowMenu } from './MeetingRowMenu';

interface Meeting {
  id: string;
  title: string;
  startedAt: string | null;
  durationS: number | null;
  pipelineStage: string;
  status: string;
  stageStartedAt: string | null;
  unidentifiedCount: number;
  actionItemsCount: number;
  speakers: { localLabel: string; displayName: string | null }[];
}

interface Props {
  meeting: Meeting;
  onOpen: (id: string) => void;
  onChanged: () => void;
  /** Only meaningful when `meeting.status === 'pending'`. When present,
   *  the pending row renders a selection checkbox (for bulk Process) and
   *  toggling it calls `onToggle`. */
  checked?: boolean;
  onToggle?: () => void;
}

function fmtDur(s: number | null): string {
  if (s === null) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.valueOf())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function LibraryRow({ meeting, onOpen, onChanged, checked, onToggle }: Props): JSX.Element {
  const status = meeting.status;
  const isPending = status === 'pending';
  const edge =
    status === 'failed' ? 'before:bg-danger-solid' :
    status === 'processing' ? 'before:bg-brand-indigo' :
    status === 'awaiting_user' ? 'before:bg-status-warn' :
    'before:bg-transparent';

  // Pending rows have a subtly muted background so unprocessed items read as
  // "not yet a finished meeting" without looking broken. Everything else
  // sits on standard surface.
  const bg = isPending ? 'bg-surface-sunken/40' : 'bg-surface';

  function handleRowClick(): void {
    // On a pending row with selection props, clicking the row body toggles
    // the checkbox (makes "select 5 and process" fast). Without selection
    // props — or for any non-pending row — clicking opens detail.
    if (isPending && onToggle) onToggle();
    else onOpen(meeting.id);
  }

  return (
    <div
      onClick={handleRowClick}
      className={`
        group relative ${bg} border border-surface-border rounded-xl
        px-4 py-3 flex items-center gap-4 cursor-pointer transition
        hover:border-brand-indigo/60 hover:shadow-pop
        before:content-[''] before:absolute before:left-0 before:top-2 before:bottom-2
        before:w-[3px] before:rounded-r-full ${edge}
        ${checked ? 'ring-1 ring-brand-indigo/40' : ''}
      `}
    >
      {isPending && onToggle ? (
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          aria-label={checked ? 'Deselect' : 'Select for processing'}
          className={`
            w-[18px] h-[18px] rounded-[5px] border-2 shrink-0 flex items-center justify-center transition
            ${checked
              ? 'bg-brand-indigo border-brand-indigo text-white'
              : 'border-ink/20 bg-surface group-hover:border-ink/40'}
          `}
        >
          {checked && (
            <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8l3.5 3.5L13 5" />
            </svg>
          )}
        </button>
      ) : (
        <AvatarStack meeting={meeting} />
      )}

      <div className="flex-1 min-w-0">
        <div className={`font-semibold text-sm truncate ${isPending ? 'text-ink-muted font-mono' : 'text-ink'}`}>{meeting.title}</div>
        <div className="text-xs text-ink-muted mt-0.5 flex items-center gap-1.5">
          <span>{fmtDate(meeting.startedAt)}</span>
          {meeting.durationS !== null && (
            <>
              <span className="text-surface-border">·</span>
              <span>{fmtDur(meeting.durationS)}</span>
            </>
          )}
          {meeting.unidentifiedCount > 0 && status === 'done' && (
            <>
              <span className="text-surface-border">·</span>
              <span className="text-status-warnText">
                {meeting.unidentifiedCount} to identify
              </span>
            </>
          )}
        </div>
      </div>

      {meeting.actionItemsCount > 0 && status === 'done' && (
        // Outline style (not filled) so the row's state chip + left edge
        // read first, and the action-item count reads second. Filled
        // indigo competed too hard with PROCESSED for attention on scan.
        <span
          title={`${meeting.actionItemsCount} action item${meeting.actionItemsCount === 1 ? '' : 's'}`}
          className="border border-ink-muted/25 text-ink-muted text-xs font-semibold px-2 py-0.5 rounded-full"
        >
          ✓ {meeting.actionItemsCount}
        </span>
      )}

      <StatusChip meeting={meeting} />

      <MeetingRowMenu meeting={meeting} onChanged={onChanged} />

      {!isPending && (
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-ink-muted/40 shrink-0 group-hover:text-brand-indigo transition-colors" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M6 3l5 5-5 5" />
        </svg>
      )}
    </div>
  );
}

function AvatarStack({ meeting }: { meeting: Meeting }): JSX.Element {
  if (meeting.status === 'failed') {
    return (
      <div className="w-7 h-7 rounded-full bg-danger-bg text-danger flex items-center justify-center text-xs font-bold border-2 border-surface shrink-0">
        !
      </div>
    );
  }
  if (meeting.status === 'processing') {
    return (
      <div className="w-7 h-7 rounded-full bg-brand-indigo/10 text-brand-indigo flex items-center justify-center shrink-0 border-2 border-surface">
        <Spinner />
      </div>
    );
  }
  if (meeting.status === 'awaiting_user') {
    // Person icon on amber — communicates "waiting on a human" without
    // implying the pipeline is actively chewing through bytes.
    return (
      <div
        className="w-7 h-7 rounded-full bg-status-warnBg text-status-warnText flex items-center justify-center shrink-0 border-2 border-surface text-sm font-bold"
        title="Waiting for you to identify speakers"
      >
        ?
      </div>
    );
  }
  if (meeting.speakers.length === 0) {
    return (
      <div className="w-7 h-7 rounded-full bg-surface-sunken border-2 border-surface-border shrink-0" />
    );
  }
  return (
    <div className="flex shrink-0">
      {meeting.speakers.slice(0, 4).map((sp, i) => (
        <div
          key={i}
          style={{ background: colorForSpeakerIndex(i), marginLeft: i === 0 ? 0 : -6 }}
          className="w-7 h-7 rounded-full text-white text-xs font-bold flex items-center justify-center border-2 border-surface"
        >
          {(sp.displayName?.[0] ?? '?').toUpperCase()}
        </div>
      ))}
    </div>
  );
}

// Friendlier stage labels for the row chip — `awaiting_speaker_id` is too
// long to fit, and `summarizing` reads better as a verb in present tense.
// Anything not in this map falls back to the stage name uppercased.
const STAGE_CHIP_LABEL: Record<string, string> = {
  transcribing: 'TRANSCRIBING',
  diarizing: 'DIARIZING',
  merging: 'MERGING',
  identifying: 'IDENTIFYING',
  awaiting_speaker_id: 'NAME VOICES',
  summarizing: 'SUMMARIZING',
  extracting: 'EXTRACTING',
};

// User-facing progress steps come from the shared pipeline-steps model.
// The same model drives the StageTimeline in MeetingDetailView, so a row
// that says "PROCESSING 2/5" matches step 2 of 5 in the detail view.

function StatusChip({ meeting }: { meeting: Meeting }): JSX.Element {
  const status = meeting.status;

  if (status === 'pending') {
    // Neutral treatment so pending doesn't read as "error" or "in-flight" —
    // it's just an arrival waiting on a user action.
    return (
      <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-surface-sunken text-ink-muted border border-surface-border shrink-0">
        PENDING
      </span>
    );
  }

  if (status === 'failed') {
    return (
      <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-danger-bg text-danger-text shrink-0">
        FAILED
      </span>
    );
  }

  if (status === 'processing') {
    return <ProcessingChip meeting={meeting} />;
  }

  // Pipeline is parked waiting on the user. Amber instead of indigo so it
  // visually reads as "needs attention" rather than "still working" — the
  // meeting will sit here forever until someone clicks in.
  if (status === 'awaiting_user') {
    return (
      <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-status-warnBg text-status-warnText shrink-0 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-status-warn" />
        {STAGE_CHIP_LABEL[meeting.pipelineStage] ?? meeting.pipelineStage.toUpperCase()}
      </span>
    );
  }

  // Only call it "PROCESSED" when the pipeline actually reached `done`. Any
  // other terminal-looking-but-not-quite state (e.g. a brand-new pending row
  // that wandered into Library) shouldn't masquerade as finished.
  if (status === 'done' && meeting.pipelineStage === 'done') {
    return (
      <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-status-okBg text-status-ok shrink-0">
        PROCESSED
      </span>
    );
  }

  // Fallback for any unexpected combination — show the raw stage so we can
  // diagnose rather than lying with a green "PROCESSED" badge.
  return (
    <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-surface-sunken text-ink-muted shrink-0">
      {STAGE_CHIP_LABEL[meeting.pipelineStage] ?? meeting.pipelineStage.toUpperCase()}
    </span>
  );
}

function ProcessingChip({ meeting }: { meeting: Meeting }): JSX.Element {
  const elapsed = useElapsed(meeting.stageStartedAt, meeting.status === 'processing');
  // Show linear progress N/<total> instead of the internal stage name. Users
  // don't want to learn "diarizing" vs "merging" vs "identifying" — they
  // want to know "is this close to done". The detail view's StageTimeline
  // surfaces the same user-step model from lib/pipeline-steps so the
  // numbers agree across both surfaces.
  const idx = stepIndexFor(meeting.pipelineStage);
  const progress = idx >= 0
    ? `${idx + 1}/${TOTAL_USER_STEPS}`
    : STAGE_CHIP_LABEL[meeting.pipelineStage] ?? meeting.pipelineStage.toUpperCase();
  return (
    <span
      className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-status-processingBg text-status-processing shrink-0 flex items-center gap-1.5 tabular-nums"
      title={`${STAGE_CHIP_LABEL[meeting.pipelineStage] ?? meeting.pipelineStage} — ${progress}`}
    >
      <Spinner />
      PROCESSING {progress}
      {elapsed !== null && (
        <span className="text-status-processing/70 font-normal">· {fmtElapsed(elapsed)}</span>
      )}
    </span>
  );
}

function Spinner(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M8 2a6 6 0 1 1-6 6" opacity="0.9" />
    </svg>
  );
}
