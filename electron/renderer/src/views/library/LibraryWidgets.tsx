// electron/renderer/src/views/library/LibraryWidgets.tsx
//
// Small presentational pieces of the Library view, moved out of
// LibraryView.tsx unchanged (#256).
import { useEffect, useRef, useState } from 'react';
import { ModalShell } from '../../components/ModalShell';
import { Icon } from '../../components/icons';
import { fmtDeletedAgo, type TrashedMeeting } from '../../lib/trash-view';
import { shortcutMod } from '../../lib/shortcut';
import type { LibFilter } from './types';

export function GroupNameDialog({ mode, name, error, busy, onClose, onSave }: {
  mode: 'create' | 'rename';
  name: string;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}): JSX.Element {
  const [value, setValue] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <ModalShell title={mode === 'create' ? 'Create group' : 'Rename group'} busy={busy} onClose={onClose}>
    <form onSubmit={(event) => { event.preventDefault(); void onSave(value); }}>
      <label htmlFor="group-name" className="block text-sm font-semibold mb-2">{mode === 'create' ? 'New group' : 'Rename group'}</label>
      <input id="group-name" ref={input} maxLength={80} value={value} onChange={(event) => setValue(event.target.value)}
        className="w-full rounded-lg border border-surface-border bg-surface text-ink px-3 py-2 text-sm focus:outline-none focus:border-brand-indigo" />
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-ink-muted">Cancel</button>
        <button disabled={busy || !value.trim()} className="rounded-lg bg-brand-solid px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Saving…' : mode === 'create' ? 'Create group' : 'Save name'}
        </button>
      </div>
    </form>
  </ModalShell>;
}

export function LibraryRetryRow({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div role="alert" className="py-4 text-center text-sm text-ink-muted">
      <span>{message}</span>{' '}
      <button type="button" className="font-semibold text-brand-indigo underline" onClick={onRetry}>Retry</button>
    </div>
  );
}

/** Muted "Recently deleted (N)" affordance at the bottom of the Library.
 *  Collapsed by default; expanding lists the trashed meetings with a
 *  Restore button each. Renders nothing when the trash is empty — no
 *  permanent chrome for a state most sessions never enter. */
export function TrashSection({
  trash, onRestore,
}: {
  trash: TrashedMeeting[];
  onRestore: (m: TrashedMeeting) => Promise<void>;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  if (trash.length === 0) return null;
  return (
    <div className="shrink-0 border-t border-surface-border pt-2 pb-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-ink-muted hover:text-ink transition px-1 py-1"
      >
        <svg
          viewBox="0 0 16 16"
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        Recently deleted ({trash.length})
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {trash.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-sunken/40 border border-surface-border/60"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-ink-muted truncate">{m.title}</div>
                <div className="text-[11px] text-ink-muted/70">
                  Deleted {fmtDeletedAgo(m.deletedAt)}
                </div>
              </div>
              <button
                type="button"
                disabled={busyId === m.id}
                onClick={() => {
                  setBusyId(m.id);
                  void onRestore(m).finally(() => setBusyId(null));
                }}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-surface border border-surface-border text-ink-muted hover:text-ink hover:border-ink/40 transition disabled:opacity-50 shrink-0"
              >
                {busyId === m.id ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SearchSectionHeader({
  label, count, sort, onSortChange,
}: {
  label: string;
  count: number;
  /** Optional — only the Content section gets a sort toggle. */
  sort?: 'recent' | 'count';
  onSortChange?: (s: 'recent' | 'count') => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 pt-2 first:pt-0 pb-1">
      <h3 className="font-mono text-[10px] tracking-[0.2em] uppercase text-ink-muted">
        {label}
      </h3>
      <span className="text-[11px] text-ink-muted/80 tabular-nums">{count}</span>
      <div className="flex-1 border-b border-surface-border" />
      {sort && onSortChange && (
        <div className="flex items-center gap-1 text-[10px] font-mono tracking-wider uppercase">
          <button
            type="button" aria-pressed={sort === 'recent'}
            onClick={() => onSortChange('recent')}
            className={`px-1.5 py-0.5 rounded ${sort === 'recent' ? 'bg-ink text-surface' : 'text-ink-muted hover:text-ink'}`}
          >
            Recent
          </button>
          <button
            type="button" aria-pressed={sort === 'count'}
            onClick={() => onSortChange('count')}
            className={`px-1.5 py-0.5 rounded ${sort === 'count' ? 'bg-ink text-surface' : 'text-ink-muted hover:text-ink'}`}
          >
            Most matches
          </button>
        </div>
      )}
    </div>
  );
}

export function FilterChip({
  active, onClick, label, n, dotClass,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  n: number;
  dotClass?: string;
}): JSX.Element {
  const disabled = n === 0 && !active;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`
        inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full
        transition border
        ${active
          ? 'bg-ink text-surface border-ink'
          : disabled
            ? 'bg-surface text-ink-muted/60 border-surface-border opacity-50 cursor-not-allowed'
            : 'bg-surface text-ink-muted border-surface-border hover:text-ink hover:border-ink/30'}
      `}
    >
      {dotClass && <span className={`w-1.5 h-1.5 rounded-full ${dotClass} ${disabled ? 'opacity-50' : ''}`} />}
      <span>{label}</span>
      <span className={`tabular-nums ${active ? 'opacity-80' : 'opacity-60'}`}>{n}</span>
    </button>
  );
}

export function LibraryEmpty({
  filter, query, scopeName, scoped, onShowAll, onClearSearch, onClearFilter,
}: {
  filter: LibFilter;
  query: string;
  scopeName: string;
  scoped: boolean;
  onShowAll: () => void;
  onClearSearch: () => void;
  onClearFilter: () => void;
}): JSX.Element {
  if (query.trim().length >= 2) {
    return (
      <div className="text-center py-10 text-sm text-ink-muted">
        <p>No meetings match <span className="font-semibold text-ink">“{query}”</span> in {scopeName}.</p>
        <button type="button" onClick={onClearSearch} className="mt-2 text-brand-indigo font-semibold hover:underline">Clear search</button>
      </div>
    );
  }
  if (filter !== 'all') {
    return (
      <div className="text-center py-10 text-sm text-ink-muted">
        <p>No {filter} meetings in {scopeName}.</p>
        <button type="button" onClick={onClearFilter} className="mt-2 text-brand-indigo font-semibold hover:underline">Show all statuses</button>
      </div>
    );
  }
  if (scoped) return <div className="text-center py-14 text-sm text-ink-muted">
    <p>No meetings in {scopeName} yet.</p>
    <button type="button" onClick={onShowAll} className="mt-2 text-brand-indigo font-semibold hover:underline">Show all meetings</button>
  </div>;
  return (
    <div className="text-center py-16">
      <div className="flex justify-center mb-4 opacity-40">
        <Icon name="mic" className="w-10 h-10" />
      </div>
      <div className="text-sm text-ink-muted max-w-sm mx-auto leading-relaxed">
        Hit <span className="font-semibold text-ink">Record</span>{' '}
        <kbd className="font-mono text-[10px] px-1 py-0.5 border border-surface-border rounded text-ink-muted">{shortcutMod()}R</kbd>{' '}
        to start a new session,
        or drag an audio file (.m4a or .mp3) onto this window.
      </div>
    </div>
  );
}
