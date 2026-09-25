import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { useGroupsStore } from '../store/groups';
import { useToast } from './Toasts';
import { ModalShell } from './ModalShell';
import { assignGroupInBatches } from '../lib/group-assignment';

export function MoveToGroupDialog({ ids, onClose, onChanged }: {
  ids: string[];
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const { groups, loaded, refresh, create } = useGroupsStore();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);
  useEffect(() => { input.current?.focus(); }, [creating]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const filtered = useMemo(() => groups.filter((group) =>
    group.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [groups, search]);

  async function move(groupId: string | null): Promise<void> {
    setBusy(true); setError(null);
    try {
      const result = await assignGroupInBatches(ids, groupId, api.groups.assign);
      const moved = result.moved.length;
      const failures = result.failedIds.length;
      if (moved === 0 && failures > 0) {
        setError(`Could not move ${failures} meeting${failures === 1 ? '' : 's'}. Check the group and retry.`);
        setBusy(false);
        await refresh();
        return;
      }
      await refresh();
      onChanged(); onClose();
      if (moved === 0 && failures === 0) {
        toast.show({ message: 'Meetings are already in that group.' });
        return;
      }
      toast.show({
        message: `${moved} meeting${moved === 1 ? '' : 's'} moved${failures ? `; ${failures} could not be moved` : ''}.`,
        variant: failures ? 'error' : 'default', durationMs: 10_000,
        action: moved ? { label: 'Undo', onClick: async () => {
          const byPrevious = new Map<string | null, string[]>();
          for (const item of result.moved) {
            const list = byPrevious.get(item.previousGroupId) ?? [];
            list.push(item.id); byPrevious.set(item.previousGroupId, list);
          }
          const outcomes = await Promise.allSettled([...byPrevious].map(([previousId, groupIds]) =>
            assignGroupInBatches(groupIds, previousId, api.groups.assign, groupId)));
          const restored = outcomes.reduce((count, outcome) => count +
            (outcome.status === 'fulfilled' ? outcome.value.moved.length : 0), 0);
          await refresh(); onChanged();
          if (restored < moved) toast.show({ message: `Restored ${restored} of ${moved} group assignments.`, variant: 'error' });
        } } : undefined,
      });
    } catch (cause) { setError((cause as Error).message); setBusy(false); }
  }

  async function createAndMove(): Promise<void> {
    setBusy(true); setError(null);
    try {
      const group = await create(name);
      setCreating(false);
      await move(group.id);
    } catch (cause) { setError((cause as Error).message); setBusy(false); }
  }

  return <ModalShell onClose={onClose}>
    <div className="text-sm font-semibold mb-1">Move {ids.length} meeting{ids.length === 1 ? '' : 's'} to group</div>
    <p className="text-xs text-ink-muted mb-3">This changes Library organization only. Audio and notes stay in place.</p>
    {creating ? <form onSubmit={(event) => { event.preventDefault(); void createAndMove(); }}>
      <label htmlFor="move-new-group" className="text-xs font-semibold">New group name</label>
      <input id="move-new-group" ref={input} maxLength={80} value={name} onChange={(event) => setName(event.target.value)}
        className="mt-1 w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:border-brand-indigo" />
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={() => setCreating(false)} className="px-3 py-1.5 text-sm text-ink-muted">Back</button>
        <button disabled={busy || !name.trim()} className="rounded-lg bg-brand-indigo px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">Create and move</button>
      </div>
    </form> : <>
      <input ref={input} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a group…" aria-label="Find a group"
        className="w-full rounded-lg border border-surface-border bg-surface-sunken px-3 py-2 text-sm focus:outline-none focus:border-brand-indigo" />
      <div className="mt-2 max-h-64 overflow-y-auto">
        <button disabled={busy} type="button" onClick={() => void move(null)} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-sunken disabled:opacity-50">Ungrouped</button>
        {filtered.map((group) => <button key={group.id} disabled={busy} type="button" onClick={() => void move(group.id)}
          className="w-full flex items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-brand-indigo/10 disabled:opacity-50">
          <span className="min-w-0 flex-1 truncate" title={group.name}>{group.name}</span>
          <span className="ml-2 text-xs text-ink-muted tabular-nums">{group.count}</span>
        </button>)}
        {filtered.length === 0 && <div className="px-3 py-2 text-xs text-ink-muted">No groups found.</div>}
      </div>
      <button type="button" onClick={() => setCreating(true)} className="mt-2 border-t border-surface-border w-full px-3 pt-2 text-left text-sm font-semibold text-brand-indigo">+ New group…</button>
      <div className="mt-3 flex justify-end"><button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-ink-muted">Cancel</button></div>
    </>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </ModalShell>;
}
