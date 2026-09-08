import { useId, useRef, useState } from 'react';
import { api } from '../ipc/client';
import type { RecoveryInboxItem } from './NeedsAttentionPanel';

const button = 'px-2.5 py-1.5 rounded-md border border-surface-border bg-surface text-xs font-medium hover:border-brand-indigo focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-indigo disabled:opacity-50';

export function RecoveryRow({ item, detail, onChanged, onOpen }: {
  item: RecoveryInboxItem; detail: string; onChanged: () => void | Promise<void>; onOpen: (id: string) => void;
}): JSX.Element {
  const panelId = useId();
  const audio = useRef<HTMLAudioElement>(null);
  const lock = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; durationS: number } | null>(null);
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('');
  const startS = start.trim() === '' ? NaN : Number(start);
  const endS = end.trim() === '' ? NaN : Number(end);
  const valid = Number.isFinite(startS) && Number.isFinite(endS) && startS >= 0 && endS > startS && endS <= (preview?.durationS ?? 0);

  async function run(label: string, action: () => Promise<void>): Promise<void> {
    if (lock.current) return;
    lock.current = true; setBusy(label); setError(null);
    try { await action(); }
    catch (err) { setError(`${label} failed: ${err instanceof Error ? err.message : String(err)}. Try again.`); }
    finally { lock.current = false; setBusy(null); }
  }
  async function openPreview(): Promise<void> {
    const result = await api.recovery.preview(item.id);
    setStart('0'); setEnd(String(result.durationS)); setPreview(result);
  }
  async function recovered(trim: boolean): Promise<void> {
    audio.current?.pause();
    const result = trim ? await api.recovery.trim(item.id, endS, startS) : await api.recovery.recover(item.id);
    await onChanged(); onOpen(result.meetingId);
  }
  function usePosition(which: 'start' | 'end'): void {
    const position = audio.current?.currentTime;
    if (position === undefined || !Number.isFinite(position)) return;
    (which === 'start' ? setStart : setEnd)(String(Math.min(preview?.durationS ?? 0, Math.round(position * 100) / 100)));
  }

  return <div className="py-2 text-sm" aria-busy={busy !== null}>
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1 basis-48">
        <div className="truncate font-medium text-ink">{item.targetLabel}</div>
        <div className="text-xs text-ink-muted">{detail}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {item.canRecover && <button className={button} disabled={busy !== null} aria-expanded={preview !== null} aria-controls={panelId}
          onClick={() => preview ? setPreview(null) : void run('Preview', openPreview)}>{preview ? 'Close preview' : 'Preview / trim'}</button>}
        <button className={button} disabled={busy !== null} onClick={() => void run('Finder', () => api.recovery.reveal(item.id))}>Finder</button>
        <button className={button} disabled={busy !== null} onClick={() => void run('Dismiss', async () => { await api.recovery.dismiss(item.id); await onChanged(); })}>Dismiss</button>
        <button className={button} disabled={busy !== null || !item.canRecover} onClick={() => void run('Recovery', () => recovered(false))}>
          {item.canRecover ? 'Recover full recording' : 'No usable audio'}
        </button>
      </div>
    </div>
    {preview && <div id={panelId} className="mt-3 p-3 rounded-lg bg-surface border border-surface-border space-y-3">
      <p className="text-xs text-ink-muted">Listen, then choose the part to keep. Your original recording stays unchanged.</p>
      <audio ref={audio} controls preload="metadata" src={preview.url} className="w-full min-w-0" aria-label={`Preview ${item.targetLabel}`}
        onError={() => setError('Audio preview could not play. Open the recording in Finder to check it, or close and reopen the preview.')} />
      <fieldset disabled={busy !== null || !item.canTrim} className="flex flex-wrap gap-3">
        <legend className="text-xs font-medium mb-2">Range to keep (seconds)</legend>
        {(['start', 'end'] as const).map(which => <div key={which} className="flex-1 basis-40 min-w-0">
          <label className="block text-xs mb-1" htmlFor={`${panelId}-${which}`}>{which === 'start' ? 'Start' : 'End'}</label>
          <input id={`${panelId}-${which}`} type="number" min="0" max={preview.durationS} step="any" value={which === 'start' ? start : end}
            onChange={e => (which === 'start' ? setStart : setEnd)(e.target.value)}
            className="w-full px-2 py-1.5 rounded border border-surface-border bg-surface text-ink" />
          <button className="text-xs text-brand-indigo mt-1 py-1" onClick={() => usePosition(which)}>Use playback position</button>
        </div>)}
      </fieldset>
      {!valid && <p className="text-xs text-danger" role="status">Choose 0 ≤ start &lt; end ≤ {preview.durationS.toFixed(2)} seconds.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button className={button} disabled={!valid || busy !== null} onClick={() => {
          if (!audio.current) return;
          audio.current.currentTime = startS;
          void audio.current.play().catch(() => setError('Playback could not start. Use the audio controls to try again.'));
        }}>Play from start</button>
        <button className={`${button} text-brand-indigo`} disabled={!valid || busy !== null || !item.canTrim}
          onClick={() => void run('Trim', () => recovered(true))}>Save trimmed copy</button>
        {valid && <span className="text-xs text-ink-muted">Keeping {(endS - startS).toFixed(2)} seconds</span>}
      </div>
    </div>}
    {busy && <p role="status" className="mt-2 text-xs text-ink-muted">{busy} in progress…</p>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </div>;
}
