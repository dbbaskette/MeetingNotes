import { useState } from 'react';
import { api } from '../../ipc/client';
import type { TermCandidate } from '../../../../shared/terminology-matcher';
import { button, defaults, Scope } from './shared';

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
