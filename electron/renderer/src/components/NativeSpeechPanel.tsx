import { useEffect, useRef, useState } from 'react';
import { api } from '../ipc/client';
import type { NativeSpeechStatus } from '../../../shared/native-speech';

export function NativeSpeechPanel({ language, onReady }: {
  language: string;
  onReady?: (ready: boolean) => void;
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
  }, [language, changing]);
  const prepare = async (): Promise<void> => {
    setError(''); setChanging(true);
    try { setStatus(await api.nativeSpeech.prepare()); }
    catch (e) { setError(String(e)); }
    finally { setChanging(false); }
  };
  return <section className="space-y-3 text-sm" aria-label="Speech engine">
    <h3 className="font-semibold">Local transcription and speakers</h3>
    <p className="text-xs text-ink-muted">Apple transcription and SpeakerKit run on this Mac. Prepare speech assets once; no account or token is needed. Existing meetings and saved names stay in your library.</p>
      <p className="text-xs text-ink-muted">Language: {language || 'not selected'} · Apple assets: {status?.appleReady ? 'ready' : 'not ready'} · Speaker models: {status?.speakerReady ? 'ready' : 'not ready'}</p>
      <p className="text-xs text-ink-muted">Initial setup downloads Apple-managed language assets and about 11 MB of verified speaker models. Meetings are never uploaded. Summaries still use your configured LLM.</p>
      <p className="text-xs text-ink-muted">Confirm voices in a new native meeting to build native profiles. Suggestions are similarities, not confidence percentages. Optional automatic matching is controlled in Processing settings; only your confirmations teach profiles.</p>
      <div className="flex items-center gap-3">
        <button disabled={changing || status?.busy || !status?.supported} onClick={() => void prepare()} className="px-3 py-2 rounded-lg bg-brand-solid text-white disabled:opacity-40">Prepare native speech</button>
        {(changing || status?.busy) && <button className="underline" onClick={() => void api.nativeSpeech.cancel().catch(e => setError(String(e)))}>Cancel setup</button>}
      </div>
      {status?.busy && <div role="status"><p>{status.phase}</p><progress className="w-full" max={1} value={status.progress} /></div>}
      {status && !status.supported && <p role="status">Native speech is unavailable on this Mac. Install on Apple silicon with macOS 26 or newer.</p>}
    {(error || status?.error) && <p role="alert" className="text-danger break-words">{error || status?.error}</p>}
  </section>;
}
