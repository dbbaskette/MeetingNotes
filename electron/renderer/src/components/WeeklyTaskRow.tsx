import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import type { WeeklyActionItem } from '../../../main/ipc/contracts';
import { fmtDueLabel } from '../lib/due-date';
type Patch = { status?: string; ownerName?: string | null; dueDate?: string | null };
export function WeeklyTaskRow({
  item,
  rangeEnd,
  onOpen,
  onPatch,
  onSaved,
}: {
  item: WeeklyActionItem;
  rangeEnd: string;
  onOpen: (id: string) => void;
  onPatch: (id: string, patch: Patch) => void;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [owner, setOwner] = useState(item.ownerName ?? ''),
    [due, setDue] = useState(item.dueDate ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [retry, setRetry] = useState<Patch | null>(null);
  useEffect(() => {
    if (!busy) {
      setOwner(item.ownerName ?? '');
      setDue(item.dueDate ?? '');
    }
  }, [item.ownerName, item.dueDate, busy]);
  async function save(patch: Patch): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setRetry(null);
    const before: Patch = {
      status: item.status,
      ownerName: item.ownerName ?? null,
      dueDate: item.dueDate,
    };
    onPatch(item.id, patch);
    try {
      if (patch.status) await api.actionItems.setStatus(item.id, patch.status);
      else await api.actionItems.update(item.id, patch);
    } catch (cause) {
      onPatch(item.id, before);
      setError((cause as Error).message);
      setRetry(patch);
      setBusy(false);
      return;
    }
    try {
      await onSaved();
    } catch {
      setError('Saved, but this week could not refresh. Reload the week to see updated counts.');
    }
    setBusy(false);
  }
  function snooze(): void {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    setDue(value);
    void save({ dueDate: value });
  }
  const dueLabel = fmtDueLabel(item.dueDate, rangeEnd);
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          aria-label={`Complete ${item.text}`}
          checked={item.status === 'done'}
          disabled={busy}
          onChange={() => void save({ status: item.status === 'done' ? 'open' : 'done' })}
          className="mt-1 accent-brand-indigo"
        />
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm ${item.status === 'done' ? 'line-through text-ink-muted' : 'text-ink'}`}
          >
            {item.text}
          </p>
          <button
            onClick={() => onOpen(item.meetingId)}
            className="text-xs text-brand-indigo hover:underline"
          >
            From {item.meetingTitle}
          </button>
        </div>
        <span className={`text-xs rounded-full px-2 py-1 ${dueLabel.tier==='overdue'?'bg-danger-bg text-danger-text':dueLabel.tier==='this-week'?'bg-status-warnBg text-status-warnText':'text-ink-muted'}`}>{busy ? 'Saving…' : dueLabel.label}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label>
          Owner{' '}
          <input
            value={owner}
            disabled={busy}
            onChange={(event) => setOwner(event.target.value)}
            maxLength={200}
            className="rounded border border-surface-border px-2 py-1 max-w-40"
          />
        </label>
        <label>
          Due{' '}
          <input
            type="date"
            value={due}
            disabled={busy}
            onChange={(event) => setDue(event.target.value)}
          />
        </label>
        <button
          disabled={busy || (owner === (item.ownerName ?? '') && due === (item.dueDate ?? ''))}
          onClick={() =>
            void save({
              ...(owner !== (item.ownerName ?? '') ? { ownerName: owner.trim() || null } : {}),
              ...(due !== (item.dueDate ?? '') ? { dueDate: due || null } : {}),
            })
          }
          className="text-brand-indigo disabled:opacity-40"
        >
          Save
        </button>
        <button disabled={busy} onClick={snooze}>
          Snooze 1 week
        </button>
      </div>
      {item.sourceQuote && (
        <details className="text-xs text-ink-muted">
          <summary className="cursor-pointer">Source note</summary>
          <blockquote className="border-l-2 border-surface-border pl-2 mt-1">
            {item.sourceQuote}
          </blockquote>
        </details>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}{' '}
          {retry && (
            <button onClick={() => void save(retry)} className="underline">
              Retry
            </button>
          )}
        </p>
      )}
    </div>
  );
}
