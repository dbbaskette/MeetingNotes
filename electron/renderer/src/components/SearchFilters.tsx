import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import type { SearchFacets } from '../../../shared/search';
import { FacetsSchema } from '../../../shared/search-facets';
const storageKey = 'libraryNamedFilters';
interface SavedFilter {
  id: string;
  name: string;
  query: string;
  facets: SearchFacets;
}
function readFilters(): SavedFilter[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (entry): entry is SavedFilter =>
          !!entry &&
          typeof entry === 'object' &&
          typeof entry.id === 'string' &&
          entry.id.length <= 100 &&
          typeof entry.name === 'string' &&
          entry.name.length <= 80 &&
          typeof entry.query === 'string' &&
          entry.query.length <= 500 &&
          !!entry.facets &&
          typeof entry.facets === 'object' &&
          FacetsSchema.safeParse(entry.facets).success,
      )
      .slice(0, 30);
  } catch {
    return [];
  }
}
export function SearchFilters({
  facets,
  onChange,
  query,
  onQuery,
}: {
  facets: SearchFacets;
  onChange: (f: SearchFacets) => void;
  query: string;
  onQuery: (q: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false),
    [speakers, setSpeakers] = useState<{ id: string; displayName: string }[]>([]);
  const [saved, setSaved] = useState(readFilters),
    [selected, setSelected] = useState(''),
    [name, setName] = useState(''),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api.speakers
      .list()
      .then((rows) => {
        if (alive) setSpeakers(rows);
      })
      .catch(() => {
        if (alive) setError('Could not load speaker choices. Close and reopen filters to retry.');
      });
    return () => {
      alive = false;
    };
  }, [open]);
  function set(key: keyof SearchFacets, value: string | boolean): void {
    const next = { ...facets };
    if (value === '') delete next[key];
    else Object.assign(next, { [key]: value });
    onChange(next);
  }
  function persist(next: SavedFilter[]): void {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setSaved(next);
      setError(null);
    } catch {
      setError('Could not save filters on this device.');
    }
  }
  return (
    <div data-search-filters className="shrink-0 text-xs mb-2">
      <div className="flex flex-wrap gap-2 items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="rounded-lg border border-surface-border px-2 py-1"
        >
          Filters{Object.keys(facets).length ? ` (${Object.keys(facets).length})` : ''}
        </button>
        {Object.entries(facets).map(([key, value]) => (
          <button
            key={key}
            type="button"
            aria-label={`Remove ${key} filter`}
            onClick={() => set(key as keyof SearchFacets, '')}
            className="rounded-full bg-brand-indigo/10 text-brand-indigo px-2 py-1"
          >
            {key}: {String(value)} ×
          </button>
        ))}
        {Object.keys(facets).length > 0 && (
          <button type="button" onClick={() => onChange({})}>
            Clear filters
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 rounded-lg bg-surface-sunken border border-surface-border p-3 space-y-2">
          <div className="flex flex-wrap gap-3">
            <label>
              From{' '}
              <input
                type="date"
                value={facets.from ?? ''}
                onChange={(e) => set('from', e.target.value)}
              />
            </label>
            <label>
              Through{' '}
              <input
                type="date"
                value={facets.to ?? ''}
                onChange={(e) => set('to', e.target.value)}
              />
            </label>
            <label>
              Week{' '}
              <input
                type="week"
                value={facets.week ?? ''}
                onChange={(e) => set('week', e.target.value)}
              />
            </label>
            <label>
              Speaker{' '}
              <select
                value={facets.speakerId ?? ''}
                onChange={(e) => set('speakerId', e.target.value)}
              >
                <option value="">Anyone</option>
                {speakers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status{' '}
              <select value={facets.status ?? ''} onChange={(e) => set('status', e.target.value)}>
                <option value="">Any</option>
                {['pending', 'processing', 'awaiting_user', 'done', 'failed'].map((status) => (
                  <option key={status} value={status}>
                    {status === 'awaiting_user' ? 'Needs speaker review' : status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Actions{' '}
              <select value={facets.actions ?? ''} onChange={(e) => set('actions', e.target.value)}>
                <option value="">Any</option>
                <option value="open">Has open actions</option>
                <option value="mine">Has my open actions</option>
              </select>
            </label>
            <label>
              Source{' '}
              <select value={facets.source ?? ''} onChange={(e) => set('source', e.target.value)}>
                <option value="">Any</option>
                <option value="capture">Built-in recording</option>
                <option value="import">Imported</option>
              </select>
            </label>
            <label>
              Search in{' '}
              <select value={facets.content ?? ''} onChange={(e) => set('content', e.target.value)}>
                <option value="">Titles, notes & transcript</option>
                <option value="summary">Notes only</option>
                <option value="transcript">Transcript only</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={!!facets.warning}
                onChange={(e) => set('warning', e.target.checked ? true : '')}
              />{' '}
              Capture recovery warning
            </label>
          </div>
          <div className="border-t border-surface-border pt-2 flex flex-wrap items-center gap-2">
            <label>
              Saved{' '}
              <select
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setName(saved.find((f) => f.id === e.target.value)?.name ?? '');
                }}
              >
                <option value="">New named filter</option>
                {saved.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!selected}
              onClick={() => {
                const f = saved.find((f) => f.id === selected);
                if (f) {
                  onQuery(f.query);
                  onChange(f.facets);
                }
              }}
            >
              Apply
            </button>
            <input
              aria-label="Saved filter name"
              placeholder="Name or rename this filter"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded border border-surface-border px-2 py-1"
            />
            <button
              type="button"
              disabled={!name.trim() || (!selected && saved.length >= 30)}
              onClick={() => {
                const id = selected || crypto.randomUUID();
                persist([
                  ...saved.filter((f) => f.id !== id),
                  { id, name: name.trim(), query, facets: { ...facets } },
                ]);
                setSelected(id);
              }}
            >
              Save / rename
            </button>
            <button
              type="button"
              disabled={!selected}
              onClick={() => {
                persist(saved.filter((f) => f.id !== selected));
                setSelected('');
                setName('');
              }}
            >
              Delete
            </button>
          </div>
          <p className="text-ink-muted">
            Save stores this query and its filters locally. Ordinary searches are not saved across
            relaunches.
          </p>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
