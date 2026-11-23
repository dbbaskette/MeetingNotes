import { useCallback, useEffect, useState } from 'react';
import { api } from '../ipc/client';
import type { NavTarget } from '../components/AppNav';
import { AppHeader, APP_SHELL_CLASS } from '../components/AppHeader';
import { Icon } from '../components/icons';
import { useToast } from '../components/Toasts';
import { requestNavigation } from '../lib/deep-link';
import type { ActionFilter, ActionPage, LiveAction } from '../../../shared/productivity';

const UNGROUPED = '__ungrouped__';
const stripIpc = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

/** Local date as YYYY-MM-DD, `days` from today. */
function localDate(days = 0): string {
  const d = new Date(); d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ActionsView({ onNav, onOpen, initialGroupId }: {
  onNav: (target: NavTarget) => void; onOpen: (id: string) => void;
  /** Deep link from "Prepare next meeting": start filtered to this group and to everyone's actions. */
  initialGroupId?: string | null;
}): JSX.Element {
  const [filter, setFilter] = useState<ActionFilter>(() => initialGroupId
    ? { owner: 'all', due: 'all', offset: 0, groupId: initialGroupId }
    : { owner: 'mine', due: 'all', offset: 0 });
  const [data, setData] = useState<ActionPage | null>(null), [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState(''), [refreshing, setRefreshing] = useState(true), [revision, setRevision] = useState(0), [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const toast = useToast();
  const loadingInitial = refreshing && data === null;
  const reload = useCallback((): void => setRevision(value => value + 1), []);
  useEffect(() => { void api.groups.list().then(result => setGroups(result.groups)).catch(error => setError(stripIpc(error))); }, []);
  useEffect(() => {
    const off = api.pipeline.onMeetingStageChange(reload);
    const timer = window.setInterval(() => { if (!document.hidden) reload(); }, 15000);
    return () => { off(); window.clearInterval(timer); };
  }, [reload]);
  useEffect(() => {
    let alive = true; setRefreshing(true); setError('');
    void api.actionItems.list(filter).then(value => { if (alive) setData(value); }).catch(error => { if (alive) setError(stripIpc(error)); }).finally(() => { if (alive) setRefreshing(false); });
    return () => { alive = false; };
  }, [filter, revision]);
  // The previous page stays on screen while the next loads, so the owner list
  // (and the selected owner) never blank out between filter changes.
  function change(patch: Partial<ActionFilter>): void { setEditing(null); setFilter(current => ({ ...current, ...patch, offset: 0 })); }

  /** Complete a task. It leaves the open list at once, so offer Undo (#298). */
  async function complete(item: LiveAction): Promise<void> {
    setBusy(item.id); setError('');
    try {
      await api.actionItems.setStatus(item.id, 'done');
      setData(current => current && { ...current, items: current.items.filter(row => row.id !== item.id), total: Math.max(0, current.total - 1) });
      toast.show({ message: `Completed: ${item.text.slice(0, 60)}${item.text.length > 60 ? '…' : ''}`, durationMs: 8000,
        action: { label: 'Undo', onClick: async () => {
          try { await api.actionItems.setStatus(item.id, 'open'); reload(); }
          catch (cause) { toast.show({ message: `Could not undo: ${stripIpc(cause)}`, variant: 'error' }); }
        } } });
      reload();
    } catch (cause) { setError(stripIpc(cause)); }
    finally { setBusy(null); }
  }
  async function update(item: LiveAction, patch: { text?: string; ownerName?: string | null; dueDate?: string | null }, done?: string): Promise<boolean> {
    setBusy(item.id); setError('');
    try { await api.actionItems.update(item.id, patch); if (done) toast.show({ message: done, durationMs: 3000 }); reload(); return true; }
    catch (cause) { setError(stripIpc(cause)); return false; }
    finally { setBusy(null); }
  }
  async function remove(item: LiveAction): Promise<void> {
    setBusy(item.id); setError('');
    try {
      const token = await api.actionItems.delete(item.id);
      setEditing(null); reload();
      toast.show({ message: 'Action deleted', durationMs: 8000, ...(token ? { action: { label: 'Undo', onClick: async () => {
        try { await api.actionItems.undoDelete(token); reload(); }
        catch (cause) { toast.show({ message: `Could not undo: ${stripIpc(cause)}`, variant: 'error' }); }
      } } } : {}) });
    } catch (cause) { setError(stripIpc(cause)); }
    finally { setBusy(null); }
  }

  const today = localDate();
  const groupValue = filter.ungrouped ? UNGROUPED : filter.groupId ?? '';
  return <div className={APP_SHELL_CLASS}>
    <AppHeader active="actions" onNav={onNav} className="mb-5" />
    <div className="shrink-0 py-4 border-b border-surface-border space-y-3">
      <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Actions</h2><button type="button" className="btn-secondary" onClick={reload} disabled={refreshing}>Refresh</button></div>
      <p className="text-xs text-ink-muted">Current open actions across all meeting dates. Saved weekly reports remain unchanged.</p>
      <div className="flex flex-wrap gap-3 text-sm">
        <label>Owner <select className="input !w-auto" value={filter.owner} onChange={event => change({ owner: event.target.value })}>
          <option value="mine">My actions</option><option value="all">Everyone</option>
          {/* Keep a selected owner listed even if their last open action was just completed. */}
          {[...new Set([...(data?.owners ?? []), ...(filter.owner && filter.owner !== 'mine' && filter.owner !== 'all' ? [filter.owner] : [])])].map(name => <option key={name} value={name}>{name}</option>)}
        </select></label>
        <label>Group <select className="input !w-auto" value={groupValue}
          onChange={event => change(event.target.value === UNGROUPED ? { groupId: undefined, ungrouped: true } : { groupId: event.target.value || undefined, ungrouped: undefined })}>
          <option value="">All groups</option><option value={UNGROUPED}>Ungrouped</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select></label>
        <label>Due <select className="input !w-auto" value={filter.due} onChange={event => change({ due: event.target.value as ActionFilter['due'] })}>
          <option value="all">Any date</option><option value="overdue">Overdue</option><option value="soon">Next 7 days</option><option value="undated">No due date</option>
        </select></label>
      </div>
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto py-4 space-y-3" aria-busy={loadingInitial}>
      {error && <p role="alert" className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-text">{error} <button type="button" className="underline font-semibold" onClick={reload}>Retry</button></p>}
      {loadingInitial && <p role="status" className="text-sm text-ink-muted">Loading actions…</p>}
      {data && !data.identified && filter.owner === 'mine' && <p className="text-sm text-ink-muted">
        <button type="button" className="font-semibold text-brand-indigo underline" onClick={() => requestNavigation({ kind: 'settings', section: 'Organization' })}>Choose yourself in Settings → Organization</button> to see your actions, or select Everyone.
      </p>}
      {data && !data.items.length && !refreshing && <p className="text-sm text-ink-muted">No open actions match these filters.</p>}
      {data?.items.map(item => {
        const overdue = !!item.dueDate && item.dueDate < today;
        const locked = busy !== null || item.processing;
        return <div key={item.id} className="border-b border-surface-border pb-3">
          <div className="flex gap-3">
            <input type="checkbox" className="mt-1 accent-brand-solid" aria-label={`Mark done: ${item.text}`} disabled={locked} checked={false} onChange={() => void complete(item)} />
            <div className="min-w-0 flex-1"><p className="text-sm break-words">{item.text}</p>
              <p className="text-xs text-ink-muted mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span>{item.ownerName ?? 'Unassigned'}</span><span aria-hidden="true">·</span>
                {overdue
                  ? <span className="rounded-full bg-danger-bg px-2 py-0.5 font-semibold text-danger-text">Overdue · was due {item.dueDate}</span>
                  : <span>{item.dueDate ? `Due ${item.dueDate}` : 'No due date'}</span>}
                {item.groupName && <><span aria-hidden="true">·</span><span>{item.groupName}</span></>}
                {item.processing && <><span aria-hidden="true">·</span><span>Processing — editing paused</span></>}
              </p>
              <button type="button" onClick={() => onOpen(item.meetingId)} className="text-xs text-brand-indigo text-left mt-1 hover:underline">{item.meetingTitle}<Icon name="arrow-up-right" className="inline w-3 h-3 ml-0.5 align-[-1px]" /></button>
            </div>
            <div className="shrink-0 flex items-start gap-1.5">
              <button type="button" className="btn-secondary" disabled={locked} title="Move the due date one week out" onClick={() => void update(item, { dueDate: localDate(7) }, 'Snoozed one week')}>Snooze</button>
              <button type="button" className="btn-secondary" disabled={locked} aria-expanded={editing === item.id} onClick={() => setEditing(current => current === item.id ? null : item.id)}>{editing === item.id ? 'Close' : 'Edit'}</button>
            </div>
          </div>
          {editing === item.id && <ActionEditor item={item} busy={busy === item.id}
            onSave={async patch => { if (await update(item, patch, 'Action updated')) setEditing(null); }}
            onDelete={() => void remove(item)} onCancel={() => setEditing(null)} />}
        </div>;
      })}
    </div>
    {data && <footer className="shrink-0 flex items-center gap-4 py-3 text-sm border-t border-surface-border">
      <span>{data.total} open actions</span>
      <button type="button" className="btn-secondary" disabled={loadingInitial || !(filter.offset ?? 0)} onClick={() => setFilter(current => ({ ...current, offset: Math.max(0, (current.offset ?? 0) - 100) }))}>Previous</button>
      <button type="button" className="btn-secondary" disabled={loadingInitial || (filter.offset ?? 0) + 100 >= data.total} onClick={() => setFilter(current => ({ ...current, offset: (current.offset ?? 0) + 100 }))}>Next</button>
    </footer>}
  </div>;
}

/** Inline editor for one action: text, owner and due date, plus delete. */
function ActionEditor({ item, busy, onSave, onDelete, onCancel }: {
  item: LiveAction; busy: boolean;
  onSave: (patch: { text?: string; ownerName?: string | null; dueDate?: string | null }) => void | Promise<void>;
  onDelete: () => void; onCancel: () => void;
}): JSX.Element {
  const [text, setText] = useState(item.text), [owner, setOwner] = useState(item.ownerName ?? ''), [due, setDue] = useState(item.dueDate ?? '');
  const patch = {
    ...(text.trim() !== item.text ? { text: text.trim() } : {}),
    ...(owner.trim() !== (item.ownerName ?? '') ? { ownerName: owner.trim() || null } : {}),
    ...(due !== (item.dueDate ?? '') ? { dueDate: due || null } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  return <form className="mt-2 ml-7 rounded-lg border border-surface-border bg-surface-sunken/60 p-3 space-y-2"
    onSubmit={event => { event.preventDefault(); if (dirty && text.trim()) void onSave(patch); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}>
    <textarea aria-label="Action item" className="input" rows={2} maxLength={2000} value={text} disabled={busy} onChange={event => setText(event.target.value)} autoFocus />
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="inline-flex items-center gap-1.5">Owner <input className="input-sm max-w-40" maxLength={200} value={owner} disabled={busy} onChange={event => setOwner(event.target.value)} /></label>
      <label className="inline-flex items-center gap-1.5">Due <input className="input-sm" type="date" value={due} disabled={busy} onChange={event => setDue(event.target.value)} /></label>
      {due && <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDue('')}>Clear date</button>}
      <span className="flex-1" />
      <button type="button" className="text-xs font-semibold text-danger-text hover:underline disabled:opacity-50" disabled={busy} onClick={onDelete}>Delete</button>
      <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="submit" className="btn-primary px-2.5 py-1 text-xs" disabled={busy || !dirty || !text.trim()}>{busy ? 'Saving…' : 'Save'}</button>
    </div>
  </form>;
}
