import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import { ModalShell } from './ModalShell';
import type { GroupBrief as Brief } from '../../../shared/productivity';

export function GroupBrief({ id, name, onClose, onOpen }: { id: string; name: string; onClose: () => void; onOpen: (id: string) => void }): JSX.Element {
  const [data, setData] = useState<Brief | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true; setError(''); setData(null);
    void api.groups.brief(id).then(value => { if (alive) setData(value); }).catch(error => { if (alive) setError(String(error)); });
    return () => { alive = false; };
  }, [id, retry]);
  const open = (meetingId: string): void => { onClose(); onOpen(meetingId); };
  return <ModalShell title={`Prepare for ${name}`} onClose={onClose}>
    <div className="flex items-start justify-between gap-3 mb-3"><h2 className="font-semibold">Prepare for {name}</h2><button onClick={onClose} className="text-sm text-brand-indigo">Close</button></div>
    <p className="text-xs text-ink-muted mb-3">Saved notes from the five most recent completed meetings, plus current unfinished tasks. No new AI generation.</p>
    <div className="max-h-[65vh] overflow-y-auto space-y-4 pr-2">
      {error && <p role="alert" className="text-sm text-danger">{error} <button className="underline" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
      {!data && !error && <p role="status">Loading preparation…</p>}
      {data && <>
        <section><h3 className="font-semibold text-sm mb-2">Open actions · {data.openActionCount}</h3>
          {!data.actions.length && <p className="text-xs text-ink-muted">No open actions in this group.</p>}
          <ul className="space-y-2">{data.actions.map(item => <li key={item.id} className="text-sm border-b border-surface-border pb-2">
            <p>{item.text}</p><p className="text-xs text-ink-muted">{item.ownerName ?? 'Unassigned'}{item.dueDate ? ` · Due ${item.dueDate}` : ''}</p>
            <button className="text-xs text-brand-indigo text-left" onClick={() => open(item.meetingId)}>{item.meetingTitle} ↗</button>
          </li>)}</ul>
          {data.openActionCount > data.actions.length && <p className="text-xs text-ink-muted">Showing the first {data.actions.length}. See Actions for the full list.</p>}
        </section>
        {!data.meetings.length && <p className="text-sm text-ink-muted">Complete a meeting in this group to see its decisions and questions here.</p>}
        {data.meetings.map(meeting => <section key={meeting.id} className="border-t border-surface-border pt-3 space-y-2">
          <button className="font-semibold text-brand-indigo text-sm text-left" onClick={() => open(meeting.id)}>{meeting.title} ↗</button>
          <p className="text-xs text-ink-muted">{meeting.startedAt ? new Date(meeting.startedAt).toLocaleDateString() : 'Date unknown'}</p>
          {meeting.missingNotes ? <p className="text-xs text-ink-muted">Saved notes are unavailable.</p> : <p className="text-sm">{meeting.overview}</p>}
          {([['Decisions', meeting.decisions], ['Open questions', meeting.questions]] as const).map(([title, lines]) => <div key={title}>
            <h4 className="text-xs font-semibold">{title}</h4>
            {lines.length ? <ul className="text-sm space-y-1">{lines.map((line, index) => <li key={index}>• {line}</li>)}</ul> : <p className="text-xs text-ink-muted">None recorded in this section.</p>}
          </div>)}
        </section>)}
      </>}
    </div>
  </ModalShell>;
}
