import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import { ModalShell } from './ModalShell';
import { Icon, IconLabel } from './icons';
import { useToast } from './Toasts';
import { requestNavigation } from '../lib/deep-link';
import { groupBriefMarkdown, type GroupBrief as Brief } from '../../../shared/productivity';

/** "Prepare next meeting" for a group: open actions plus the forward-looking
 *  parts of its recent notes. Reads saved notes only; nothing is generated. */
export function GroupBrief({ id, name, onClose, onOpen, onRecord }: {
  id: string; name: string; onClose: () => void; onOpen: (id: string) => void;
  /** Start a recording that will be saved to this group. */
  onRecord?: () => void;
}): JSX.Element {
  const [data, setData] = useState<Brief | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    let alive = true; setError(''); setData(null);
    void api.groups.brief(id).then(value => { if (alive) setData(value); }).catch(error => { if (alive) setError(String(error)); });
    return () => { alive = false; };
  }, [id, retry]);
  const open = (meetingId: string): void => { onClose(); onOpen(meetingId); };
  async function copy(): Promise<void> {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(groupBriefMarkdown(name, data));
      toast.show({ message: 'Brief copied as Markdown', durationMs: 3000 });
    } catch (cause) { toast.show({ message: `Could not copy the brief: ${(cause as Error).message}`, variant: 'error' }); }
  }
  // Checking a task off here is the same action as in Actions; it leaves the
  // list at once and can be undone from the toast.
  async function complete(actionId: string, text: string): Promise<void> {
    setBusy(actionId);
    try {
      await api.actionItems.setStatus(actionId, 'done');
      setData(current => current && { ...current, actions: current.actions.filter(item => item.id !== actionId), openActionCount: Math.max(0, current.openActionCount - 1) });
      toast.show({ message: `Completed: ${text.slice(0, 60)}`, durationMs: 8000, action: { label: 'Undo', onClick: async () => {
        await api.actionItems.setStatus(actionId, 'open'); setRetry(value => value + 1);
      } } });
    } catch (cause) { toast.show({ message: `Could not complete the task: ${(cause as Error).message}`, variant: 'error' }); }
    finally { setBusy(null); }
  }
  return <ModalShell size="lg" labelledBy="group-brief-title" onClose={onClose} className="p-5 flex flex-col">
    <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
      <h2 id="group-brief-title" className="font-semibold">Prepare for {name}</h2>
      <div className="flex flex-wrap items-center gap-2">
        {onRecord && <button type="button" className="btn-secondary" onClick={() => { onClose(); onRecord(); }}><IconLabel icon="record" iconClassName="w-2.5 h-2.5 shrink-0">Record in this group</IconLabel></button>}
        <button type="button" className="btn-secondary" disabled={!data} onClick={() => void copy()}><IconLabel icon="copy">Copy Markdown</IconLabel></button>
        <button type="button" data-dialog-initial-focus onClick={onClose} className="btn-secondary">Close</button>
      </div>
    </div>
    <p className="text-xs text-ink-muted mb-3">Saved notes from the five most recent completed meetings, plus current unfinished tasks. No new AI generation.</p>
    <div className="min-h-0 flex-1 overflow-y-auto space-y-4 pr-2">
      {error && <p role="alert" className="text-sm text-danger">{error} <button className="underline" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
      {!data && !error && <p role="status" className="text-sm text-ink-muted">Loading preparation…</p>}
      {data && <>
        <section>
          <div className="flex items-center justify-between gap-3 mb-2">
            <h3 className="font-semibold text-sm">Open actions · {data.openActionCount}</h3>
            <button type="button" className="text-xs font-semibold text-brand-indigo hover:underline" onClick={() => { onClose(); requestNavigation({ kind: 'actions', groupId: id }); }}>
              <IconLabel icon="arrow-right" className="flex-row-reverse">Open in Actions</IconLabel>
            </button>
          </div>
          {!data.actions.length && <p className="text-xs text-ink-muted">No open actions in this group.</p>}
          <ul className="space-y-2">{data.actions.map(item => <li key={item.id} className="flex items-start gap-2 text-sm border-b border-surface-border pb-2">
            <input type="checkbox" className="mt-1 accent-brand-solid" checked={false} disabled={busy !== null || item.processing}
              aria-label={`Mark done: ${item.text}`} onChange={() => void complete(item.id, item.text)} />
            <div className="min-w-0">
              <p className="break-words">{item.text}</p><p className="text-xs text-ink-muted">{item.ownerName ?? 'Unassigned'}{item.dueDate ? ` · Due ${item.dueDate}` : ''}</p>
              <button type="button" className="text-xs text-brand-indigo text-left hover:underline" onClick={() => open(item.meetingId)}>{item.meetingTitle}<Icon name="arrow-up-right" className="inline w-3 h-3 ml-0.5 align-[-1px]" /></button>
            </div>
          </li>)}</ul>
          {data.openActionCount > data.actions.length && <p className="text-xs text-ink-muted mt-2">Showing the first {data.actions.length}. Open in Actions for the full list.</p>}
        </section>
        {!data.meetings.length && <p className="text-sm text-ink-muted">Complete a meeting in this group to see its decisions and questions here.</p>}
        {data.meetings.map(meeting => {
          // Decisions and Open questions always show (with "None recorded");
          // template-specific sections show only when the notes have them.
          const sections: { heading: string; items: string[]; always: boolean }[] = [
            { heading: 'Decisions', items: meeting.decisions, always: true },
            { heading: 'Open questions', items: meeting.questions, always: true },
            ...(meeting.prep ?? []).map(section => ({ ...section, always: false })),
          ];
          return <section key={meeting.id} className="border-t border-surface-border pt-3 space-y-2">
            <button type="button" className="font-semibold text-brand-indigo text-sm text-left hover:underline" onClick={() => open(meeting.id)}>{meeting.title}<Icon name="arrow-up-right" className="inline w-3.5 h-3.5 ml-0.5 align-[-2px]" /></button>
            <p className="text-xs text-ink-muted">{meeting.startedAt ? new Date(meeting.startedAt).toLocaleDateString() : 'Date unknown'}</p>
            {meeting.missingNotes ? <p className="text-xs text-ink-muted">Saved notes are unavailable.</p> : <p className="text-sm">{meeting.overview}</p>}
            {!meeting.missingNotes && sections.map(({ heading, items, always }) => <div key={heading}>
              <h4 className="text-xs font-semibold">{heading}</h4>
              {items.length ? <ul className="text-sm space-y-1 list-disc pl-4">{items.map((line, index) => <li key={index}>{line}</li>)}</ul>
                : always ? <p className="text-xs text-ink-muted">None recorded in this section.</p> : null}
            </div>)}
          </section>;
        })}
      </>}
    </div>
  </ModalShell>;
}
