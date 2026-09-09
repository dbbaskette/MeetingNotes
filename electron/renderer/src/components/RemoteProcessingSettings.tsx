import { useEffect, useState } from 'react';
import { api } from '../ipc/client';

export function RemoteProcessingSettings(): JSX.Element {
  const [config, setConfig] = useState<Awaited<ReturnType<typeof api.remote.configuration>> | null>(null);
  const [mode, setMode] = useState<'local' | 'remote'>('local');
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { void api.remote.configuration().then(c => { setConfig(c); setMode(c.mode); setEndpoint(c.endpoint); }).catch(() => setMessage('Remote settings are unavailable.')); }, []);
  async function test(): Promise<void> {
    setBusy(true); setMessage('Testing connection…');
    try { const c = await api.remote.test(endpoint, token); setConfig(c); setEndpoint(c.endpoint); setMessage('Connection verified. Save to enable remote processing.'); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Connection test failed.'); }
    finally { setToken(''); setBusy(false); }
  }
  async function save(): Promise<void> {
    setBusy(true);
    try { const c = await api.remote.setMode(mode); setConfig(c); setMessage(mode === 'remote' ? 'New meetings will use this remote server.' : 'New meetings will process on this Mac. Existing remote runs keep their server.'); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Could not save processing location.'); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="remote-processing-title" className="space-y-3 border-b border-surface-border pb-5">
    <h2 id="remote-processing-title" className="text-base font-semibold text-ink">Processing location</h2>
    <label className="block text-sm text-ink-muted">Meeting processing
      <select className="input mt-1" value={mode} onChange={e => setMode(e.target.value as 'local' | 'remote')} disabled={busy}>
        <option value="local">On this Mac</option><option value="remote">Remote server</option>
      </select>
    </label>
    {mode === 'remote' && <>
      <p className="text-sm text-ink-muted">Processing uploads the selected recording and, after speaker review or skip, a labeled transcript to your server. The server generates and returns the transcript, speaker embeddings, summary, and action items. Your voice roster stays on this Mac. Closing the app does not cancel accepted jobs.</p>
      <label className="block text-sm text-ink-muted">Server URL
        <input className="input mt-1" type="url" placeholder="https://meeting-processing.example.com" value={endpoint} onChange={e => setEndpoint(e.target.value)} disabled={busy} />
      </label>
      <label className="block text-sm text-ink-muted">API token — enter to connect or replace
        <input className="input mt-1" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} disabled={busy} />
      </label>
      <p className="text-xs text-ink-muted">Stored with macOS Keychain encryption. The token is never read back into this form.</p>
      <button className="text-sm text-brand-indigo disabled:opacity-50" disabled={busy || !endpoint || token.length < 32} onClick={() => void test()}>Test connection</button>
      {config?.testedAt && <p className="text-xs text-ink-muted">Verified {config.endpoint} · {config.profile} · {config.serviceId}</p>}
    </>}
    <button className="block text-sm font-medium text-brand-indigo disabled:opacity-50" disabled={busy || !config || (mode === 'remote' && (!config.testedAt || config.endpoint !== endpoint || !!token))} onClick={() => void save()}>Save processing location</button>
    <p role="status" className="text-sm text-ink-muted">{message}</p>
    <p className="text-xs text-ink-muted">Local models below are optional for remote meeting processing. Weekly recaps and auxiliary AI tools still use local settings.</p>
  </section>;
}
