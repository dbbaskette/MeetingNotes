import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import { SourcePicker } from './SourcePicker';
import { ConfirmDialog } from './ConfirmDialog';

export function SetupHealth(): JSX.Element {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.permissions.setupHealth>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [withMic, setWithMic] = useState(true);
  const [input, setInput] = useState<{ targetPid: number | 'system'; targetLabel: string; mic: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.recording.test>> | null>(null);
  const [activeTest, setActiveTest] = useState<string | null>(null);
  async function refresh(): Promise<void> {
    setError(null);
    try { setRows(await api.permissions.setupHealth()); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void refresh(); }, []);
  async function capture(): Promise<void> {
    if (!input || busy) return;
    setInput(null); setBusy(true); setError(null); setResult(null);
    try { setResult(await api.recording.test(input)); }
    catch (e) {
      setError(`Test could not finish: ${(e as Error).message}. Retry Stop before trying another capture.`);
      try { setActiveTest((await api.recording.active()).find(row => row.disposable)?.sessionId ?? null); } catch { /* keep actionable failure */ }
    }
    finally { setBusy(false); }
  }
  return <div className="shrink-0 px-8 py-3 border-b border-surface-border text-xs">
    <details><summary className="cursor-pointer font-semibold text-sm">Setup &amp; health{rows.some(row => row.state === 'blocked') ? ' · Needs attention' : ''}</summary>
      <p className="text-ink-muted mt-2">Recording and processing are required. Exporters are optional. These checks do not start a recording or wake model services.</p>
      <ul className="mt-2 space-y-2">{rows.map(row => <li key={row.label}>
        <button type="button" className="font-semibold underline" onClick={() => window.dispatchEvent(new CustomEvent('meetingnotes:settings-section', { detail: row.section }))}>{row.label}</button>
        <span className="ml-2 text-ink-muted">{row.state === 'blocked' ? 'Needs attention' : row.state === 'check' ? 'Check when needed' : row.state === 'optional' ? 'Optional' : 'Ready'}</span>
        <p className="text-ink-muted break-words">{row.detail}</p>
      </li>)}</ul>
      <div className="relative mt-3 flex gap-3">
        <button type="button" className="underline" onClick={() => void refresh()}>Recheck setup</button>
        <button type="button" className="font-semibold underline disabled:opacity-40" disabled={busy} onClick={() => setPicking(true)}>{busy ? 'Testing capture for 8 seconds…' : 'Test recording…'}</button>
        {picking && <SourcePicker showGroupPicker={false} onCancel={() => setPicking(false)} onPick={source => { setPicking(false); setInput({ targetPid: source.targetPid, targetLabel: source.targetLabel, mic: withMic }); }} />}
      </div>
      <label className="flex gap-2 mt-2"><input type="checkbox" checked={withMic} disabled={busy} onChange={e => setWithMic(e.target.checked)} />Include microphone in test</label>
      <p className="text-ink-muted mt-2">The test is disposable: no Library meeting, processing, or export. Speak a short phrase after starting; play app audio only if you want to test both sources.</p>
      {result && <div className="mt-2" role="status"><p>{result.message}</p><ul>{Object.entries(result.streams).map(([label, stream]) => <li key={label}>{label}: {stream.playable ? 'playable container' : 'no playable audio'} · {stream.peakDb === null ? 'no level samples' : `${stream.peakDb.toFixed(1)} dBFS peak`}</li>)}</ul></div>}
      {error && <p role="alert" className="text-danger mt-2">{error}</p>}
      {activeTest && <button type="button" className="mt-2 font-semibold underline" onClick={() => void api.recording.stop(activeTest).then(() => { setActiveTest(null); setError('Test recorder has stopped. No meeting was created; you can start a new test.'); }).catch(e => setError((e as Error).message))}>Retry Stop test</button>}
    </details>
    <ConfirmDialog open={input !== null} title="Start an 8-second disposable recording?" body={`Source: ${input?.targetLabel ?? ''}, microphone ${input?.mic ? 'on' : 'off'}. This records only after you choose Start test. Audio is discarded after confirmed finalization; your library is unchanged.`}
      confirmLabel="Start test" onCancel={() => setInput(null)} onConfirm={() => void capture()} />
  </div>;
}
