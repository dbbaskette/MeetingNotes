// electron/renderer/src/views/SettingsView.tsx
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../ipc/client';
import { isKnownReasoningModel } from '../lib/reasoning-models';

interface Settings {
  lmStudioUrl: string;
  sttUrl: string;
  sttModel: string;
  llmModel: string;
  audioHijackSessionName: string;
  libraryPath: string;
  audioWatchPath: string;
  sttLanguage: string;
  exporterApple: boolean;
  exporterMarkdown: boolean;
  exporterWebhook: boolean;
  webhookUrl: string;
  webhookSecret: string;
  webhookTemplate: 'compact' | 'full' | 'telegram-markdown' | 'slack-blocks';
  webhookOwnerFilter: 'mine' | 'all' | 'none';
  webhookLastResult: { ts: string; status: number | null; error: string | null } | null;
  recordingBitrateKbps: number;
  autoDetectMeetings: {
    browserTabs: boolean;
    nativeApps: boolean;
    silenceMs: number;
  };
  autoRecordZoom: boolean;
  userName: string;
  userSpeakerId: string | null;
  summaryProvider: 'external' | 'lm-studio' | 'ollama';
  llmContextLength: number;
  summaryDetail: 'concise' | 'standard' | 'detailed';
  disableThinking: boolean;
  theme: 'system' | 'light' | 'dark';
  googleClientId: string;
  googleClientSecret: string;
}

interface SpeakerListEntry { id: string; displayName: string }
interface ProviderAvailability {
  lmStudio: { binary: boolean; running: boolean };
  ollama: { binary: boolean; running: boolean };
}

type PermState = 'granted' | 'denied' | 'not-determined' | 'unknown';
interface AudioPerms { mic: PermState; audioCapture: PermState; }

