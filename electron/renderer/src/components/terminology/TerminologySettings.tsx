import { useEffect, useRef, useState } from 'react';
import { api } from '../../ipc/client';
import { ModalShell } from '../ModalShell';
import type { TermInput, TermRule } from '../../../../shared/terminology';
import { filterDictionaryRules } from '../../lib/dictionary';
import { button, defaults, field, Scope } from './shared';

export function TerminologySettings(): JSX.Element {
  const [managerOpen, setManagerOpen] = useState(false);
  const [scope, setScope] = useState('*');
  const [discarding, setDiscarding] = useState(false);
  const managerButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const sourceInput = useRef<HTMLInputElement>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const discardCancel = useRef<HTMLButtonElement>(null);
  const [rules, setRules] = useState<TermRule[]>([]),
    [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [offers, setOffers] = useState(true),
    [query, setQuery] = useState('');
  const [editing, setEditing] = useState<TermRule | null>(null),
    [form, setForm] = useState<TermInput | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [deleting, setDeleting] = useState<TermRule | null>(null);
  async function load(): Promise<void> {
    const [r, g, o] = await Promise.all([
      api.terminology.list(),
      api.groups.list(),
      api.terminology.offers(),
    ]);
    setRules(r);
    setGroups(g.groups);
    setOffers(o);
  }
  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
  }, []);
  const editingForm = form !== null;
  const confirmingDelete = deleting !== null;
  useEffect(() => {
    if (!managerOpen) return;
    if (discarding) discardCancel.current?.focus();
    else if (confirmingDelete) deleteCancel.current?.focus();
    else if (editingForm) sourceInput.current?.focus();
    else searchInput.current?.focus();
    // Focus only when changing screens, not on each draft keystroke.
  }, [managerOpen, editingForm, confirmingDelete, discarding]);
  function closeManager(): void {
    if (busy) return;
    if (form) {
      setDiscarding(true);
      return;
    }
    if (deleting) {
      setDeleting(null);
      return;
    }
    setManagerOpen(false);
    managerButton.current?.focus();
  }
  const visibleRules = filterDictionaryRules(rules, query, scope);
  async function mutate(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      window.dispatchEvent(new Event('mn:terminology-changed'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="rounded-xl border border-surface-border p-4 space-y-3"
      aria-label="Dictionary settings"
    >
      <div className="flex justify-between items-center">
        <div>
          <h2 className="font-semibold">Dictionary</h2>
          <p className="text-xs text-ink-muted">
            {rules.length} saved {rules.length === 1 ? 'correction' : 'corrections'}
          </p>
        </div>
        <button
          ref={managerButton}
          className={button}
          disabled={busy}
          onClick={() => {
            setQuery('');
            setScope('*');
            setManagerOpen(true);
          }}
        >
          Manage dictionary…
        </button>
      </div>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={offers}
          disabled={busy}
          onChange={(e) => void mutate(() => api.terminology.offers(e.target.checked))}
        />
        Offer to remember short corrections after saving notes
      </label>
      {!managerOpen && error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {managerOpen && (
        <ModalShell size="lg" labelledBy="dictionary-title" busy={busy}
          onClose={() => { if (discarding) setDiscarding(false); else closeManager(); }}
          className="p-0 flex flex-col h-[min(40rem,calc(100dvh-2rem))]">
          <header className="shrink-0 flex items-center justify-between gap-3 border-b border-surface-border p-5">
            <h2 id="dictionary-title" className="font-semibold">
              {form ? (editing ? 'Edit correction' : 'Add correction') : 'Dictionary'}
            </h2>
            <button
              type="button"
              className={button}
              disabled={busy || discarding}
              onClick={closeManager}
            >
              Close
            </button>
          </header>
          <div className="min-h-0 flex-1 flex flex-col p-5 gap-3">
            {error && (
              <p role="alert" className="text-xs text-danger shrink-0">
                {error}
              </p>
            )}
            {discarding ? (
              <div
                role="alertdialog"
                aria-label="Discard unfinished correction?"
                className="space-y-4 overflow-y-auto"
              >
                <p className="text-sm">
                  Discard this unfinished correction? Your saved dictionary will not change.
                </p>
                <div className="flex gap-2">
                  <button
                    ref={discardCancel}
                    className={button}
                    onClick={() => setDiscarding(false)}
                  >
                    Keep editing
                  </button>
                  <button
                    className={button}
                    onClick={() => {
                      setForm(null);
                      setEditing(null);
                      setDiscarding(false);
                    }}
                  >
                    Discard changes
                  </button>
                </div>
              </div>
            ) : deleting ? (
              <div
                role="alertdialog"
                aria-label="Delete remembered correction?"
                className="space-y-4 overflow-y-auto"
              >
                <p className="text-sm break-words">
                  Delete {deleting.source} → <strong>{deleting.replacement}</strong>?
                </p>
                <p className="text-sm text-ink-muted">
                  Future meetings will no longer use this rule. Previously corrected documents stay
                  as they are.
                </p>
                <div className="flex gap-2">
                  <button
                    ref={deleteCancel}
                    className={button}
                    disabled={busy}
                    onClick={() => setDeleting(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className={`${button} text-danger`}
                    disabled={busy}
                    onClick={() =>
                      void mutate(async () => {
                        await api.terminology.delete(deleting.id);
                        setDeleting(null);
                      })
                    }
                  >
                    Delete correction
                  </button>
                </div>
              </div>
            ) : !form ? (
              <>
                <p className="text-xs text-ink-muted shrink-0">
                  Preferred words, acronyms, and product names. Rules apply to future processing;
                  review existing meetings individually.
                </p>
                <div className="flex flex-wrap gap-2 shrink-0">
                  <div className="flex-1 min-w-[10rem]">
                    <input
                      ref={searchInput}
                      data-dialog-initial-focus
                      aria-label="Search terminology"
                      placeholder="Find a term…"
                      className={field}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <select
                    aria-label="Filter dictionary by group"
                    className={`${field} !w-auto max-w-full`}
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                  >
                    <option value="*">All scopes</option>
                    <option value="">All meetings rules only</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => {
                      setEditing(null);
                      setForm({ ...defaults, groupId: scope === '*' || !scope ? null : scope });
                    }}
                  >
                    Add correction
                  </button>
                </div>
                <p className="text-xs text-ink-muted shrink-0" role="status">
                  {visibleRules.length} of {rules.length} corrections
                </p>
                {!visibleRules.length && (
                  <p className="text-sm text-ink-muted">
                    {rules.length
                      ? 'No corrections match. Try another search or group.'
                      : 'No corrections yet. Add one here or remember a correction when editing notes.'}
                  </p>
                )}
                <div
                  className="min-h-0 flex-1 overflow-y-auto overscroll-contain divide-y divide-surface-border"
                  aria-label="Saved corrections"
                >
                  {visibleRules.map((r) => (
                    <div key={r.id} className="py-3 flex flex-wrap gap-2 items-center">
                      <div className="flex-1 min-w-[10rem] text-sm break-words">
                        {r.source} → <strong>{r.replacement}</strong>
                        <div className="text-xs text-ink-muted">
                          {r.groupId
                            ? (groups.find((g) => g.id === r.groupId)?.name ?? 'Group unavailable')
                            : 'All meetings'}{' '}
                          ·{' '}
                          {r.enabled
                            ? r.mode === 'automatic'
                              ? 'Automatic'
                              : 'Suggest'
                            : 'Disabled'}
                        </div>
                      </div>
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => {
                          setEditing(r);
                          setForm({ ...r });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() =>
                          void mutate(() =>
                            api.terminology.save({ ...r, enabled: !r.enabled }, r.id),
                          )
                        }
                      >
                        {r.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button className={button} disabled={busy} onClick={() => setDeleting(r)}>
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <form
                className="space-y-4 min-h-0 overflow-y-auto"
                onSubmit={(e) => {
                  e.preventDefault();
                  void mutate(async () => {
                    await api.terminology.save(form, editing?.id);
                    setForm(null);
                    setEditing(null);
                  });
                }}
              >
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs">
                    Heard or written as
                    <input
                      ref={sourceInput}
                      required
                      maxLength={80}
                      className={field}
                      value={form.source}
                      onChange={(e) => setForm({ ...form, source: e.target.value })}
                    />
                  </label>
                  <label className="text-xs">
                    Use instead
                    <input
                      required
                      maxLength={80}
                      className={field}
                      value={form.replacement}
                      onChange={(e) => setForm({ ...form, replacement: e.target.value })}
                    />
                  </label>
                </div>
                <Scope
                  groupId={form.groupId}
                  onChange={(id) => setForm({ ...form, groupId: id })}
                  groups={groups}
                />
                <label className="flex gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.mode === 'automatic'}
                    onChange={(e) =>
                      setForm({ ...form, mode: e.target.checked ? 'automatic' : 'suggest' })
                    }
                  />
                  Automatically replace exact matches in future generated text
                </label>
                <label className="flex gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.caseSensitive}
                    onChange={(e) => setForm({ ...form, caseSensitive: e.target.checked })}
                  />
                  Match capitalization exactly
                </label>
                <div className="flex gap-2">
                  <button className={button} disabled={busy}>
                    Save correction
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() => setDiscarding(true)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </ModalShell>
      )}
    </section>
  );
}
