// electron/renderer/src/components/InboxRow.tsx
//
// A single pending recording in the Inbox zone. Dense, filename-forward,
// always-visible checkbox. Single "Process" button on the right. Row click
// toggles the checkbox (fastest path to "pick these 5"); clicking the title
// text opens the detail view (rare — pending meetings don't have much to
// look at).
import { api } from '../ipc/client';
import { MeetingRowMenu } from './MeetingRowMenu';

interface Meeting {
  id: string;
  title: string;
  startedAt: string | null;
  durationS: number | null;
  status: string;
  pipelineStage: string;
}

interface Props {
  meeting: Meeting;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onChanged: () => void;
}

function fmtDur(s: number | null): string {
  if (s === null) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, '0')}s`;
  return `${sec}s`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.valueOf())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function InboxRow({ meeting, checked, onToggle, onOpen, onChanged }: Props): JSX.Element {
  async function processOne(e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    await api.meetings.start(meeting.id);
  }

  return (
    <div
      onClick={onToggle}
      className={`
        relative flex items-center gap-3 px-4 py-3 cursor-pointer group transition-colors
        ${checked ? 'bg-brand-indigo/5' : 'hover:bg-surface-sunken'}
      `}
    >
      {/* Checkbox — always visible, not hover-gated */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        aria-label={checked ? 'Deselect' : 'Select'}
        className={`
          w-[18px] h-[18px] rounded-[5px] border-2 shrink-0 flex items-center justify-center
          transition
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

      {/* Monospace title evokes "filename from the filesystem" — reinforces
          that these haven't been processed into proper meetings yet. */}
      <button
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        className="flex-1 min-w-0 text-left"
      >
        <div className="font-mono text-sm text-ink truncate group-hover:text-brand-indigo transition-colors">
          {meeting.title}
        </div>
      </button>

      {/* Meta — right-aligned, tabular so columns line up across rows */}
      <div className="text-[11px] text-ink-muted tabular-nums flex items-center gap-3 shrink-0">
        <span className="w-10 text-right">{fmtDate(meeting.startedAt)}</span>
        <span className="w-14 text-right">{fmtDur(meeting.durationS)}</span>
      </div>

      {/* Per-row action — subtle until hovered */}
      <button
        onClick={processOne}
        className="
          text-xs font-semibold px-3 py-1 rounded-full shrink-0
          bg-surface-sunken text-ink-muted border border-surface-border
          group-hover:bg-ink group-hover:text-surface group-hover:border-ink
          transition
        "
      >
        ▶ Process
      </button>

      <MeetingRowMenu meeting={meeting} onChanged={onChanged} />
    </div>
  );
}
