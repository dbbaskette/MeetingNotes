import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BetaComparison, BetaPreview, BetaStatus, SpeechBetaBridge } from '../../../shared/speech-beta';
import './speech-beta.css';

const api = (window as unknown as { speechBeta: SpeechBetaBridge }).speechBeta;
function BetaApp(): JSX.Element {
  const [status, setStatus] = useState<BetaStatus | null>(null);
  const [preview, setPreview] = useState<BetaPreview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [comparison, setComparison] = useState<BetaComparison | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [tab, setTab] = useState<'transcript' | 'notes'>('transcript');
  const audio = useRef<HTMLAudioElement>(null);
  const selection = useRef<string | null>(selected);
  selection.current = selected;
  const refresh = useCallback(async () => { setStatus(await api.status()); }, []);
  useEffect(() => {
    let active = true;
    const update = (): void => { void api.status().then(value => { if (active) setStatus(value); }).catch(e => { if (active) setError(String(e)); }); };
    update(); const timer = setInterval(update, 1500);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    let current = true; setComparison(null);
    if (selected) void api.compare(selected).then(value => { if (current) setComparison(value); }).catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [selected]);
  const act = async (work: () => Promise<unknown>): Promise<void> => {
    if (working) return;
    setWorking(true); setError(null);
    try {
      await work(); await refresh();
      const current = selection.current;
      if (current) { const next = await api.compare(current); if (selection.current === current) setComparison(next); }
    }
    catch (e) { setError((e as Error).message); }
    finally { setWorking(false); }
  };
  const busy = working || !!status?.busy;
  const meetings = status?.meetings.filter(m => m.title.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const groups = [...new Set(meetings.map(m => m.groupName))].sort((a, b) => a === null ? -1 : b === null ? 1 : a.localeCompare(b));
  function transcript(text: string): JSX.Element {
    return <div className="beta-transcript">{text.split('\n').map((line, index) => {
      const timestamp = line.match(/\[(.*?) (\d+):(\d+)\]/);
      return <p key={index}>{timestamp && <button className="beta-time" aria-label={`Play at ${timestamp[2]} minutes ${timestamp[3]} seconds`}
        onClick={() => { if (audio.current) { audio.current.currentTime = Number(timestamp[2]) * 60 + Number(timestamp[3]); void audio.current.play().catch(() => {}); } }}>{timestamp[2]}:{timestamp[3]}</button>}{line}</p>;
    })}</div>;
  }
  return <div className="beta-app">
    <header><div><h1>MeetingNotes <span>Beta</span></h1><p>Local speech comparison · Your everyday library stays untouched.</p></div>
      <details><summary>Speech setup</summary><div className="beta-setup">
        <p>Experimental engines. Accuracy and voice-match thresholds are still being evaluated.</p>
        <button disabled={busy || !status} onClick={() => void act(() => api.prepare('apple'))}>{status?.appleReady ? 'Check Apple assets' : 'Prepare Apple transcription'}</button>
        <button disabled={busy || !status} onClick={() => void act(() => api.prepare('speakers'))}>{status?.speakersReady ? 'Verify speaker models' : 'Download speaker models (11 MB)'}</button>
        <p>Processing stays on this Mac. Setup downloads assets; it does not upload recordings. No Hugging Face account is required for the native speaker path.</p>
      </div></details></header>
    {(status?.busy || busy) && <div className="beta-feedback" role="status">{status?.busy ?? 'Working…'} {status?.progress != null && `${Math.round(status.progress * 100)}%`}
      <button onClick={() => void api.cancel().catch(e => setError(String(e)))}>Cancel</button></div>}
    {(error || status?.error) && <div className="beta-error" role="alert">{error || status?.error}</div>}
    {!status ? <main className="beta-welcome"><p>Opening beta workspace…</p></main> : !status.imported ?
      <main className="beta-welcome"><h2>Compare using your existing meetings</h2><p>Copy your library once, then re-transcribe selected meetings. Original transcripts, notes, groups, and saved speaker names remain available.</p>
        <p>Finish recording and processing, then close the regular MeetingNotes app before copying. Nothing is reprocessed automatically. Exports, vault sync, and recording triggers are not enabled in this beta workspace.</p>
        <button disabled={busy} onClick={() => void act(async () => { setPreview(await api.previewImport()); })}>Choose existing library</button>
        {preview && <section className="beta-copy-preview"><h3>Review library copy</h3><dl><dt>From</dt><dd>{preview.source}</dd><dt>To</dt><dd>{preview.destination}</dd><dt>Space needed</dt><dd>{(preview.bytes / 1024 ** 3).toFixed(2)} GB · {preview.files} files</dd></dl>
          {preview.missing > 0 && <p>{preview.missing} missing/unsupported files will remain unavailable. External audio that can be read is copied too.</p>}
          <button disabled={busy} onClick={() => void act(() => api.importLibrary())}>Copy library for testing</button></section>}
      </main> : <div className="beta-workspace"><aside><label htmlFor="beta-search">Find a meeting</label><input id="beta-search" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search titles" />
        <p className="beta-muted">{status.meetings.length} meetings in this snapshot</p>
        {groups.map(group => <details key={group ?? 'ungrouped'} open><summary>{group ?? 'Ungrouped'}</summary>{meetings.filter(m => m.groupName === group).map(meeting =>
          <button key={meeting.id} className={`beta-meeting ${selected === meeting.id ? 'selected' : ''}`} aria-current={selected === meeting.id ? 'true' : undefined}
            onClick={() => { setSelected(meeting.id); setTab('transcript'); }}>{meeting.title}</button>)}</details>)}
      </aside><main className="beta-detail">{!comparison ? <div className="beta-empty"><h2>{selected ? 'Loading meeting…' : 'Choose a meeting to compare'}</h2><p>Reprocessing writes a separate beta result. It never replaces the copied original or your stable library.</p></div> : <>
        <div className="beta-meeting-header"><h2>{comparison.title}</h2><div className="beta-actions">
          <button disabled={busy || !status.appleReady || !comparison.audioUrl} onClick={() => void act(() => api.run(comparison.meetingId, 'transcript'))}>Re-transcribe only</button>
          <button disabled={busy || !status.appleReady || !status.speakersReady || !comparison.audioUrl} onClick={() => void act(() => api.run(comparison.meetingId, 'full'))}>Re-transcribe + identify voices</button></div>
          {(!status.appleReady || !status.speakersReady) && <p>Open Speech setup above to prepare the native engines.</p>}
          {comparison.elapsedMs !== null && <p>Latest beta run: {(comparison.elapsedMs / 1000).toFixed(1)} seconds · {comparison.mode === 'full' ? 'Apple + SpeakerKit' : 'Apple + original speaker turns'}. Original timing is unavailable.</p>}
        </div>
        <div className="beta-tabs"><button aria-pressed={tab === 'transcript'} onClick={() => setTab('transcript')}>Transcript comparison</button><button aria-pressed={tab === 'notes'} onClick={() => setTab('notes')}>Original notes (unchanged)</button></div>
        {tab === 'notes' ? <pre className="beta-notes">{comparison.notes || 'No saved notes.'}</pre> : <div className="beta-columns"><section><h3>Original · saved snapshot</h3>{transcript(comparison.original || 'No original transcript was saved.')}</section><section><h3>Beta · {comparison.mode === 'full' ? 'Apple + SpeakerKit' : 'Apple transcription'}</h3>{transcript(comparison.result ?? 'Run one of the comparisons above. Your original stays available.')}</section></div>}
        {comparison.voices.length > 0 && <section className="beta-voices"><h3>Recognize these voices</h3><p>Existing names are preserved. Confirm a person to enroll their new voice profile. Suggestions use similarity—not a probability—and are never applied automatically.</p>
          {comparison.voices.map(voice => <div className="beta-voice" key={`${comparison.generatedAt}-${voice.label}`}><strong>{voice.name ?? voice.label}</strong>
            {voice.candidates.length > 0 && <span>Closest: {voice.candidates.map(c => `${c.displayName} (${c.similarity.toFixed(2)})`).join(', ')}</span>}
            <select aria-label={`Name ${voice.label}`} defaultValue="" disabled={busy} onChange={e => { const value = e.target.value; if (value) void act(() => api.confirm(comparison.meetingId, voice.label, value)); }}><option value="">Choose saved person…</option>{status.roster.map(person => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select>
            {!voice.canEnroll && <small>Can be named, but no usable voice profile is available.</small>}</div>)}</section>}
        {comparison.audioUrl ? <audio ref={audio} controls src={comparison.audioUrl} preload="metadata" /> : <p role="status">Audio was unavailable when this library was copied.</p>}
      </>}</main></div>}
    <footer>Experimental beta · Separate library · No automatic exports or recording · Original results preserved</footer>
  </div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Beta root is missing.');
if (!api) root.textContent = 'Open this workspace through MeetingNotes Beta; the local bridge is unavailable.';
else createRoot(root).render(<BetaApp />);
