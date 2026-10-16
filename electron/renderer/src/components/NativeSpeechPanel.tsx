import { useEffect, useRef, useState } from 'react';
import { api } from '../ipc/client';
import type { NativeSpeechStatus, SpeechProvider } from '../../../shared/native-speech';

export function NativeSpeechPanel({ provider, language, onProvider, onReady }: {
  provider: SpeechProvider; language: string;
  onProvider: (provider: SpeechProvider) => void; onReady?: (ready: boolean) => void;
}): JSX.Element {
  const [status, setStatus] = useState<NativeSpeechStatus | null>(null);
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const readyCallback = useRef(onReady); readyCallback.current = onReady;
  useEffect(() => { readyCallback.current?.(!!status?.appleReady && !!status?.speakerReady); }, [status]);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const check = async (): Promise<void> => {
      if (!api.nativeSpeech) return; // isolated design/legacy fixtures
      try {
        const value = await api.nativeSpeech.status();
        if (disposed) return;
        setStatus(value);
        if (value.busy) timer = setTimeout(() => void check(), 700);
      } catch (e) { if (!disposed) setError(String(e)); }
    };
    void check();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [provider, language, changing]);
  const prepare = async (): Promise<void> => {
    setError(''); setChanging(true);
    try { setStatus(await api.nativeSpeech.prepare()); }
    catch (e) { setError(String(e)); }
    finally { setChanging(false); }
  };
  const choose = async (value: SpeechProvider): Promise<void> => {
    setError(''); setChanging(true);
    try { await api.settings.set('speechProvider', value); onProvider(value); }
    catch (e) { setError(String(e)); }
    finally { setChanging(false); }
  };
  return <section className="space-y-3 text-sm" aria-label="Speech engine">
    <label className="block font-semibold">Transcription and speaker engine
      <select aria-label="Transcription and speaker engine" value={provider} disabled={changing || status?.busy}
        onChange={e => void choose(e.target.value as SpeechProvider)} className="block mt-2 w-full rounded-lg border border-surface-border bg-surface px-3 py-2 font-normal">
        <option value="native" disabled={status !== null && !status.supported}>Apple transcription + SpeakerKit (recommended)</option>
        <option value="legacy">Legacy · Whisper + pyannote</option>
      </select>
    </label>
    <p className="text-xs text-ink-muted">Native speech runs locally on Apple silicon with macOS 26+. No Whisper download, Python setup, or Hugging Face token. Your meetings, notes and saved names stay in this library. Only explicitly reprocessed meetings change.</p>
    {provider === 'legacy' ? <p className="text-xs text-ink-muted">Your existing engine is unchanged. Switch to native speech when you are ready; legacy voice profiles are retained separately.</p> : <>
      <p className="text-xs text-ink-muted">Language: {language || 'not selected'} · Apple assets: {status?.appleReady ? 'ready' : 'not ready'} · Speaker models: {status?.speakerReady ? 'ready' : 'not ready'}</p>
      <p className="text-xs text-ink-muted">Initial setup downloads Apple-managed language assets and about 11 MB of verified speaker models. Meetings are never uploaded. Summaries still use your configured LLM.</p>
      <p className="text-xs text-ink-muted">Confirm voices in a new native meeting to build native profiles. Suggestions are similarities to review, not automatic identifications or confidence percentages.</p>
      <div className="flex items-center gap-3">
        <button disabled={changing || status?.busy || !status?.supported} onClick={() => void prepare()} className="px-3 py-2 rounded-lg bg-brand-indigo text-white disabled:opacity-40">Prepare native speech</button>
        {(changing || status?.busy) && <button className="underline" onClick={() => void api.nativeSpeech.cancel().catch(e => setError(String(e)))}>Cancel setup</button>}
      </div>
      {status?.busy && <div role="status"><p>{status.phase}</p><progress className="w-full" max={1} value={status.progress} /></div>}
      {status && !status.supported && <p role="status">Native speech is unavailable on this Mac. Use Legacy speech or install on Apple silicon with macOS 26 or newer.</p>}
    </>}
    {(error || status?.error) && <p role="alert" className="text-danger break-words">{error || status?.error}</p>}
  </section>;
}
