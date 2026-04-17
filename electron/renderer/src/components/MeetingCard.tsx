// electron/renderer/src/components/MeetingCard.tsx
import { colorForSpeakerIndex } from '../theme/tokens';

interface Props {
  meeting: {
    id: string;
    title: string;
    startedAt: string | null;
    durationS: number | null;
    pipelineStage: string;
    unidentifiedCount: number;
    actionItemsCount: number;
    speakers: { localLabel: string; displayName: string | null }[];
  };
  onOpen: (id: string) => void;
}

function fmtDur(s: number | null): string {
  if (s === null) return '';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60)
    .toString()
    .padStart(2, '0');
  return `${m}m ${sec}s`;
}

export function MeetingCard({ meeting, onOpen }: Props): JSX.Element {
  const processing = meeting.pipelineStage !== 'done';
  return (
    <div
      onClick={() => onOpen(meeting.id)}
      className="bg-surface border border-surface-border rounded-xl p-4 flex items-center gap-4 cursor-pointer hover:-translate-y-px hover:border-brand-indigo hover:shadow-pop transition"
    >
      <div className="flex">
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
      <div className="flex-1">
        <div className="font-semibold text-sm">{meeting.title}</div>
        <div className="text-xs text-ink-muted">
          {meeting.startedAt?.slice(0, 10) ?? ''} · {fmtDur(meeting.durationS)}
          {meeting.unidentifiedCount > 0 && (
            <span className="ml-1 text-status-warnText">
              · {meeting.unidentifiedCount} to identify
            </span>
          )}
        </div>
      </div>
      {meeting.actionItemsCount > 0 && (
        <div className="bg-brand-indigo text-white text-xs font-semibold px-2 py-0.5 rounded-xl">
          {meeting.actionItemsCount} actions
        </div>
      )}
      <span
        className={`text-xs font-semibold px-2 py-0.5 rounded-xl
        ${processing ? 'bg-status-processingBg text-status-processing' : 'bg-status-okBg text-status-ok'}`}
      >
        {processing ? meeting.pipelineStage.toUpperCase() : 'DONE'}
      </span>
    </div>
  );
}