export function SettingsView({
  onBack,
  onRunSetupAgain,
}: {
  onBack: () => void;
  onRunSetupAgain?: () => void;
}): JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [perms, setPerms] = useState<AudioPerms | null>(null);
  const [speakers, setSpeakers] = useState<SpeakerListEntry[]>([]);
  const [providers, setProviders] = useState<ProviderAvailability | null>(null);
  const [healthCheck, setHealthCheck] = useState<{ modelId: string; state: 'checking' | 'ok' | 'loops' } | null>(null);

  useEffect(() => {
    void (async () => {
      setS((await api.settings.getAll()) as Settings);
      setModels((await api.models.list()) as string[]);
      setPerms((await api.permissions.audio()) as AudioPerms);
      setSpeakers((await api.speakers.list()) as SpeakerListEntry[]);
      setProviders((await api.llm.detectProviders()) as ProviderAvailability);
    })();
  }, []);

  if (!s) return <div className="p-8">Loading…</div>;

  // The chat client follows the active provider, not the LM Studio URL field —
  // managed modes hardcode their ports (see LMStudioClient wiring in main).
  // Test buttons and captions must probe the same endpoint the pipeline uses,
  // otherwise a healthy ollama setup "fails" a test against :1234.
  const effectiveLlmUrl =
    s.summaryProvider === 'lm-studio' ? 'http://127.0.0.1:1234'
    : s.summaryProvider === 'ollama' ? 'http://127.0.0.1:11434'
    : s.lmStudioUrl;
  const providerLabel =
    s.summaryProvider === 'lm-studio' ? 'LM Studio, managed'
    : s.summaryProvider === 'ollama' ? 'Ollama, managed'
    : 'external server';

  async function update<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    setS((prev) => (prev ? { ...prev, [key]: value } : prev));
    await api.settings.set(key, value);
  }

  async function changeLlmModel(modelId: string): Promise<void> {
    await update('llmModel', modelId);
    if (!modelId) { setHealthCheck(null); return; }
    setHealthCheck({ modelId, state: 'checking' });
    try {
      const result = await api.llm.healthCheckModel(modelId);
      setHealthCheck({ modelId, state: result.verdict });
    } catch {
      setHealthCheck(null); // best-effort canary; don't block the UI on a failed check
    }
  }

  async function recheckPerms(): Promise<void> {
    setPerms((await api.permissions.audio()) as AudioPerms);
  }

  async function refreshSpeakers(): Promise<void> {
    setSpeakers((await api.speakers.list()) as SpeakerListEntry[]);
  }

  return (
    <div className="h-full flex flex-col max-w-2xl mx-auto w-full">
      <header className="shrink-0 flex items-center gap-3 px-8 pt-8 pb-4 border-b border-surface-border">
        <button onClick={onBack} className="text-ink-muted text-sm">
          ← Back
        </button>
        <h1 className="font-semibold">Settings</h1>
        {onRunSetupAgain && (
          <button
            onClick={onRunSetupAgain}
            className="ml-auto text-sm text-brand-indigo hover:underline"
          >
            Run setup again
          </button>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-8 py-6 space-y-5">
      <Field label="Summary provider (LLM lifecycle)">
        <select
          value={s.summaryProvider}
          onChange={(e) => update('summaryProvider', e.target.value as Settings['summaryProvider'])}
          className="input"
        >
          <option value="external">External — I run LM Studio / Ollama myself</option>
          <option value="lm-studio" disabled={providers != null && !providers.lmStudio.binary}>
            LM Studio (managed) {providers && !providers.lmStudio.binary ? '— `lms` CLI not found' : providers?.lmStudio.running ? '— already running' : ''}
          </option>
          <option value="ollama" disabled={providers != null && !providers.ollama.binary}>
            Ollama (managed) {providers && !providers.ollama.binary ? '— ollama not installed' : providers?.ollama.running ? '— already running' : ''}
          </option>
        </select>
        <div className="text-xs text-ink-muted mt-1">
          <strong>External</strong> matches the original behavior — you start the
          server yourself and MeetingNotes just POSTs to it.
          <br />
          <strong>LM Studio</strong> / <strong>Ollama</strong> have MeetingNotes spawn the server
          on demand (first summary wakes it) and shut it down after 10 min of idle to free RAM.
        </div>
      </Field>
      <Field label="LM Studio URL (chat / LLM)">
        <div className="flex gap-2">
          <input
            value={s.lmStudioUrl}
            onChange={(e) => update('lmStudioUrl', e.target.value)}
            className="input flex-1"
          />
          <TestButton kind="llm" url={effectiveLlmUrl} lazySpawn={s.summaryProvider !== 'external'} />
        </div>
        <div className="text-xs text-ink-muted mt-1">
          Default for the &lsquo;external&rsquo; provider. Managed providers use their own
          ports (1234 for LM Studio, 11434 for Ollama).
          {s.summaryProvider !== 'external' && (
            <> Test probes the active provider at <code>{effectiveLlmUrl}</code>.</>
          )}
        </div>
      </Field>
      <Field label="LLM Model">
        <select
          value={s.llmModel}
          onChange={(e) => void changeLlmModel(e.target.value)}
          className="input"
        >
          <option value="">(choose)</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {isKnownReasoningModel(m) ? `🧠 ${m}` : m}
            </option>
          ))}
        </select>
        {healthCheck && healthCheck.modelId === s.llmModel && (
          <div className={`text-xs mt-1.5 px-2.5 py-1 rounded-lg border ${
            healthCheck.state === 'checking'
              ? 'text-ink-muted border-surface-border bg-surface-sunken'
              : healthCheck.state === 'loops'
                ? 'text-status-warnText border-status-warn/30 bg-status-warnBg'
                : 'text-status-ok border-status-ok/30 bg-status-okBg/40'
          }`}>
            {healthCheck.state === 'checking'
              ? 'Checking whether this model tends to loop on structured tasks…'
              : healthCheck.state === 'loops'
                ? '⚠ This model looped on a quick extraction test — expect it to fail on real meetings too.'
                : '✓ Passed a quick extraction canary.'}
          </div>
        )}
        {s.llmModel && isKnownReasoningModel(s.llmModel) && (
          <div className="text-xs text-status-warnText bg-status-warnBg border border-status-warn/30 rounded-lg px-2.5 py-1.5 mt-1.5">
            🧠 This looks like a reasoning model. It may ignore &ldquo;Disable model thinking&rdquo; below
            and burn its token budget on chain-of-thought instead of answering — watch for
            extract/summarize failures that mention a large &ldquo;reasoning&rdquo; word count.
          </div>
        )}
        <div className="text-xs text-ink-muted mt-1">
          Loaded from {effectiveLlmUrl}/v1/models ({providerLabel}). Used for
          summarization and action-item extraction.
        </div>
      </Field>
      {s.summaryProvider === 'lm-studio' && (
        <Field label="Context length (managed LM Studio)">
          <select
            value={String(s.llmContextLength)}
            onChange={(e) => update('llmContextLength', Number(e.target.value))}
            className="input"
          >
            <option value="0">Model default (LM Studio setting — often 4k)</option>
            <option value="8192">8k — short meetings, low RAM</option>
            <option value="16384">16k — up to ~1 hour</option>
            <option value="32768">32k — long meetings (recommended if you have the RAM)</option>
          </select>
          <div className="text-xs text-ink-muted mt-1">
            Passed as <code>--context-length</code> when MeetingNotes auto-loads the model.
            Too-small contexts silently truncate long transcripts; too-large ones can
            exhaust memory on smaller Macs. Applies at the next model load.
          </div>
        </Field>
      )}
      <Field label="Summary detail level">
        <select
          value={s.summaryDetail}
          onChange={(e) => update('summaryDetail', e.target.value as Settings['summaryDetail'])}
          className="input"
        >
          <option value="concise">Concise — tight, skimmable, one bullet per point</option>
          <option value="standard">Standard — balanced detail vs. brevity</option>
          <option value="detailed">Detailed — full context, trade-offs, reasoning</option>
        </select>
        <div className="text-xs text-ink-muted mt-1">
          Steers how verbose the summary prompt asks the model to be, so the level
          stays consistent across different local models. Applies to the next summary.
        </div>
      </Field>
      <Field label="Disable model &lsquo;thinking&rsquo;">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={s.disableThinking}
            onChange={(e) => update('disableThinking', e.target.checked)}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-sm text-ink">Tell the model to skip its chain-of-thought (recommended)</div>
            <div className="text-xs text-ink-muted mt-1">
              Reasoning-capable models (Gemma 4, Qwen3, DeepSeek-R1, gpt-oss) can burn
              their whole token budget &ldquo;thinking&rdquo; and return no summary — which
              looks like an out-of-memory error but isn&rsquo;t. Leaving this on sends
              <code className="mx-1">enable_thinking: false</code> so even small models
              answer directly. Turn off only if a model misbehaves with it.
            </div>
          </div>
        </label>
      </Field>
      <Field label="Appearance">
        <div className="inline-flex rounded-lg border border-surface-border overflow-hidden">
          {(['system', 'light', 'dark'] as const).map((opt) => (
            <button
              key={opt}
              onClick={() => {
                void update('theme', opt);
                window.dispatchEvent(new CustomEvent('mn:theme-changed', { detail: opt }));
              }}
              className={`px-4 py-1.5 text-sm capitalize transition border-l border-surface-border first:border-l-0 ${
                s.theme === opt
                  ? 'bg-surface-sunken text-ink font-medium'
                  : 'text-ink-muted hover:text-ink hover:bg-surface-sunken'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
        <div className="text-xs text-ink-muted mt-1">
          System follows macOS appearance. Light and Dark override it.
        </div>
      </Field>
      <Field label="STT URL (whisper.cpp server)">
        <div className="flex gap-2">
          <input
            value={s.sttUrl}
            onChange={(e) => update('sttUrl', e.target.value)}
            className="input flex-1"
          />
          <TestButton kind="stt" url={s.sttUrl} />
        </div>
        <div className="text-xs text-ink-muted mt-1">
          Default http://127.0.0.1:8080. MeetingNotes auto-launches whisper-server
          on first transcription and shuts it down after 10 minutes of inactivity.
        </div>
      </Field>
      <Field label="STT Model name">
        <input
          value={s.sttModel}
          onChange={(e) => update('sttModel', e.target.value)}
          className="input"
        />
        <div className="text-xs text-ink-muted mt-1">
          The model file to load when starting whisper-server. Must be installed in
          ~/Library/Application Support/MeetingNotes/whisper-models/ggml-&lt;name&gt;.bin
          (use the setup wizard&apos;s Whisper step to download one).
        </div>
      </Field>
      <Field label="Library Path">
        <input
          value={s.libraryPath}
          onChange={(e) => update('libraryPath', e.target.value)}
          className="input"
        />
      </Field>
      <StoragePanel />
      <Field label="Extra watch folder">
        <input
          value={s.audioWatchPath}
          onChange={(e) => update('audioWatchPath', e.target.value)}
          placeholder="(none)"
          className="input"
        />
        <div className="text-xs text-ink-muted mt-1">
          Optional. An extra folder watched for dropped audio. Your library&rsquo;s
          recordings folder and the legacy ~/Music/MeetingNotes are always watched.
        </div>
      </Field>
      <Field label="STT Language">
        <input
          value={s.sttLanguage}
          onChange={(e) => update('sttLanguage', e.target.value)}
          className="input"
        />
      </Field>
      <Field label="Your name">
        <input
          value={s.userName}
          onChange={(e) => update('userName', e.target.value)}
          placeholder="You"
          className="input"
        />
        <div className="text-xs text-ink-muted mt-1">
          Used to label your voice in transcripts when dual-stem capture
          is active. Leave blank to just see &ldquo;You&rdquo;.
        </div>
      </Field>
      <Field label="You are…">
        <select
          value={s.userSpeakerId ?? ''}
          onChange={(e) => update('userSpeakerId', e.target.value === '' ? null : e.target.value)}
          className="input"
        >
          <option value="">— not set —</option>
          {speakers.map((sp) => (
            <option key={sp.id} value={sp.id}>{sp.displayName}</option>
          ))}
        </select>
        <div className="text-xs text-ink-muted mt-1">
          The roster speaker that represents you. When set, the Weekly view
          pins your open action items to the top in a &ldquo;You&rdquo; group.
          Confirm a speaker as yourself in any meeting&rsquo;s Speakers panel
          first to populate this list.
        </div>
      </Field>

      <section className="border-t border-surface-border pt-5">
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold mb-2">Speakers</div>
        <div className="text-xs text-ink-muted mb-3">
          Everyone you&rsquo;ve identified across meetings. Rename fixes a
          misspelling everywhere; merge collapses duplicates (&ldquo;Dan&rdquo; /
          &ldquo;Dan B.&rdquo;) into one person. Both rewrite the affected
          transcripts with the surviving name.
        </div>
        {speakers.length === 0 ? (
          <div className="text-xs text-ink-muted italic">
            No speakers yet — confirm a voice in any meeting&rsquo;s Speakers panel first.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {speakers.map((sp) => (
              <SpeakerRosterRow
                key={sp.id}
                speaker={sp}
                others={speakers.filter((o) => o.id !== sp.id)}
                onChanged={refreshSpeakers}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="border-t border-surface-border pt-5">
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold mb-2">Recording quality</div>
        <label className="block">
          <div className="text-sm text-ink mb-1">AAC bitrate</div>
          <select
            value={s.recordingBitrateKbps}
            onChange={(e) => update('recordingBitrateKbps', Number(e.target.value))}
            className="input"
          >
            <option value={96}>96 kbps (smallest files)</option>
            <option value={128}>128 kbps (balanced — default)</option>
            <option value={192}>192 kbps (highest quality)</option>
          </select>
          <div className="text-xs text-ink-muted mt-1">
            Applies to new recordings. Higher bitrate = bigger files but cleaner playback.
          </div>
        </label>
      </section>

      <section className="border-t border-surface-border pt-5">
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold mb-2">Meeting auto-detect</div>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={s.autoDetectMeetings.browserTabs}
            onChange={(e) => update('autoDetectMeetings', { ...s.autoDetectMeetings, browserTabs: e.target.checked })}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-sm text-ink">Watch browser tabs for meeting URLs</div>
            <div className="text-xs text-ink-muted mt-0.5">
              When a tab in Chrome, Safari, Arc, Edge, or Brave opens a known
              meeting URL (Meet, Zoom web, Teams, Whereby, Jitsi, …), a banner
              offers to start recording. Requires granting MeetingNotes
              Automation permission for each browser you use (macOS will
              prompt the first time).
            </div>
            <div className="text-xs text-ink-muted mt-1">
              Note: the recorder captures the whole browser process, so audio
              from other tabs (YouTube, etc.) will bleed in.
            </div>
          </div>
        </label>
        <label className="flex items-start gap-3 cursor-pointer mt-3">
          <input
            type="checkbox"
            checked={s.autoDetectMeetings.nativeApps}
            onChange={(e) => update('autoDetectMeetings', { ...s.autoDetectMeetings, nativeApps: e.target.checked })}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-sm text-ink">Watch native meeting apps (Zoom, Teams, FaceTime, Slack, Discord, WhatsApp)</div>
            <div className="text-xs text-ink-muted mt-0.5">
              Fires when one of those apps starts producing audio. A banner
              offers to record the app directly — no need to pick the source
              in the Record menu. Brief notification beeps are filtered out
              by a {Math.round(s.autoDetectMeetings.silenceMs / 1000)}-second
              sustained-audio threshold. Dismissing the banner suppresses
              that app for 15 minutes.
            </div>
          </div>
        </label>
        {/* Per-app auto-record (#78 follow-up). Indented under the native
            toggle because it's a no-op when the parent isn't on. Zoom-only
            in v1; the wiring is parameterized in main so additional apps
            can join later as separate toggles. */}
        <label className={`flex items-start gap-3 cursor-pointer mt-3 ml-6 ${s.autoDetectMeetings.nativeApps ? '' : 'opacity-50'}`}>
          <input
            type="checkbox"
            checked={s.autoRecordZoom}
            disabled={!s.autoDetectMeetings.nativeApps}
            onChange={(e) => update('autoRecordZoom', e.target.checked)}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-sm text-ink">Always record Zoom — skip the confirm banner</div>
            <div className="text-xs text-ink-muted mt-0.5">
              When Zoom starts producing audio, MeetingNotes begins
              recording immediately. Other meeting apps still surface the
              confirm-first banner. Requires the native-app detector
              above to be on.
            </div>
          </div>
        </label>
      </section>

      <WebhookExporterCard
        settings={s}
        onUpdate={(patch) => setS((prev) => (prev ? { ...prev, ...patch } : prev))}
        onPersist={(key, value) => { void update(key, value); }}
      />

      <GoogleAccountCard
        settings={s}
        onUpdate={(patch) => setS((prev) => (prev ? { ...prev, ...patch } : prev))}
        onPersist={(key, value) => { void update(key, value); }}
      />

      <section className="border-t border-surface-border pt-5">
        <div className="flex items-center gap-2 mb-2">
          <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold flex-1">Permissions</div>
          <button
            onClick={recheckPerms}
            className="text-xs font-semibold text-brand-indigo hover:underline"
          >
            Recheck
          </button>
        </div>
        {perms === null ? (
          <div className="text-sm text-ink-muted">Checking…</div>
        ) : (
          <div className="space-y-1">
            <PermRow label="Microphone" state={perms.mic} />
            <PermRow label="System audio" state={perms.audioCapture} />
            <div className="text-xs text-ink-muted mt-2">
              Both must be granted for the built-in recorder to capture meeting audio. Open System Settings → Privacy &amp; Security to change either.
            </div>
          </div>
        )}
      </section>

      <DiagnosticsSection />
      </div>
    </div>
  );
}

interface LogEntry {
  ts: string | null;
  level: string;
  msg: string;
  data?: Record<string, unknown>;
}

type LogFilter = 'all' | 'warn' | 'error';

// In-app log viewer. Reads the tail of app.log (bounded in main) and shows
// the most recent entries newest-first so the latest failure is at the top.
// This is the surface that turns "a meeting failed, no idea why" into a
// readable answer without hunting through ~/Library/Logs.
function DiagnosticsSection(): JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [logPath, setLogPath] = useState<string>('');
  const [filter, setFilter] = useState<LogFilter>('warn');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const res = await api.logs.tail(500);
      setEntries(res.entries);
      setLogPath(res.path);
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const rank: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const minRank = filter === 'error' ? 3 : filter === 'warn' ? 2 : 0;
  const shown = entries
    .filter((e) => (rank[e.level] ?? 1) >= minRank)
    .reverse(); // newest first

  return (
    <section className="border-t border-surface-border pt-5 space-y-3">
      <div className="flex items-center gap-2">
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold flex-1">
          Diagnostics
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="text-xs font-semibold text-ink-muted hover:text-ink px-2 py-1 rounded-lg border border-surface-border hover:border-ink/30 disabled:opacity-50 transition"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          onClick={() => void api.logs.reveal()}
          className="text-xs font-semibold text-ink-muted hover:text-ink px-2 py-1 rounded-lg border border-surface-border hover:border-ink/30 transition"
        >
          Reveal in Finder
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        {([
          ['error', 'Errors'],
          ['warn', 'Warnings+'],
          ['all', 'All'],
        ] as const).map(([val, label]) => (
          <button
            key={val}
            onClick={() => setFilter(val)}
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition ${
              filter === val
                ? 'bg-ink text-surface border-ink'
                : 'text-ink-muted border-surface-border hover:border-ink/30'
            }`}
          >
            {label}
          </button>
        ))}
        <div className="flex-1" />
        <span className="text-[11px] text-ink-muted tabular-nums">
          {loaded ? `${shown.length} shown` : ''}
        </span>
      </div>

      <div className="rounded-lg border border-surface-border bg-surface-sunken/40 max-h-72 overflow-auto font-mono text-[11px] leading-relaxed">
        {!loaded ? (
          <div className="p-3 text-ink-muted">Loading logs…</div>
        ) : shown.length === 0 ? (
          <div className="p-3 text-ink-muted">No log entries at this level.</div>
        ) : (
          shown.map((e, i) => <LogRow key={i} entry={e} />)
        )}
      </div>

      {logPath && (
        <div className="text-[11px] text-ink-muted break-all">{logPath}</div>
      )}
    </section>
  );
}

