// electron/renderer/src/components/MeetingCard.tsx
import { colorForSpeakerIndex } from '../theme/tokens';
import { api } from '../ipc/client';

interface Meeting {
  id: string;
  title: string;
  startedAt: string | null;
  durationS: number | null;
  pipelineStage: string;
  status: string;
  unidentifiedCount: number;
  actionItemsCount: number;
  speakers: { localLabel: string; displayName: string | null }[];
}

interface Props {
  meeting: Meeting;
  onOpen: (id: string) => void;
  selected: boolean;
  selectMode: boolean;
  onToggleSelect: (id: string) => void;
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

export function MeetingCard({ meeting, onOpen, selected, selectMode, onToggleSelect }: Props): JSX.Element {
  const status = meeting.status;
  const selectable = status === 'pending' || status === 'failed';

  // Per-state treatments — left inset bar + accent elements. See design notes.
  const edge =
    status === 'pending' ? 'before:bg-status-warn' :
    status === 'failed' ? 'before:bg-rose-500' :
    status === 'processing' ? 'before:bg-brand-indigo' :
    'before:bg-transparent';

  return (
    <div
      onClick={() => {
        if (selectMode && selectable) onToggleSelect(meeting.id);
        else onOpen(meeting.id);
      }}
      className={`
        group relative bg-surface border border-surface-border rounded-xl
        px-4 py-3 flex items-center gap-4 cursor-pointer transition
        hover:-translate-y-px hover:border-brand-indigo/60 hover:shadow-pop
        before:content-[''] before:absolute before:left-0 before:top-2 before:bottom-2
        before:w-[3px] before:rounded-r-full ${edge}
        ${status === 'done' ? 'opacity-90' : ''}
        ${selected ? 'ring-2 ring-brand-indigo/50 border-brand-indigo/50' : ''}
      `}
    >
      {/* Selection checkbox — visible when selectable AND (selectMode or hover) */}
      {selectable && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSelect(meeting.id); }}
          aria-label={selected ? 'Deselect meeting' : 'Select meeting'}
          className={`
            w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition
            ${selected
              ? 'bg-brand-indigo border-brand-indigo text-white'
              : 'border-surface-border bg-surface hover:border-brand-indigo'}
            ${selectMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
          `}
        >
          {selected && <CheckIcon />}
        </button>
      )}

      {/* Speaker avatars or state glyph */}
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
              <span className="text-status-warnText">{meeting.unidentifiedCount} to identify</span>
            </>
          )}
        </div>
      </div>

      {/* Right-side actions */}
      {meeting.actionItemsCount > 0 && status === 'done' && (
        <span className="bg-brand-indigo/10 text-brand-indigo text-xs font-semibold px-2 py-0.5 rounded-full">
          {meeting.actionItemsCount}
        </span>
      )}

      <StatusChip meeting={meeting} />
    </div>
  );
}

function CheckIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8l3.5 3.5L13 5" />
    </svg>
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
  if (meeting.status === 'pending') {
    return (
      <div className="w-7 h-7 rounded-full bg-status-warnBg text-status-warnText flex items-center justify-center shrink-0 border-2 border-surface">
        <PendingIcon />
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

function PendingIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="currentColor">
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  );
}

function StatusChip({ meeting }: { meeting: Meeting }): JSX.Element {
  const status = meeting.status;

  if (status === 'pending') {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          void api.meetings.start(meeting.id);
        }}
        className="text-xs font-semibold px-2.5 py-1 rounded-full bg-ink text-surface hover:bg-brand-indigo transition shrink-0"
      >
        ▶ Process
      </button>
    );
  }

  if (status === 'failed') {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          void api.meetings.rerun(meeting.id, 'transcribing');
        }}
        className="text-xs font-semibold px-2.5 py-1 rounded-full bg-rose-500 text-white hover:bg-rose-600 transition shrink-0"
      >
        ↻ Retry
      </button>
    );
  }

  if (status === 'processing') {
    return (
      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-status-processingBg text-status-processing shrink-0 flex items-center gap-1.5">
        <Spinner />
        {meeting.pipelineStage.toUpperCase()}
      </span>
    );
  }

  return (
    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-status-okBg text-status-ok shrink-0">
      DONE
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
