import { useRef, useState } from 'react';
import { ModalShell } from './ModalShell';
import { LineDiff } from './LineDiff';
import { api } from '../ipc/client';
import type { NotesVersion, NotesComparison } from '../../../shared/notes-history';
const button = 'rounded-md border border-surface-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-sunken disabled:opacity-40';

export function NotesHistory({ meetingId, disabled, onRestored }: {meetingId: string; disabled: boolean; onRestored: (summary: string) => Promise<void>}): JSX.Element {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<Omit<NotesVersion, 'summary' | 'items'>[]>([]);
  const [comparison, setComparison] = useState<NotesComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  async function perform(action: () => Promise<void>): Promise<void> {
    setBusy(true); setError(null);
    try { await action(); } catch(e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
    finally { setBusy(false); }
  }
  function close(): void { if (busy) return; setOpen(false); setComparison(null); trigger.current?.focus(); }
  return <>
    <button ref={trigger} className={`${button} self-start`} disabled={disabled} onClick={() => { setOpen(true); void perform(async () => setVersions(await api.notesHistory.list(meetingId))); }}>Notes &amp; action-item history…</button>
    {open && <ModalShell size="xl" labelledBy="notes-history-title" busy={busy} onClose={close} className="p-6 overflow-y-auto">
      <div className="flex justify-between items-center gap-4 mb-4"><h2 id="notes-history-title" className="text-lg font-semibold">Previous notes &amp; action items</h2><button className={button} disabled={busy} onClick={close}>Close</button></div>
      <p className="text-xs text-ink-muted mb-4">The latest 20 versions are kept automatically before edits, regeneration, re-extraction, and restore. Restoring also preserves the current version.</p>
      {error && <p role="alert" className="text-sm text-danger mb-3">{error}</p>}
      {!comparison ? <div className="space-y-2 max-h-[55vh] overflow-auto">
        {!versions.length && <p role="status" className="text-sm text-ink-muted">{busy ? 'Loading…' : 'No previous versions yet.'}</p>}
        {versions.map(version => <button key={version.id} disabled={busy} className={`${button} w-full text-left`} onClick={() => void perform(async () => setComparison(await api.notesHistory.compare(meetingId, version.id)))}>{new Date(version.createdAt).toLocaleString()} — {version.reason}</button>)}
      </div> : <>
        {/* What restoring would change: lines only in the current notes are
            removed by a restore, lines only in the selected version come back. */}
        <h3 className="font-semibold mb-2 text-sm">Notes</h3>
        <LineDiff before={comparison.current.summary} after={comparison.previous.summary} beforeLabel="the current version" afterLabel="the selected version" />
        <div className="grid md:grid-cols-2 gap-4 mt-4">
          {[comparison.current, comparison.previous].map((version,index) => <section key={index} className="min-w-0">
            <h3 className="font-semibold mb-2 text-sm">{index ? 'Selected version' : 'Current version'} · action items ({version.items.length})</h3>
            <div className="max-h-[22vh] overflow-auto rounded-md border border-surface-border p-3 text-sm">
              {version.items.length === 0 ? <p className="text-xs text-ink-muted">No action items.</p>
                : <ul className="list-disc pl-4 space-y-2">{version.items.map(item => <li key={item.id}>{item.text}<div className="text-xs text-ink-muted">{item.status} · {item.ownerName ?? 'Unassigned'}{item.dueDate ? ` · ${item.dueDate}` : ''}</div></li>)}</ul>}
            </div>
          </section>)}
        </div>
        <p className="text-xs text-ink-muted mt-4">Restore replaces both notes and action items, including completion status and ownership. Audio and transcript stay unchanged.</p>
        <div className="flex gap-2 mt-3"><button className={button} disabled={busy} onClick={() => setComparison(null)}>Back</button>
          <button className={button} disabled={busy || disabled} onClick={() => void perform(async () => { await api.notesHistory.restore(meetingId, comparison.previous.id, comparison.revision); await onRestored(comparison.previous.summary); setOpen(false); setComparison(null); trigger.current?.focus(); })}>{busy ? 'Restoring…' : 'Restore selected version'}</button></div>
      </>}
    </ModalShell>}
  </>;
}
