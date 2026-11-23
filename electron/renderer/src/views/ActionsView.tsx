import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import type { NavTarget } from '../components/AppNav';
import { AppHeader } from '../components/AppHeader';
import type { ActionFilter, ActionPage } from '../../../shared/productivity';

export function ActionsView({ onNav, onOpen }: { onNav: (target: NavTarget) => void; onOpen: (id: string) => void }): JSX.Element {
  const [filter, setFilter] = useState<ActionFilter>({ owner: 'mine', due: 'all', offset: 0 });
  const [data, setData] = useState<ActionPage | null>(null), [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState(''), [refreshing, setRefreshing] = useState(true), [revision, setRevision] = useState(0), [busy, setBusy] = useState<string | null>(null);
  const loadingInitial = refreshing && data === null;
  useEffect(() => { void api.groups.list().then(result => setGroups(result.groups)).catch(error => setError(String(error))); }, []);
  useEffect(() => {
    const off = api.pipeline.onMeetingStageChange(() => setRevision(value => value + 1));
    const timer = window.setInterval(() => { if (!document.hidden) setRevision(value => value + 1); }, 15000);
    return () => { off(); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    let alive = true; setRefreshing(true); setError('');
    void api.actionItems.list(filter).then(value => { if (alive) setData(value); }).catch(error => { if (alive) setError(String(error)); }).finally(() => { if (alive) setRefreshing(false); });
    return () => { alive = false; };
  }, [filter, revision]);
  function change(patch: Partial<ActionFilter>): void { setFilter(current => ({ ...current, ...patch, offset: 0 })); }
  return <div className="app-view w-full h-full flex flex-col max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-8">
    <AppHeader active="actions" onNav={onNav} className="mb-5" />
    <div className="shrink-0 py-4 border-b border-surface-border space-y-3">
      <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Actions</h2><button className="text-sm text-brand-indigo" onClick={() => setRevision(value => value + 1)} disabled={refreshing}>Refresh</button></div>
      <p className="text-xs text-ink-muted">Current open actions across all meeting dates. Saved weekly reports remain unchanged.</p>
      <div className="flex flex-wrap gap-3 text-sm">
        <label>Owner <select className="input !w-auto" value={filter.owner} onChange={event => change({ owner: event.target.value })}>
          <option value="mine">My actions</option><option value="all">Everyone</option>{data?.owners.map(name => <option key={name} value={name}>{name}</option>)}
        </select></label>
        <label>Group <select className="input !w-auto" value={filter.groupId ?? ''} onChange={event => change({ groupId: event.target.value || undefined })}>
          <option value="">All groups</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select></label>
        <label>Due <select className="input !w-auto" value={filter.due} onChange={event => change({ due: event.target.value as ActionFilter['due'] })}>
          <option value="all">Any date</option><option value="overdue">Overdue</option><option value="soon">Next 7 days</option><option value="undated">No due date</option>
        </select></label>
      </div>
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto py-4 space-y-3" aria-busy={loadingInitial}>
      {error && <p role="alert" className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-text">{error} <button className="underline font-semibold" onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
      {loadingInitial && <p role="status" className="text-sm text-ink-muted">Loading actions…</p>}
      {data && !data.identified && filter.owner === 'mine' && <p className="text-sm text-ink-muted">Choose yourself under Settings → Speakers to see your actions, or select Everyone.</p>}
      {data && !data.items.length && !refreshing && <p className="text-sm text-ink-muted">No open actions match these filters.</p>}
      {data?.items.map(item => <div key={item.id} className="flex gap-3 border-b border-surface-border pb-3">
        <input type="checkbox" className="mt-1 accent-brand-solid" aria-label={`Mark done: ${item.text}`} disabled={busy !== null || item.processing} checked={false} onChange={() => {
          setBusy(item.id); setError('');
          void api.actionItems.setStatus(item.id, 'done').then(() => setRevision(value => value + 1)).catch(error => setError(String(error))).finally(() => setBusy(null));
        }} />
        <div className="min-w-0"><p className="text-sm break-words">{item.text}</p>
          <p className="text-xs text-ink-muted mt-1">{item.ownerName ?? 'Unassigned'} · {item.dueDate ? `Due ${item.dueDate}` : 'No due date'}{item.groupName ? ` · ${item.groupName}` : ''}{item.processing ? ' · Processing—editing paused' : ''}</p>
          <button onClick={() => onOpen(item.meetingId)} className="text-xs text-brand-indigo text-left mt-1">{item.meetingTitle} ↗</button>
        </div>
      </div>)}
    </div>
    {data && <footer className="shrink-0 flex items-center gap-4 py-3 text-sm border-t border-surface-border">
      <span>{data.total} open actions</span>
      <button className="btn-secondary" disabled={loadingInitial || !(filter.offset ?? 0)} onClick={() => setFilter(current => ({ ...current, offset: Math.max(0, (current.offset ?? 0) - 100) }))}>Previous</button>
      <button className="btn-secondary" disabled={loadingInitial || (filter.offset ?? 0) + 100 >= data.total} onClick={() => setFilter(current => ({ ...current, offset: (current.offset ?? 0) + 100 }))}>Next</button>
    </footer>}
  </div>;
}
