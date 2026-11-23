import { useEffect, useRef, useState } from 'react';
import { api } from '../../ipc/client';
import type {
  TermScope,
  TermHistory,
  TermPreviewInput,
  TermReview,
} from '../../../../shared/terminology';
import type { TermCandidate } from '../../../../shared/terminology-matcher';
import { button, field } from './shared';
import { RememberTerms } from './RememberTerms';

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
  artifact: TermScope;
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
  const batches = new Map<string, TermHistory[]>();
  for (const h of history) {
    const key = h.batchId ?? h.id;
    batches.set(key, [...(batches.get(key) ?? []), h]);
  }
  const counts = (matches: { artifact?: string }[]): string =>
    `Transcript: ${matches.filter((m) => m.artifact === 'transcript').length} · Summary: ${matches.filter((m) => m.artifact === 'summary').length}`;
  const selectedArtifacts = new Set(
    review?.matches.filter((m) => selected.has(m.key)).map((m) => m.artifact),
  );
  const applyLabel =
    artifact !== 'meeting'
      ? 'Apply selected'
      : selectedArtifacts.size === 2
        ? 'Apply to both'
        : selectedArtifacts.has('transcript')
          ? 'Apply to transcript'
          : selectedArtifacts.has('summary')
            ? 'Apply to summary'
            : 'Apply corrections';
  const limited =
    artifact === 'meeting'
      ? ['transcript', 'summary'].some(
          (a) => review?.matches.filter((m) => m.artifact === a).length === 2000,
        )
      : count === 2000;
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
          {artifact === 'meeting' ? 'Correct terminology…' : 'Correct term…'}
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
              {artifact === 'meeting' && (
                <p className="text-xs font-semibold" role="status">
                  {counts(review.matches)}
                </p>
              )}
              <p className="text-xs text-ink-muted">
                {count
                  ? 'Choose the occurrences to change. The original recording and timing stay intact.'
                  : 'No matching terminology suggestions.'}
                {limited
                  ? ' Showing up to 2,000 matches per document; apply these, then preview again.'
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
                      {m.artifact && (
                        <span className="block text-xs font-semibold text-ink-muted">
                          {m.artifact === 'transcript' ? 'Transcript' : 'Summary'}
                        </span>
                      )}
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
                    {applyLabel} ({selected.size})
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
                    Applied corrections ({batches.size})
                  </summary>
                  <div className="max-h-48 overflow-y-auto mt-2 space-y-2">
                    {[...batches.values()].map((batch) => {
                      const h = batch[0]!;
                      return (
                        <div key={h.id} className="text-xs flex items-start justify-between gap-3">
                          <span className="min-w-0 break-words">
                            {[
                              ...new Set(batch.map((edit) => `${edit.before} → ${edit.after}`)),
                            ].join('; ')}
                            <span className="block text-ink-muted">
                              {artifact === 'meeting' ? counts(batch) : h.context}
                            </span>
                          </span>
                          <button
                            className={button}
                            disabled={busy}
                            onClick={() => void undo(h.id)}
                          >
                            Undo
                          </button>
                        </div>
                      );
                    })}
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
