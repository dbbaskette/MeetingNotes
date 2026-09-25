import { useEffect, useMemo, useRef, useState } from 'react';
import { useGroupsStore } from '../store/groups';

export type GroupChoice = string | null | undefined;

/** undefined = All meetings (scope only); null = Ungrouped. */
export function GroupPicker({
  value, onSelect, allowAll = false, showCounts = false, triggerLabel, compact = false,
}: {
  value: GroupChoice;
  onSelect: (groupId: GroupChoice) => void;
  allowAll?: boolean;
  showCounts?: boolean;
  triggerLabel?: string;
  compact?: boolean;
}): JSX.Element {
  const { groups, allCount, ungroupedCount, loaded, error: loadError, refresh, create } = useGroupsStore();
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const outside = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open, creating]);
  const options = useMemo(() => {
    const all = [
      ...(allowAll ? [{ id: undefined, name: 'All meetings', count: allCount }] : []),
      ...groups.map((group) => ({ id: group.id as GroupChoice, name: group.name, count: group.count })),
      { id: null, name: 'Ungrouped', count: ungroupedCount },
    ];
    return all.filter((option) => option.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  }, [allowAll, groups, allCount, ungroupedCount, search]);
  const selectedName = value === undefined ? 'All meetings' : value === null ? 'Ungrouped'
    : groups.find((group) => group.id === value)?.name ?? (loaded && !loadError ? 'Ungrouped' : 'Loading group…');

  function pick(choice: GroupChoice): void {
    onSelect(choice);
    setOpen(false); setSearch(''); setCreating(false); setError(null);
  }

  async function createGroup(): Promise<void> {
    setBusy(true); setError(null);
    try {
      const group = await create(newName);
      pick(group.id); setNewName('');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div ref={root} className="relative min-w-0" onKeyDown={(event) => {
      if (!open) return;
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
      if (creating) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(index + 1, options.length - 1)); }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
      if (event.key === 'Enter' && options[active]) { event.preventDefault(); pick(options[active].id); }
    }}>
      <button
        type="button" aria-haspopup="listbox" aria-expanded={open}
        title={triggerLabel ?? selectedName}
        onClick={() => {
          const rect = root.current?.getBoundingClientRect();
          setOpenUp(Boolean(rect && window.innerHeight - rect.bottom < 310 && rect.top > 310));
          setOpen((current) => !current); setActive(0); setSearch('');
        }}
        className={`inline-flex max-w-full items-center gap-2 rounded-lg border border-surface-border bg-surface text-ink
          hover:border-brand-indigo/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo/40
          ${compact ? 'px-2 py-1 text-xs' : 'px-3 py-2 text-sm font-semibold'}`}
      >
        <svg viewBox="0 0 20 20" className="w-4 h-4 shrink-0 text-brand-indigo" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M2 5h6l2 2h8v9H2z" /></svg>
        <span className="truncate">{triggerLabel ?? selectedName}</span><span className="text-ink-muted shrink-0">⌄</span>
      </button>
      {open && (
        <div className={`absolute left-0 z-[1000] w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-surface-border bg-surface p-2 shadow-pop
          ${openUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
          {!creating ? <>
            <input ref={searchRef} value={search} onChange={(event) => { setSearch(event.target.value); setActive(0); }}
              aria-label="Find a group" placeholder="Find a group…"
              className="w-full rounded-lg border border-surface-border bg-surface-sunken px-2.5 py-1.5 text-sm outline-none focus:border-brand-indigo" />
            <div role="listbox" aria-label="Groups" className="max-h-52 overflow-y-auto py-1">
              {loadError && <div role="alert" className="px-2 py-2 text-xs text-danger">
                Could not load groups. <button type="button" onClick={() => void refresh()} className="underline">Retry</button>
              </div>}
              {options.map((option, index) => (
                <button key={option.id ?? (option.id === null ? 'ungrouped' : 'all')} type="button"
                  role="option" aria-selected={option.id === value}
                  onMouseEnter={() => setActive(index)} onClick={() => pick(option.id)}
                  className={`w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm
                    ${active === index ? 'bg-brand-indigo/10 text-brand-indigo' : 'hover:bg-surface-sunken'}`}>
                  <span className="min-w-0 flex-1 truncate" title={option.name}>{option.name}</span>
                  {showCounts && <span className="text-xs text-ink-muted tabular-nums">{option.count}</span>}
                </button>
              ))}
              {options.length === 0 && <div className="px-2 py-3 text-xs text-ink-muted">No groups found.</div>}
            </div>
            <div className="border-t border-surface-border pt-1">
              <button type="button" onClick={() => { setCreating(true); setError(null); }}
                className="w-full text-left px-2.5 py-1.5 text-sm font-semibold text-brand-indigo hover:bg-surface-sunken rounded-md">+ New group…</button>
            </div>
          </> : <form onSubmit={(event) => { event.preventDefault(); void createGroup(); }}>
            <label className="block text-xs font-semibold mb-1" htmlFor="new-group-name">New group</label>
            <input id="new-group-name" ref={searchRef} maxLength={80} value={newName} onChange={(event) => setNewName(event.target.value)}
              placeholder="Group name" className="w-full rounded-lg border border-surface-border px-2.5 py-1.5 text-sm outline-none focus:border-brand-indigo" />
            {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => setCreating(false)} className="text-xs text-ink-muted px-2 py-1">Cancel</button>
              <button disabled={busy || !newName.trim()} className="rounded-lg bg-brand-indigo px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">Create</button>
            </div>
          </form>}
        </div>
      )}
    </div>
  );
}