function LogRow({ entry }: { entry: LogEntry }): JSX.Element {
  const levelCls =
    entry.level === 'error'
      ? 'text-danger'
      : entry.level === 'warn'
        ? 'text-status-warn'
        : entry.level === 'debug'
          ? 'text-ink-muted/60'
          : 'text-ink-muted';
  const time = entry.ts ? entry.ts.slice(11, 19) : '—';
  const dataStr =
    entry.data && Object.keys(entry.data).length > 0
      ? JSON.stringify(entry.data)
      : '';
  return (
    <div className="px-3 py-1 border-b border-surface-border/50 last:border-b-0 flex gap-2">
      <span className="text-ink-muted/70 tabular-nums shrink-0">{time}</span>
      <span className={`font-semibold uppercase shrink-0 w-10 ${levelCls}`}>
        {entry.level}
      </span>
      <span className="text-ink-soft break-all min-w-0">
        {entry.msg}
        {dataStr && <span className="text-ink-muted/70"> {dataStr}</span>}
      </span>
    </div>
  );
}

function PermRow({ label, state }: { label: string; state: PermState }): JSX.Element {
  const cls = state === 'granted'
    ? 'text-status-ok'
    : state === 'denied'
      ? 'text-danger'
      : 'text-ink-muted';
  const txt = state === 'granted' ? '✓ Granted'
    : state === 'denied' ? '✗ Denied'
      : state === 'not-determined' ? 'Not granted yet'
        : 'Unknown';
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="flex-1">{label}</span>
      <span className={`font-semibold ${cls}`}>{txt}</span>
    </div>
  );
}

