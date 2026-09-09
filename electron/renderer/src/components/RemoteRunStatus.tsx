import { useEffect, useState } from 'react';
import { api } from '../ipc/client';

export function remotePhase(phase: string): string {
  const names: Record<string, string> = { pending_upload: 'Pending upload', uploading: 'Uploading', verifying_upload: 'Verifying upload',
    queued: 'Queued', starting: 'Starting', transcribing: 'Transcribing', diarizing: 'Diarizing', summarizing: 'Summarizing',
    downloading: 'Downloading', downloaded: 'Importing', needs_speaker_names: 'Needs speaker names', done: 'Done',
    offline: 'Offline / reconnecting', failed: 'Remote error', cancelled: 'Cancelled', conflict: 'Review remote result', retry_wait: 'Retry scheduled', complete: 'Downloading' };
  return names[phase] ?? 'Remote processing';
}
export function RemoteRunStatus({ meetingId, onChanged }: { meetingId: string; onChanged: () => void }): JSX.Element | null {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.remote.status>>>(null);
  const [review, setReview] = useState<Awaited<ReturnType<typeof api.remote.review>> | null>(null);
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () => { void api.remote.status(meetingId).then(s => { if (live) setStatus(s); }).catch(() => {}); };
    refresh(); const timer = setInterval(refresh, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [meetingId]);
  async function action(value: 'retry' | 'cancel' | 'local'): Promise<void> {
    if (value === 'local' && !window.confirm('Cancel this remote run and start again on this Mac? Existing generated artifacts will be cleared. Local models are required.')) return;
    setBusy(true); setMessage('');
    try { await api.remote.action(meetingId, value); setStatus(await api.remote.status(meetingId)); onChanged(); }
    catch (e) { setMessage(String(e)); } finally { setBusy(false); }
  }
  async function resolve(accept: boolean): Promise<void> {
    if (!review) return;
    setBusy(true);
    try { await api.remote.resolve(meetingId, review.runId, accept, review.localFingerprint); setReview(null); setStatus(await api.remote.status(meetingId)); onChanged(); }
    catch (e) { setMessage(String(e)); } finally { setBusy(false); }
  }
  if (!status) return null;
  return <section aria-label="Remote processing status" className="shrink-0 px-5 py-3 border-b border-surface-border text-sm bg-surface-sunken">
    <div role="status" className="text-ink font-medium">Remote · {remotePhase(status.phase)}{status.phase === 'uploading' && ` · ${(status.bytesUploaded / 1048576).toFixed(1)} / ${((status.totalBytes ?? 0) / 1048576).toFixed(1)} MiB`}</div>
    <p className="text-xs text-ink-muted">{status.endpoint}{status.lastContact && ` · Last contact ${new Date(status.lastContact).toLocaleTimeString()}`}</p>
    {status.error && <p className="text-xs text-ink-muted mt-1">{status.error}</p>}
    <div className="flex gap-4 mt-2">
      {['offline', 'failed', 'cancelled'].includes(status.phase) && <button disabled={busy} className="text-brand-indigo" onClick={() => void action('retry')}>Retry / reconnect</button>}
      {status.phase === 'conflict' && <button disabled={busy} className="text-brand-indigo" onClick={() => { void api.remote.review(meetingId).then(setReview).catch(e => setMessage(String(e))); }}>Review result</button>}
      {!['done', 'cancelled'].includes(status.phase) && <button disabled={busy} className="text-ink-muted" onClick={() => void action('cancel')}>Cancel remote run</button>}
      {['offline', 'failed', 'cancelled', 'conflict'].includes(status.phase) && <button disabled={busy} className="text-brand-indigo" onClick={() => void action('local')}>Process locally</button>}
    </div>
    {review && <div className="mt-3 space-y-2">
      <p>Your local content changed after submission. Keep it, or explicitly replace the generated artifacts below. The displaced local files are retained beside this remote generation.</p>
      {review.summary ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs bg-surface p-3">{review.summary}</pre> : <p>Audio analysis contains a new transcript and speaker segments. Current manual speaker assignments will be preserved.</p>}
      <p className="text-xs text-ink-muted break-all">Saved generation: {review.generation}</p>
      <div className="flex gap-4"><button disabled={busy} className="text-brand-indigo" onClick={() => void resolve(false)}>Keep local content</button><button disabled={busy} className="text-danger" onClick={() => void resolve(true)}>Replace with reviewed remote result</button></div>
    </div>}
    {message && <p role="alert" className="text-danger">{message}</p>}
  </section>;
}
