// electron/renderer/src/views/settings/IntegrationsSettings.tsx
// Integrations section: Google account and webhook exporter cards.
import { useEffect, useState } from 'react';
import { api } from '../../ipc/client';
import { Icon, IconLabel } from '../../components/icons';
import { Field } from './Field';
import type { Settings } from './types';

/** Google account card. BYO OAuth credentials (Client ID + Secret from a
 *  Google Cloud "Desktop" client) + sign-in, which enables the Google Tasks
 *  and Google Doc exporters. The refresh token is stored encrypted in the
 *  main process (safeStorage); this card only holds the non-secret client
 *  id/secret and shows the connected account. */
export function GoogleAccountCard({
  settings,
  onUpdate,
  onPersist,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
  onPersist: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<boolean>;
}): JSX.Element {
  const [status, setStatus] = useState<{ email: string | null; hasCredentials: boolean; signedIn: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  async function refresh(): Promise<void> {
    setStatus(await api.google.authStatus());
  }
  useEffect(() => { void refresh(); }, []);

  const hasCreds = settings.googleClientId.trim().length > 0 && settings.googleClientSecret.trim().length > 0;

  async function signIn(): Promise<void> {
    setBusy(true); setError(null);
    try {
      if (!await onPersist('googleClientId', settings.googleClientId) || !await onPersist('googleClientSecret', settings.googleClientSecret))
        throw new Error('Save valid Google credentials before connecting');
      await api.google.authStart();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function signOut(): Promise<void> {
    setBusy(true); setError(null);
    try { await api.google.signOut(); await refresh(); }
    finally { setBusy(false); }
  }

  return (
    <section className="border-t border-surface-border pt-5">
      <div className="settings-section-title text-ink-muted font-semibold mb-2">Google account</div>
      <p className="text-xs text-ink-muted mb-3">
        Connect a Google account to export action items to <strong>Google Tasks</strong> and meetings to a <strong>Google Doc</strong>.
      </p>

      {status?.signedIn ? (
        <div className="flex items-center gap-3 bg-status-okBg/40 border border-status-ok/30 rounded-lg px-3 py-2.5">
          <span className="text-status-ok"><Icon name="check" className="w-3.5 h-3.5" /></span>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-ink">Connected</div>
            <div className="text-xs text-ink-muted truncate">{status.email ?? 'Google account'}</div>
          </div>
          <button
            onClick={() => void signOut()}
            disabled={busy}
            className="text-xs font-semibold text-ink-muted hover:text-danger-text px-3 py-1.5 rounded-lg border border-surface-border hover:border-danger-border disabled:opacity-50 transition"
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="OAuth Client ID">
            <input
              value={settings.googleClientId}
              onChange={(e) => onUpdate({googleClientId: e.target.value})} onBlur={() => void onPersist('googleClientId', settings.googleClientId)}
              placeholder="xxxxxxxx.apps.googleusercontent.com"
              className="input font-mono text-xs"
            />
          </Field>
          <Field label="OAuth Client Secret">
            <input
              type="password"
              value={settings.googleClientSecret}
              onFocus={(e) => e.target.select()}
              onChange={(e) => onUpdate({googleClientSecret: e.target.value})} onBlur={() => void onPersist('googleClientSecret', settings.googleClientSecret)}
              placeholder="GOCSPX-…"
              className="input font-mono text-xs"
            />
          </Field>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void signIn()}
              disabled={!hasCreds || busy}
              className="text-sm font-semibold bg-brand-solid text-white px-4 py-1.5 rounded-lg hover:bg-brand-solid/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
              title={hasCreds ? undefined : 'Enter your Client ID and Secret first'}
            >
              {busy ? 'Connecting…' : 'Sign in with Google'}
            </button>
            <button
              onClick={() => setShowHelp((v) => !v)}
              className="text-xs text-brand-indigo hover:underline"
            >
              How to get these
            </button>
          </div>
          {showHelp && (
            <ol className="text-[11px] text-ink-muted list-decimal pl-4 space-y-1 bg-surface-sunken/50 rounded-lg p-3">
              <li>Open <span className="font-mono">console.cloud.google.com</span> → create a project.</li>
              <li>Enable the <strong>Google Tasks API</strong> and <strong>Google Drive API</strong>.</li>
              <li>Configure the OAuth consent screen (External); add the Tasks &amp; drive.file scopes; publish to <strong>Production</strong> so the sign-in lasts (testing mode expires weekly).</li>
              <li>Create credentials → <strong>OAuth client ID</strong> → application type <strong>Desktop app</strong>.</li>
              <li>Copy the Client ID + Client Secret here and Sign in. (Full guide: docs/google-setup.md)</li>
            </ol>
          )}
        </div>
      )}
      {error && <div className="text-[11px] text-danger mt-2">{error}</div>}
    </section>
  );
}

/** Webhook exporter card. Local state for the URL / secret / template /
 *  filter, persisted via `onPersist`. The "Send test payload" button
 *  POSTs a synthetic meeting.completed body via the same code path as
 *  the pipeline's auto-fire, so what you see here matches what real
 *  meetings would push. (#79) */
export function WebhookExporterCard({
  settings,
  onUpdate,
  onPersist,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
  onPersist: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<boolean>;
}): JSX.Element {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<Settings['webhookLastResult'] | null>(null);

  function set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    onUpdate({ [key]: value } as Partial<Settings>);
    onPersist(key, value);
  }

  async function runTest(): Promise<void> {
    setTesting(true); setTestResult(null);
    try {
      for (const key of ['webhookUrl', 'webhookSecret', 'webhookTemplate', 'webhookOwnerFilter'] as const) {
        if (!await onPersist(key, settings[key])) {setTestResult({ts: new Date().toISOString(),status: null,error: 'Save valid webhook settings before sending a test'}); return;}
      }
      const r = await api.webhook.testSend();
      setTestResult(r);
    } finally {
      setTesting(false);
    }
  }

  const lastResult = testResult ?? settings.webhookLastResult;

  return (
    <section className="border-t border-surface-border pt-5">
      <div className="settings-section-title text-ink-muted font-semibold mb-2">Webhook exporter</div>
      <label className="flex items-start gap-3 cursor-pointer mb-3">
        <input
          type="checkbox"
          checked={settings.exporterWebhook}
          onChange={(e) => set('exporterWebhook', e.target.checked)}
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className="text-sm text-ink">Push completed meetings to a webhook</div>
          <div className="text-xs text-ink-muted mt-0.5">
            When a meeting finishes (summary + action items done), POST the
            payload to an HTTPS endpoint. Use it to forward results to
            Telegram, Slack, or your own automation. Retries 3× on 5xx /
            network errors with exponential backoff.
          </div>
        </div>
      </label>
      {settings.exporterWebhook && (
        <div className="space-y-3 pl-7">
          <Field label="Webhook URL (HTTPS)">
            <input
              value={settings.webhookUrl}
              onChange={(e) => onUpdate({webhookUrl: e.target.value})} onBlur={() => onPersist('webhookUrl', settings.webhookUrl)}
              placeholder="https://example.com/hooks/meetingnotes"
              className="input"
              spellCheck={false}
            />
          </Field>
          <Field label="Bearer token (optional)">
            <input
              type="password"
              value={settings.webhookSecret}
              onFocus={(e) => e.target.select()}
              onChange={(e) => onUpdate({webhookSecret: e.target.value})} onBlur={() => onPersist('webhookSecret', settings.webhookSecret)}
              placeholder="Sent as Authorization: Bearer …"
              className="input"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <Field label="Payload template">
            <select
              value={settings.webhookTemplate}
              onChange={(e) => set('webhookTemplate', e.target.value as Settings['webhookTemplate'])}
              className="input"
            >
              <option value="compact">Compact JSON (summary + action items, no transcript)</option>
              <option value="full">Full JSON (includes transcript markdown)</option>
              <option value="telegram-markdown">Telegram sendMessage (Markdown)</option>
              <option value="slack-blocks">Slack Block Kit</option>
            </select>
          </Field>
          <Field label="Include which action items">
            <select
              value={settings.webhookOwnerFilter}
              onChange={(e) => set('webhookOwnerFilter', e.target.value as Settings['webhookOwnerFilter'])}
              className="input"
            >
              <option value="mine">Only mine (assigned to my speaker)</option>
              <option value="all">All items</option>
              <option value="none">None (summary only)</option>
            </select>
          </Field>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={testing || !settings.webhookUrl}
              className="text-xs font-semibold px-3 py-1.5 rounded-md border border-surface-border bg-surface hover:border-ink/30 hover:text-ink text-ink-muted disabled:opacity-50 disabled:cursor-not-allowed transition shrink-0"
            >
              {testing ? 'Sending…' : 'Send test payload'}
            </button>
            {lastResult && lastResult.error == null && (
              <span className="text-xs text-status-ok font-medium">
                <IconLabel icon="check">HTTP {lastResult.status} at {new Date(lastResult.ts).toLocaleTimeString()}</IconLabel>
              </span>
            )}
            {lastResult && lastResult.error != null && (
              <span className="text-xs text-danger truncate max-w-[20rem]" title={lastResult.error}>
                <IconLabel icon="x">{lastResult.error}</IconLabel>
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