/** Legible storage map (Option B). Recordings, meetings, and the database
 *  live under the Library Path (edited above); re-downloadable / derived data
 *  stays in the conventional macOS locations. The display strings mirror
 *  storageLocations() in electron/main/lib/storage-paths.ts; the Reveal
 *  buttons resolve the real (possibly relocated) paths in the main process. */
function StoragePanel(): JSX.Element {
  const rows: { key: string; label: string; path: string; note: string }[] = [
    {
      key: 'models',
      label: 'Models',
      path: '~/Library/Application Support/MeetingNotes/whisper-models',
      note: 'Whisper models — re-downloadable, kept out of iCloud.',
    },
    {
      key: 'logs',
      label: 'Logs',
      path: '~/Library/Logs/MeetingNotes',
      note: 'App logs.',
    },
    {
      key: 'hfCache',
      label: 'AI model cache',
      path: '~/.cache/huggingface',
      note: 'Diarization models + token — shared with other Hugging Face tools.',
    },
  ];
  return (
    <div className="rounded-lg border border-surface-border bg-surface-sunken/40 divide-y divide-surface-border">
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink flex-1">Library</span>
          <button
            onClick={() => void api.settings.revealStorage('library')}
            className="text-xs font-semibold text-ink-muted hover:text-ink px-2 py-1 rounded-lg border border-surface-border hover:border-ink/30 transition shrink-0"
          >
            Reveal in Finder
          </button>
        </div>
        <div className="text-xs text-ink-muted mt-0.5">
          Recordings, meetings, and the database (Library Path above).
        </div>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink flex-1">{r.label}</span>
            <button
              onClick={() => void api.settings.revealStorage(r.key)}
              className="text-xs font-semibold text-ink-muted hover:text-ink px-2 py-1 rounded-lg border border-surface-border hover:border-ink/30 transition shrink-0"
            >
              Reveal in Finder
            </button>
          </div>
          <div className="font-mono text-[11px] text-ink-muted mt-0.5 break-all">{r.path}</div>
          <div className="text-xs text-ink-muted mt-0.5">{r.note}</div>
        </div>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  // Per-field labels use a plain sans-serif treatment so they don't
  // compete with section headers (Permissions, Recording quality,
  // Meeting auto-detect) which keep the tracked-monospace style. The
  // form has 15+ field labels — making them all small-caps tracked
  // upper-case turned every label into an attention-grab and made the
  // section headers indistinguishable from fields.
  return (
    <label className="block">
      <div className="text-xs text-ink-muted font-medium mb-1">{label}</div>
      {children}
    </label>
  );
}

/** Inline "Test" button that probes the given URL and shows the result.
 *
 *  Three states:
 *    idle  — unstyled "Test" button, click to probe
 *    busy  — disabled "Testing…"
 *    done  — green ✓ "reachable, N models" / red ✗ "connection refused"
 *
 *  Surfaces config errors at edit time instead of letting them bite the
 *  user 5–15 minutes into a pipeline run. Result auto-clears after 6 s
 *  so the row doesn't accumulate stale state as the user keeps editing. */
function TestButton({ kind, url, lazySpawn = false }: { kind: 'stt' | 'llm'; url: string; lazySpawn?: boolean }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { ok: true; detail?: string }
    | { ok: false; error: string }
    | null
  >(null);

  useEffect(() => {
    if (!result) return;
    const t = window.setTimeout(() => setResult(null), 6000);
    return () => window.clearTimeout(t);
  }, [result]);

  // Editing the URL invalidates a stale result instantly — cleaner than
  // showing ✓ next to a URL the user just changed.
  useEffect(() => { setResult(null); }, [url]);

  async function probe(): Promise<void> {
    setBusy(true); setResult(null);
    try {
      if (kind === 'llm') {
        const r = await api.llm.probe(url);
        setResult(r.ok
          ? { ok: true, detail: `${r.models.length} model${r.models.length === 1 ? '' : 's'} loaded` }
          : { ok: false, error: r.error });
      } else {
        const r = await api.stt.probe(url);
        setResult(r.ok ? { ok: true } : { ok: false, error: r.error });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void probe()}
        disabled={busy || !url}
        className="text-xs font-semibold px-3 py-1.5 rounded-md border border-surface-border
                   bg-surface hover:border-ink/30 hover:text-ink text-ink-muted
                   disabled:opacity-50 disabled:cursor-not-allowed transition shrink-0"
      >
        {busy ? 'Testing…' : 'Test'}
      </button>
      {result?.ok && (
        <span className="text-xs text-status-ok font-medium whitespace-nowrap">
          ✓ reachable{result.detail ? ` · ${result.detail}` : ''}
        </span>
      )}
      {result && !result.ok && (
        // "Connection refused" on a service the app spawns on demand is the
        // normal idle state, not a failure — whisper-server and the managed
        // LLM runtimes shut down after 10 min. Only unexpected responses
        // (wrong port answering with 404s, timeouts mid-request) stay red.
        isIdleRefusal(kind === 'stt' || lazySpawn, result.error) ? (
          <span className="text-xs text-ink-muted whitespace-nowrap">
            ○ not running — starts on demand when needed
          </span>
        ) : (
          <span className="text-xs text-danger truncate max-w-[16rem]" title={result.error}>
            ✗ {result.error}
          </span>
        )
      )}
    </div>
  );
}

/** True when a probe failure just means "nothing is listening" on a service
 *  MeetingNotes lazily spawns (whisper always; LLM in managed modes). */
function isIdleRefusal(lazySpawn: boolean, error: string): boolean {
  const refused = /connection refused|ECONNREFUSED|fetch failed/i.test(error);
  return refused && lazySpawn;
}

/** Google account card. BYO OAuth credentials (Client ID + Secret from a
 *  Google Cloud "Desktop" client) + sign-in, which enables the Google Tasks
 *  and Google Doc exporters. The refresh token is stored encrypted in the
 *  main process (safeStorage); this card only holds the non-secret client
 *  id/secret and shows the connected account. */
function GoogleAccountCard({
  settings,
  onUpdate,
  onPersist,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
  onPersist: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}): JSX.Element {
  const [status, setStatus] = useState<{ email: string | null; hasCredentials: boolean; signedIn: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  async function refresh(): Promise<void> {
    setStatus(await api.google.authStatus());
  }
  useEffect(() => { void refresh(); }, []);

  function set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    onUpdate({ [key]: value } as Partial<Settings>);
    onPersist(key, value);
  }

  const hasCreds = settings.googleClientId.trim().length > 0 && settings.googleClientSecret.trim().length > 0;

  async function signIn(): Promise<void> {
    setBusy(true); setError(null);
    try {
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
      <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold mb-2">Google account</div>
      <p className="text-xs text-ink-muted mb-3">
        Connect a Google account to export action items to <strong>Google Tasks</strong> and meetings to a <strong>Google Doc</strong>.
      </p>

      {status?.signedIn ? (
        <div className="flex items-center gap-3 bg-status-okBg/40 border border-status-ok/30 rounded-lg px-3 py-2.5">
          <span className="text-status-ok">✓</span>
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
              onChange={(e) => set('googleClientId', e.target.value)}
              placeholder="xxxxxxxx.apps.googleusercontent.com"
              className="input font-mono text-xs"
            />
          </Field>
          <Field label="OAuth Client Secret">
            <input
              type="password"
              value={settings.googleClientSecret}
              onChange={(e) => set('googleClientSecret', e.target.value)}
              placeholder="GOCSPX-…"
              className="input font-mono text-xs"
            />
          </Field>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void signIn()}
              disabled={!hasCreds || busy}
              className="text-sm font-semibold bg-brand-indigo text-white px-4 py-1.5 rounded-lg hover:bg-brand-indigo/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
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
function WebhookExporterCard({
  settings,
  onUpdate,
  onPersist,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
  onPersist: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
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
      const r = await api.webhook.testSend();
      setTestResult(r);
    } finally {
      setTesting(false);
    }
  }

  const lastResult = testResult ?? settings.webhookLastResult;

  return (
    <section className="border-t border-surface-border pt-5">
      <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold mb-2">Webhook exporter</div>
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
              onChange={(e) => set('webhookUrl', e.target.value)}
              placeholder="https://example.com/hooks/meetingnotes"
              className="input"
              spellCheck={false}
            />
          </Field>
          <Field label="Bearer token (optional)">
            <input
              type="password"
              value={settings.webhookSecret}
              onChange={(e) => set('webhookSecret', e.target.value)}
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
                ✓ HTTP {lastResult.status} at {new Date(lastResult.ts).toLocaleTimeString()}
              </span>
            )}
            {lastResult && lastResult.error != null && (
              <span className="text-xs text-danger truncate max-w-[20rem]" title={lastResult.error}>
                ✗ {lastResult.error}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** One roster-management row: the speaker's name, an inline ✎ rename, and a
 *  "Merge into…" picker. Rename reuses the existing speakers:rename IPC;
 *  merge confirms first (it deletes this roster entry) then calls
 *  speakers:merge. Both rewrite the affected transcripts in main. */
function SpeakerRosterRow({
  speaker,
  others,
  onChanged,
}: {
  speaker: SpeakerListEntry;
  others: SpeakerListEntry[];
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(speaker.displayName);
  const [busy, setBusy] = useState(false);

  async function saveRename(): Promise<void> {
    const name = draft.trim();
    if (!name || name === speaker.displayName) { setEditing(false); setDraft(speaker.displayName); return; }
    setBusy(true);
    try {
      await api.speakers.rename(speaker.id, name);
      await onChanged();
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  async function mergeInto(targetId: string): Promise<void> {
    const target = others.find((o) => o.id === targetId);
    if (!target) return;
    const ok = window.confirm(
      `Merge "${speaker.displayName}" into "${target.displayName}"?\n\n` +
      `Their meetings and action items move to "${target.displayName}", ` +
      `"${speaker.displayName}" is removed from the roster, and the affected ` +
      'transcripts are rewritten. This can’t be undone.',
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api.speakers.merge(speaker.id, targetId);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center gap-2 rounded-lg border border-surface-border bg-surface px-3 py-1.5">
      {editing ? (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveRename();
            if (e.key === 'Escape') { setEditing(false); setDraft(speaker.displayName); }
          }}
          onBlur={() => void saveRename()}
          disabled={busy}
          autoFocus
          className="input flex-1 !py-1 text-sm"
          maxLength={200}
        />
      ) : (
        <>
          <span className="flex-1 min-w-0 text-sm text-ink truncate">{speaker.displayName}</span>
          <button
            type="button"
            onClick={() => { setDraft(speaker.displayName); setEditing(true); }}
            disabled={busy}
            title="Rename speaker"
            aria-label={`Rename ${speaker.displayName}`}
            className="text-xs text-ink-muted hover:text-ink px-1.5 py-0.5 rounded transition disabled:opacity-50"
          >
            ✎
          </button>
        </>
      )}
      {others.length > 0 && !editing && (
        <select
          value=""
          onChange={(e) => { if (e.target.value) void mergeInto(e.target.value); }}
          disabled={busy}
          title={`Merge ${speaker.displayName} into another speaker`}
          className="text-xs text-ink-muted bg-transparent border border-surface-border rounded-md px-1.5 py-0.5 max-w-[9rem] disabled:opacity-50"
        >
          <option value="">Merge into…</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>{o.displayName}</option>
          ))}
        </select>
      )}
    </li>
  );
}

