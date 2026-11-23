// electron/renderer/src/views/settings/AdvancedSettings.tsx
// Advanced section: summary provider, LLM endpoint and model, and diagnostics.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../ipc/client';
import { isKnownReasoningModel } from '../../lib/reasoning-models';
import { Icon, IconLabel } from '../../components/icons';
import { buildDiagnosticsReport } from '../../lib/diagnostics-report';
import { useToast } from '../../components/Toasts';
import { formatLogTimestamp } from '../../lib/log-timestamp.js';
import { effectiveLlmUrl as providerUrl, isIdleProbe } from '../../../../shared/inference-endpoints.js';
import { Field } from './Field';
import type { EditSetting, ProviderAvailability, Settings, UpdateSetting } from './types';

export function SummaryProviderSettings({
  s, edit, update, providers, models, modelsLoading, refreshModels, healthCheck, changeLlmModel, effectiveLlmUrl, providerLabel,
}: {
  s: Settings;
  edit: EditSetting;
  update: UpdateSetting;
  providers: ProviderAvailability | null;
  models: string[];
  modelsLoading: boolean;
  refreshModels: () => Promise<void>;
  healthCheck: { modelId: string; state: 'checking' | 'ok' | 'loops' } | null;
  changeLlmModel: (modelId: string) => Promise<void>;
  effectiveLlmUrl: string;
  providerLabel: string;
}): JSX.Element {
  return (
    <>
      <Field label="Summary provider (LLM lifecycle)">
        <select
          value={s.summaryProvider}
          onChange={(e) => void update('summaryProvider', e.target.value as Settings['summaryProvider']).then(saved => { if (saved) void refreshModels(); })}
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
            onChange={(e) => edit('lmStudioUrl', e.target.value)} onBlur={() => void update('lmStudioUrl', s.lmStudioUrl).then(saved => { if (saved) void refreshModels(); })}
            className="input flex-1"
          />
          <TestButton kind="llm" url={effectiveLlmUrl} lazySpawn={s.summaryProvider !== 'external'} onReachable={() => void refreshModels()} />
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
        <div className="flex gap-2">
        <select
          value={s.llmModel}
          onChange={(e) => void changeLlmModel(e.target.value)}
          className="input flex-1"
        >
          <option value="">(choose)</option>
          {/* The saved model stays selectable when the server does not list it
              right now (a managed server that is idle, or a model not loaded);
              without this the picker showed "(choose)" and looked unset. */}
          {s.llmModel && !models.includes(s.llmModel) && <option value={s.llmModel}>{s.llmModel} (saved — not listed by the server right now)</option>}
          {models.map((m) => (
            <option key={m} value={m}>
              {/* Plain-text only inside <option>; a suffix reads clearer
                  than the old 🧠 prefix and survives any platform's
                  emoji rendering. */}
              {isKnownReasoningModel(m) ? `${m} (reasoning)` : m}
            </option>
          ))}
        </select>
        <button type="button" className="btn-secondary shrink-0" disabled={modelsLoading} onClick={() => void refreshModels()}>{modelsLoading ? 'Refreshing…' : 'Refresh models'}</button>
        </div>
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
                ? 'This model looped on a quick extraction test — expect it to fail on real meetings too.'
                : <IconLabel icon="check">Passed a quick extraction canary.</IconLabel>}
          </div>
        )}
        {s.llmModel && isKnownReasoningModel(s.llmModel) && (
          <div className="text-xs text-status-warnText bg-status-warnBg border border-status-warn/30 rounded-lg px-2.5 py-1.5 mt-1.5 flex items-start gap-2">
            <Icon name="brain" className="w-4 h-4 shrink-0 mt-px" />
            <span>
              This looks like a reasoning model. It may ignore &ldquo;Disable model thinking&rdquo; below
              and burn its token budget on chain-of-thought instead of answering — watch for
              extract/summarize failures that mention a large &ldquo;reasoning&rdquo; word count.
            </span>
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
            exhaust memory on smaller Macs. If the model is already loaded with a smaller
            context, MeetingNotes reloads it with this one before the next LLM call.
          </div>
        </Field>
      )}
    </>
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
export function DiagnosticsSection(): JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [logPath, setLogPath] = useState<string>('');
  const [filter, setFilter] = useState<LogFilter>('warn');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();

  /** App version, active provider and model, setup health and the log as
   *  filtered on screen, as plain text for an issue or a support thread. */
  async function copyDiagnostics(): Promise<void> {
    try {
      const [version, settings, health] = await Promise.all([
        api.app.getVersion().catch(() => ''),
        api.settings.getAll() as Promise<Settings>,
        api.permissions.setupHealth().catch(() => []),
      ]);
      await navigator.clipboard.writeText(buildDiagnosticsReport({
        version, provider: settings.summaryProvider, model: settings.llmModel,
        llmUrl: providerUrl(settings.summaryProvider, settings.lmStudioUrl), health, entries: shown,
        filterLabel: filter === 'error' ? 'errors' : filter === 'warn' ? 'warnings and errors' : 'all levels',
      }));
      toast.show({ message: 'Diagnostics copied', durationMs: 3000 });
    } catch (error) { toast.show({ message: `Could not copy diagnostics: ${(error as Error).message}`, variant: 'error' }); }
  }

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

  const shown = useMemo(() => {
    const rank: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    const minRank = filter === 'error' ? 3 : filter === 'warn' ? 2 : 0;
    return entries.filter((e) => (rank[e.level] ?? 1) >= minRank).reverse(); // newest first
  }, [entries, filter]);

  return (
    <section className="border-t border-surface-border pt-5 space-y-3">
      <div className="flex items-center gap-2">
        <div className="settings-section-title text-ink-muted font-semibold flex-1">
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
            type="button" aria-pressed={filter === val}
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
        <button type="button" className="btn-secondary" disabled={!loaded} onClick={() => void copyDiagnostics()}>Copy diagnostics</button>
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
  const time = formatLogTimestamp(entry.ts);
  const dataStr =
    entry.data && Object.keys(entry.data).length > 0
      ? JSON.stringify(entry.data)
      : '';
  return (
    <div className="px-3 py-1 border-b border-surface-border/50 last:border-b-0 flex gap-2">
      <span className="text-ink-muted/70 tabular-nums shrink-0 whitespace-nowrap" title={entry.ts ?? undefined}>{time}</span>
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
function TestButton({ url, lazySpawn = false, onReachable }: { kind: 'llm'; url: string; lazySpawn?: boolean;
  /** The server answered: the caller refreshes whatever depends on it (the model list). */
  onReachable?: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { ok: true; detail?: string }
    | { ok: false; error: string; code?: string }
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
      {
        const r = await api.llm.probe(url);
        if (r.ok) onReachable?.();
        setResult(r.ok
          ? { ok: true, detail: `${r.models.length} model${r.models.length === 1 ? '' : 's'} loaded` }
          : { ok: false, error: r.error, code: r.code });
      }
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
          <IconLabel icon="check">reachable{result.detail ? ` · ${result.detail}` : ''}</IconLabel>
        </span>
      )}
      {result && !result.ok && (
        // "Connection refused" on a service the app spawns on demand is the
        // normal idle state, not a failure — the managed
        // LLM runtimes shut down after 10 min. Only unexpected responses
        // (wrong port answering with 404s, timeouts mid-request) stay red.
        isIdleProbe(lazySpawn, result.code) ? (
          <span className="text-xs text-ink-muted whitespace-nowrap">
            <IconLabel icon="circle">not running — starts on demand when needed</IconLabel>
          </span>
        ) : (
          <span className="text-xs text-danger truncate max-w-[16rem]" title={result.error}>
            <IconLabel icon="x">{result.error}</IconLabel>
          </span>
        )
      )}
    </div>
  );
}
