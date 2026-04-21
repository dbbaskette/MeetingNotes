// electron/renderer/src/components/LibraryRow.tsx
//
// A processed (or in-flight / failed) meeting in the Library zone. Richer
// than an InboxRow: shows speakers, action-item count, live stage spinner,
// colored left edge by state. No inline retry — failed rows open the detail
// view where the user picks which stage to rewind to.
import { colorForSpeakerIndex } from '../theme/tokens';
import { useElapsed, fmtElapsed } from '../lib/useElapsed';

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

export function LibraryRow({ meeting, onOpen }: Props): JSX.Element {
  const status = meeting.status;
  const edge =
    status === 'failed' ? 'before:bg-rose-500' :
    status === 'processing' ? 'before:bg-brand-indigo' :
    status === 'awaiting_user' ? 'before:bg-status-warn' :
    'before:bg-transparent';

  return (
    <div
      onClick={() => onOpen(meeting.id)}
      className={`
        group relative bg-surface border border-surface-border rounded-xl
        px-4 py-3 flex items-center gap-4 cursor-pointer transition
        hover:-translate-y-px hover:border-brand-indigo/60 hover:shadow-pop
        before:content-[''] before:absolute before:left-0 before:top-2 before:bottom-2
        before:w-[3px] before:rounded-r-full ${edge}
      `}
    >
      <AvatarStack meeting={meeting} />

      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm text-ink truncate">{meeting.title}</div>
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
        <span
          title={`${meeting.actionItemsCount} action item${meeting.actionItemsCount === 1 ? '' : 's'}`}
          className="bg-brand-indigo/10 text-brand-indigo text-xs font-semibold px-2 py-0.5 rounded-full"
        >
          ✓ {meeting.actionItemsCount}
        </span>
      )}

      <StatusChip meeting={meeting} />

      <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-ink-muted/40 shrink-0 group-hover:text-brand-indigo transition-colors" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M6 3l5 5-5 5" />
      </svg>
    </div>
  );
}

function AvatarStack({ meeting }: { meeting: Meeting }): JSX.Element {
  if (meeting.status === 'failed') {
    return (
      <div className="w-7 h-7 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center text-xs font-bold border-2 border-surface shrink-0">
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

function StatusChip({ meeting }: { meeting: Meeting }): JSX.Element {
  const status = meeting.status;

  if (status === 'failed') {
    return (
      <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 shrink-0">
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
  return (
    <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-status-processingBg text-status-processing shrink-0 flex items-center gap-1.5 tabular-nums">
      <Spinner />
      {STAGE_CHIP_LABEL[meeting.pipelineStage] ?? meeting.pipelineStage.toUpperCase()}
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
