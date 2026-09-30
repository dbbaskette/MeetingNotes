import { useEffect, useRef, useState } from 'react';
import { api } from '../ipc/client';
import type {
  TermArtifact,
  TermInput,
  TermPreviewInput,
  TermReview,
  TermRule,
} from '../../../shared/terminology';
import type { TermCandidate } from '../../../shared/terminology-matcher';
import { filterDictionaryRules } from '../lib/dictionary';

const button =
  'rounded-md border border-surface-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-indigo disabled:opacity-40';
const field =
  'rounded-md border border-surface-border bg-surface px-2 py-1.5 text-sm min-w-0 w-full';
const defaults: TermInput = {
  source: '',
  replacement: '',
  groupId: null,
  mode: 'suggest',
  caseSensitive: false,
  enabled: true,
};

function Scope({
  groupId,
  onChange,
  groups,
}: {
  groupId: string | null;
  onChange: (id: string | null) => void;
  groups: { id: string; name: string }[];
}): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-xs">
      Use in
      <select
        className={field}
        value={groupId ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">All meetings</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RememberTerms({
  candidates,
  groupId,
  groupName,
  onClose,
}: {
  candidates: TermCandidate[];
  groupId: string | null;
  groupName: string | null;
  onClose: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState(new Set(candidates.map((_, i) => i)));
  const [scope, setScope] = useState(groupId);
  const [automatic, setAutomatic] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(new Set<number>());
  async function remember(): Promise<void> {
    setBusy(true);
    setError(null);
    const done = new Set(saved);
    try {
      for (const i of selected) {
        if (done.has(i)) continue;
        await api.terminology.save({
          ...defaults,
          ...candidates[i]!,
          groupId: scope,
          mode: automatic ? 'automatic' : 'suggest',
        });
        done.add(i);
        setSaved(new Set(done));
      }
      window.dispatchEvent(new Event('mn:terminology-changed'));
      onClose();
    } catch (e) {
      setError(`Notes are saved. Could not remember every correction: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Remember terminology"
      className="rounded-lg border border-brand-indigo/25 bg-brand-indigo/5 p-3 space-y-3 text-sm"
    >
      <p className="font-semibold">
        Remember {candidates.length === 1 ? 'this correction' : 'these corrections'}?
      </p>
      {candidates.map((c, i) => (
        <label key={i} className="flex items-center gap-2 break-words">
          <input
            type="checkbox"
            disabled={busy || saved.has(i)}
            checked={selected.has(i)}
            onChange={(e) =>
              setSelected((s) => {
                const n = new Set(s);
                if (e.target.checked) n.add(i);
                else n.delete(i);
                return n;
              })
            }
          />
          <span>
            {c.source} → <strong>{c.replacement}</strong>
            {saved.has(i) ? ' · Remembered' : ''}
          </span>
        </label>
      ))}
      <Scope
        groupId={scope}
        onChange={setScope}
        groups={groupId ? [{ id: groupId, name: groupName ?? 'This group' }] : []}
      />
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={automatic}
          onChange={(e) => setAutomatic(e.target.checked)}
        />
        Automatically replace exact matches in future generated text
      </label>
      {error && (
        <p role="alert" className="text-danger text-xs">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          className={button}
          disabled={busy || !selected.size}
          onClick={() => void remember()}
        >
          {busy ? 'Remembering…' : 'Remember'}
        </button>
        <button className={button} disabled={busy} onClick={onClose}>
          Not now
        </button>
      </div>
    </section>
  );
}

export function TerminologyPanel({
  meetingId,
  artifact,
  version,
  groupId,
  groupName,
  disabled,
  onReload,
}: {
  meetingId: string;
  artifact: TermArtifact;
  version: string | null;
  groupId: string | null;
  groupName: string | null;
  disabled?: boolean;
  onReload: () => Promise<void>;
}): JSX.Element {
  const [review, setReview] = useState<TermReview | null>(null);
  const [open, setOpen] = useState(false),
    [manual, setManual] = useState(false);
  const [source, setSource] = useState(''),
    [replacement, setReplacement] = useState('');
  const [previewInput, setPreviewInput] = useState<TermPreviewInput>({ meetingId, artifact });
  const [selected, setSelected] = useState(new Set<string>());
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [remember, setRemember] = useState<TermCandidate[]>([]);
  const generation = useRef(0);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      const gen = ++generation.current;
      if (!version) return;
      void api.terminology
        .preview({ meetingId, artifact })
        .then((r) => {
          if (alive && gen === generation.current) {
            setReview(r);
            setPreviewInput({ meetingId, artifact });
            setSelected(new Set());
          }
        })
        .catch((e) => {
          if (alive && gen === generation.current) setError((e as Error).message);
        });
    };
    load();
    window.addEventListener('mn:terminology-changed', load);
    return () => {
      alive = false;
      window.removeEventListener('mn:terminology-changed', load);
    };
  }, [meetingId, artifact, version]);
  async function preview(): Promise<void> {
    generation.current++;
    setBusy(true);
    setError(null);
    try {
      const input = { meetingId, artifact, source, replacement };
      const r = await api.terminology.preview(input);
      setReview(r);
      setPreviewInput(input);
      setSelected(new Set(r.matches.map((m) => m.key)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function commit(dismiss = false): Promise<void> {
    if (!review) return;
    generation.current++;
    setBusy(true);
    setError(null);
    try {
      const r = await api.terminology.commit({
        ...previewInput,
        revision: review.revision,
        keys: [...selected],
        dismiss,
      });
      setReview(r);
      setSelected(new Set());
      setPreviewInput({ meetingId, artifact });
      if (!dismiss && previewInput.source && previewInput.replacement) {
        const learning = await Promise.all([
          api.terminology.offers(),
          api.terminology.list(),
        ]).catch(() => null);
        if (
          learning?.[0] &&
          !learning[1].some(
            (r) =>
              r.source.toLowerCase() === previewInput.source!.toLowerCase() &&
              (r.groupId === null || r.groupId === groupId),
          )
        )
          setRemember([{ source: previewInput.source, replacement: previewInput.replacement }]);
      }
      await onReload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function undo(historyId: string): Promise<void> {
    if (!review) return;
    generation.current++;
    setBusy(true);
    setError(null);
    try {
      setReview(
        await api.terminology.undo({ meetingId, artifact, historyId, revision: review.revision }),
      );
      setPreviewInput({ meetingId, artifact });
      setSelected(new Set());
      await onReload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const count = review?.matches.length ?? 0,
    history = review?.history.filter((h) => !h.undone) ?? [];
  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          className={button}
          disabled={disabled || busy || !version}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            setManual(true);
          }}
        >
          Correct term…
        </button>
        {(count > 0 || history.length > 0) && (
          <button
            className="text-brand-indigo underline underline-offset-2 disabled:opacity-40"
            disabled={disabled || busy}
            onClick={() => {
              setOpen(!open);
              setManual(false);
            }}
            aria-expanded={open}
          >
            {count
              ? `Review terminology (${count})`
              : `${history.length} terminology ${history.length === 1 ? 'correction' : 'corrections'}`}
          </button>
        )}
        {disabled && (
          <span className="text-ink-muted">Finish editing or processing to correct terms.</span>
        )}
      </div>
      {open && !disabled && (
        <section
          aria-label="Terminology corrections"
          className="rounded-lg border border-surface-border bg-surface-sunken/40 p-3 space-y-3"
        >
          {manual && (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void preview();
              }}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="text-xs">
                  Heard or written as
                  <input
                    className={field}
                    maxLength={80}
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                  />
                </label>
                <label className="text-xs">
                  Use instead
                  <input
                    className={field}
                    maxLength={80}
                    value={replacement}
                    onChange={(e) => setReplacement(e.target.value)}
                  />
                </label>
              </div>
              <button className={button} disabled={busy || !source.trim() || !replacement.trim()}>
                Preview matches
              </button>
            </form>
          )}
          {review?.previousCorrections && (
            <p className="text-xs text-status-warnText">
              The source transcript changed. Earlier corrections need to be reviewed against this
              version.
            </p>
          )}
          {review && (
            <>
              <p className="text-xs text-ink-muted">
                {count
                  ? 'Choose the occurrences to change. The original recording and timing stay intact.'
                  : 'No matching terminology suggestions.'}
                {count === 2000
                  ? ' Showing the first 2,000 matches; apply these, then preview again.'
                  : ''}
              </p>
              {count > 0 && (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selected.size === count}
                    onChange={(e) =>
                      setSelected(new Set(e.target.checked ? review.matches.map((m) => m.key) : []))
                    }
                  />
                  Select all shown
                </label>
              )}
              <div className="max-h-64 overflow-y-auto space-y-2">
                {review.matches.map((m) => (
                  <label key={m.key} className="flex items-start gap-2 text-sm">
                    <input
                      className="mt-1"
                      type="checkbox"
                      checked={selected.has(m.key)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(m.key);
                          else n.delete(m.key);
                          return n;
                        })
                      }
                    />
                    <span className="min-w-0 break-words">
                      <span>
                        {m.before} → <strong>{m.after}</strong>
                      </span>
                      <span className="block text-xs text-ink-muted">{m.context}</span>
                    </span>
                  </label>
                ))}
              </div>
              {count > 0 && (
                <div className="flex gap-2">
                  <button
                    className={button}
                    disabled={busy || !selected.size}
                    onClick={() => void commit()}
                  >
                    Apply selected ({selected.size})
                  </button>
                  <button
                    className={button}
                    disabled={busy || !selected.size}
                    onClick={() => void commit(true)}
                  >
                    Dismiss selected
                  </button>
                </div>
              )}
              {history.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-xs">
                    Applied corrections ({history.length})
                  </summary>
                  <div className="max-h-48 overflow-y-auto mt-2 space-y-2">
                    {history.map((h) => (
                      <div key={h.id} className="text-xs flex items-start justify-between gap-3">
                        <span className="min-w-0 break-words">
                          {h.before} → <strong>{h.after}</strong>
                          <span className="block text-ink-muted">{h.context}</span>
                        </span>
                        <button className={button} disabled={busy} onClick={() => void undo(h.id)}>
                          Undo
                        </button>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
          <button className={button} disabled={busy} onClick={() => setOpen(false)}>
            Close
          </button>
        </section>
      )}
      {remember.length > 0 && (
        <RememberTerms
          candidates={remember}
          groupId={groupId}
          groupName={groupName}
          onClose={() => setRemember([])}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}{' '}
          <button
            className="underline"
            onClick={() => {
              setError(null);
              window.dispatchEvent(new Event('mn:terminology-changed'));
            }}
          >
            Refresh preview
          </button>
        </p>
      )}
    </div>
  );
}

export function TerminologySettings(): JSX.Element {
  const [managerOpen, setManagerOpen] = useState(false);
  const [scope, setScope] = useState('*');
  const [discarding, setDiscarding] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
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
    if (!dialog.current?.open) dialog.current?.showModal();
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
    dialog.current?.close();
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
        <dialog
          ref={dialog}
          aria-labelledby="dictionary-title"
          onCancel={(event) => {
            event.preventDefault();
            if (discarding) setDiscarding(false);
            else closeManager();
          }}
          className="m-auto w-[calc(100%-2rem)] max-w-2xl h-[min(40rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] rounded-xl border border-surface-border bg-surface text-ink p-0 shadow-pop backdrop:bg-black/30 open:flex open:flex-col"
        >
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
        </dialog>
      )}
    </section>
  );
}
