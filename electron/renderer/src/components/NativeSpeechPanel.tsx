import { useEffect, useRef, useState } from 'react';
import { api } from '../ipc/client';
import type { NativeSpeechStatus, TranscriptionEngine } from '../../../shared/native-speech';
import { SegmentedControl } from './SegmentedControl';

const ENGINE_OPTIONS = [
  { value: 'apple' as const, label: 'Apple Speech (Built-in)' },
  { value: 'whisperkit' as const, label: 'WhisperKit Large-v3-Turbo (High accuracy)' },
];

export function NativeSpeechPanel({ language, onReady, engine = 'apple', onEngineChange }: {
  language: string;
  onReady?: (ready: boolean) => void;
  /** The saved transcription engine. */
  engine?: TranscriptionEngine;
  /** Shows the engine choice when given (Settings); setup keeps the built-in default. */
  onEngineChange?: (engine: TranscriptionEngine) => void | Promise<void>;
}): JSX.Element {
  const [status, setStatus] = useState<NativeSpeechStatus | null>(null);
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const readyCallback = useRef(onReady); readyCallback.current = onReady;
  const whisper = engine === 'whisperkit';
  const transcriptionReady = whisper ? !!status?.whisperReady : !!status?.appleReady;
  useEffect(() => { readyCallback.current?.(transcriptionReady && !!status?.speakerReady); }, [status, transcriptionReady]);
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
  }, [language, changing, engine]);
  const prepare = async (): Promise<void> => {
    setError(''); setChanging(true);
    try { setStatus(await api.nativeSpeech.prepare()); }
    catch (e) { setError(String(e)); }
    finally { setChanging(false); }
  };
  return <section className="space-y-3 text-sm" aria-label="Speech engine">
    <h3 className="font-semibold">Local transcription and speakers</h3>
    <p className="text-xs text-ink-muted">{whisper ? 'WhisperKit' : 'Apple'} transcription and SpeakerKit run on this Mac. Prepare speech assets once; no account or token is needed. Existing meetings and saved names stay in your library.</p>
      {onEngineChange && <div className="space-y-1.5">
        <div className="text-xs font-semibold">Transcription engine</div>
        <SegmentedControl label="Transcription engine" size="md" className="max-w-full flex-wrap" value={engine} options={ENGINE_OPTIONS}
          disabled={changing || !!status?.busy} onChange={value => { if (value !== engine) void onEngineChange(value); }} />
        <p className="text-xs text-ink-muted">{whisper
          ? 'Whisper large-v3-turbo as a Core ML model, run by the same helper. A one-time download of about 627 MB. Better with noisy rooms, accents, jargon and many more languages; it takes longer per meeting than Apple Speech.'
          : 'Built into macOS. Nothing to download beyond Apple’s own language assets, and the fastest to set up and run.'}</p>
        <p className="text-xs text-ink-muted">Applies to meetings processed from now on. Reprocess a meeting to transcribe it again with the selected engine; its previous transcript and notes are kept in history.</p>
      </div>}
      <p className="text-xs text-ink-muted">Language: {language || 'not selected'} · {whisper ? 'WhisperKit model' : 'Apple assets'}: {transcriptionReady ? 'ready' : whisper ? 'not downloaded' : 'not ready'} · Speaker models: {status?.speakerReady ? 'ready' : 'not ready'}</p>
      <p className="text-xs text-ink-muted">{whisper
        ? 'Setup downloads and verifies the WhisperKit model (about 627 MB) and about 11 MB of speaker models, then optimizes the model for this Mac, which can take several minutes the first time. Meetings are never uploaded. Summaries still use your configured LLM.'
        : 'Initial setup downloads Apple-managed language assets and about 11 MB of verified speaker models. Meetings are never uploaded. Summaries still use your configured LLM.'}</p>
      <p className="text-xs text-ink-muted">Confirm voices in a new native meeting to build native profiles. Suggestions are similarities, not confidence percentages. Optional automatic matching is controlled in Processing settings; only your confirmations teach profiles.</p>
      <div className="flex items-center gap-3">
        <button disabled={changing || status?.busy || !status?.supported} onClick={() => void prepare()} className="px-3 py-2 rounded-lg bg-brand-solid text-white disabled:opacity-40">{whisper && transcriptionReady && status?.speakerReady ? 'Verify native speech' : 'Prepare native speech'}</button>
        {(changing || status?.busy) && <button className="underline" onClick={() => void api.nativeSpeech.cancel().catch(e => setError(String(e)))}>Cancel setup</button>}
      </div>
      {status?.busy && <div role="status"><p>{status.phase}</p><progress className="w-full" max={1} value={status.progress} /></div>}
      {status && !status.supported && <p role="status">Native speech is unavailable on this Mac. Install on Apple silicon with macOS 26 or newer.</p>}
    {(error || status?.error) && <p role="alert" className="text-danger break-words">{error || status?.error}</p>}
  </section>;
}
