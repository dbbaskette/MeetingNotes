// First-run setup: capture permissions, native speech assets, and summaries.
import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import { type StepStatus, statusFromProbe } from '../lib/setup-wizard';
import { isKnownReasoningModel } from '../lib/reasoning-models';
import { Icon, IconLabel } from '../components/icons';
import logoUrl from '../assets/logo.png';
import { NativeSpeechPanel } from '../components/NativeSpeechPanel';
import type { TranscriptionEngine } from '../../../shared/native-speech';

interface Props {
  onFinished: () => void;
}

type StepKey = 'permissions' | 'native' | 'llm';
const STEPS: StepKey[] = ['permissions', 'native', 'llm'];
const STEP_LABELS: Record<StepKey, string> = { permissions: 'Permissions', native: 'Speech', llm: 'Summary model' };

/** Small colored pip a step reports up so the stepper bar reflects
 *  pending / checking / ok / warn without each step owning its own chrome. */
function StatusPip({ status, step }: { status: StepStatus; step?: string }): JSX.Element {
  const cls =
    status === 'ok' ? 'bg-status-ok'
      : status === 'warn' ? 'bg-status-warn'
        : status === 'checking' ? 'bg-brand-solid animate-pulse'
          : 'bg-surface-border';
  const label = status === 'ok' ? 'ready' : status === 'warn' ? 'needs attention' : status === 'checking' ? 'checking' : 'not started';
  return <span role="img" className={`inline-block w-2 h-2 rounded-full ${cls}`} aria-label={step ? `${step}: ${label}` : label} />;
}

export function OnboardingView({ onFinished }: Props): JSX.Element {
  const [idx, setIdx] = useState(0);
  const [language, setLanguage] = useState('en');
  // Setup keeps the built-in engine by default; someone who already chose
  // WhisperKit in Settings sees that engine's readiness here.
  const [engine, setEngine] = useState<TranscriptionEngine>('apple');
  useEffect(() => { void api.settings.getAll().then(s => { setLanguage(s.sttLanguage); setEngine(s.transcriptionEngine ?? 'apple'); }); }, []);
  const step = STEPS[idx]!;
  const [stepStatus, setStepStatus] = useState<Record<StepKey, StepStatus>>({
    permissions: 'pending', native: 'pending', llm: 'pending',
  });
  const setStatus = (k: StepKey, s: StepStatus): void =>
    setStepStatus((prev) => ({ ...prev, [k]: s }));

  const next = (): void => setIdx((i) => Math.min(i + 1, STEPS.length - 1));
  const finish = async (): Promise<void> => {
    await api.settings.set('onboardedAt', new Date().toISOString());
    onFinished();
  };
  const done = idx === STEPS.length - 1;

  return (
    <div className="onboarding-view max-w-xl mx-auto my-10 bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden">
      <div className="app-chrome detail-chrome px-6 py-4 border-b border-surface-border flex items-center gap-3">
        <img src={logoUrl} alt="" className="h-7 w-auto" />
        <div className="flex-1">
          <div className="font-semibold">Welcome to MeetingNotes</div>
          <div className="text-xs text-ink-muted">Setup · step {idx + 1} of {STEPS.length}</div>
        </div>
      </div>

      <div className="p-6 min-h-[260px]">
        {step === 'native' && <NativeSpeechPanel language={language} engine={engine} onReady={ready => setStatus('native', ready ? 'ok' : 'warn')} />}
        {step === 'permissions' && <PermissionsStep onStatus={(s) => setStatus('permissions', s)} />}
        {step === 'llm' && <LlmStep onStatus={(s) => setStatus('llm', s)} />}
      </div>

      {/* Skip lives in the action row, not buried in a corner. Both are
          first-class buttons so a user who's bailing knows they can — at
          any step, with one click. "Skip step" advances past this one
          taking no action; "Skip all" ends the wizard immediately. */}
      <div className="px-6 py-4 border-t border-surface-border flex items-center gap-3">
        <button
          disabled={idx === 0}
          onClick={() => setIdx((i) => Math.max(i - 1, 0))}
          className="text-sm text-ink-muted hover:text-ink disabled:opacity-30 px-3 py-1.5 rounded-lg"
        >
          Back
        </button>
        <div className="flex-1 flex gap-1">
          {STEPS.map((k, i) => (
            <div key={k} className="flex-1 flex items-center gap-1">
              <div
                className={`h-1 flex-1 rounded-full ${i <= idx ? 'bg-brand-solid' : 'bg-surface-border'}`}
              />
              <StatusPip status={stepStatus[k]} step={STEP_LABELS[k]} />
            </div>
          ))}
        </div>
        {!done && (
          <>
            <button
              onClick={next}
              className="text-sm text-ink-muted hover:text-ink border border-surface-border hover:border-ink/30 px-3 py-1.5 rounded-lg transition"
            >
              Skip step
            </button>
            <button
              onClick={() => void finish()}
              className="text-sm text-ink-muted hover:text-ink border border-surface-border hover:border-ink/30 px-3 py-1.5 rounded-lg transition"
            >
              Skip all
            </button>
            <button
              onClick={next}
              className="btn-primary text-sm px-4 py-1.5"
            >
              <IconLabel icon="arrow-right" className="flex-row-reverse">Next</IconLabel>
            </button>
          </>
        )}
        {done && (
          <button
            onClick={() => void finish()}
            className="btn-primary text-sm px-4 py-1.5"
          >
            Finish
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Step 1: macOS permissions ─────────────────────────────────────────

type PermState = 'granted' | 'denied' | 'not-determined' | 'unknown';

function PermissionsStep({ onStatus }: { onStatus: (s: StepStatus) => void }): JSX.Element {
  const [mic, setMic] = useState<PermState>('unknown');
  const [audioCapture, setAudioCapture] = useState<PermState>('unknown');

  async function refresh(): Promise<void> {
    const micState = (await api.permissions.micStatus()) as PermState;
    const perms = (await api.permissions.audio()) as { mic: PermState; audioCapture: PermState };
    setMic(micState);
    setAudioCapture(perms.audioCapture);
    // Mic is the only honest audio signal — system-audio capture can't be
    // verified pre-recording (macOS prompts on first Record), so report ok
    // only when mic is granted and audio-capture isn't outright denied.
    onStatus(micState === 'granted' && perms.audioCapture !== 'denied' ? 'ok' : 'warn');
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount; the callback is recreated every render
  useEffect(() => { void refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, []);

  return (
    <div>
      <StepHeader title="Grant mic + screen audio permissions" />
      <p className="text-sm text-ink-muted leading-relaxed mb-4">
        MeetingNotes needs access to your microphone (your voice) and
        Screen &amp; System Audio Recording (other apps&apos; audio). Both
        are standard macOS permissions — denying them means no recordings.
      </p>
      <div className="space-y-2">
        <PermRow
          label="Microphone"
          state={mic}
          action={
            mic !== 'granted' ? (
              <div className="flex gap-2">
                <button
                  onClick={async () => { await api.permissions.requestMic(); await refresh(); }}
                  className="text-xs font-semibold bg-brand-solid text-white px-3 py-1 rounded-md"
                >
                  Request
                </button>
                <button
                  onClick={() => void api.onboarding.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')}
                  className="text-xs font-semibold border border-surface-border px-3 py-1 rounded-md"
                >
                  System Settings
                </button>
              </div>
            ) : null
          }
        />
        {/* The helper's probe reports "granted" for this permission even when
            it is not (it opens an empty tap), so a green tick here would be a
            promise we cannot keep (#299). Say what is actually known. */}
        <PermRow
          label="Screen & System Audio"
          state={audioCapture}
          unverified
          action={
            <button
              onClick={() => void api.onboarding.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')}
              className="text-xs font-semibold border border-surface-border px-3 py-1 rounded-md"
            >
              System Settings
            </button>
          }
        />
      </div>
      <div className="text-xs text-ink-muted italic mt-4">
        macOS asks for &ldquo;Screen &amp; System Audio Recording&rdquo; the
        first time you record, and only a recording confirms it works. You can
        skip the System Settings button and grant it then; Settings has a Test
        recording that checks it without a meeting.
      </div>
    </div>
  );
}

function PermRow({
  label, state, action, unverified = false,
}: {
  label: string;
  state: PermState;
  action?: React.ReactNode;
  /** The probe cannot confirm a grant for this permission; only a denial is reliable. */
  unverified?: boolean;
}): JSX.Element {
  const cls = state === 'granted' && !unverified ? 'text-status-ok'
    : state === 'denied' ? 'text-danger'
      : 'text-ink-muted';
  const txt = state === 'granted' && unverified ? 'Confirmed when you first record'
    : state === 'granted' ? <IconLabel icon="check">Granted</IconLabel>
    : state === 'denied' ? <IconLabel icon="x">Denied</IconLabel>
      : state === 'not-determined' ? 'Not granted yet'
        : 'Unknown';
  return (
    <div className="flex items-center gap-3 px-3 py-2 border border-surface-border rounded-lg">
      <span className="flex-1 text-sm">{label}</span>
      <span className={`text-xs font-semibold ${cls}`}>{txt}</span>
      {action}
    </div>
  );
}

// ─── Step 4: LM Studio ─────────────────────────────────────────────────

type SummaryProvider = 'external' | 'lm-studio' | 'ollama';
const PROVIDER_NAMES: Record<SummaryProvider, string> = { 'external': 'a server I run myself', 'lm-studio': 'LM Studio', 'ollama': 'Ollama' };

function LlmStep({ onStatus }: { onStatus: (s: StepStatus) => void }): JSX.Element {
  const [providers, setProviders] = useState<
    { lmStudio: { binary: boolean; running: boolean }; ollama: { binary: boolean; running: boolean } } | null
  >(null);
  const [provider, setProvider] = useState<SummaryProvider>('external');
  const [loaded, setLoaded] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<string>('');
  const [checking, setChecking] = useState(true);
  // Canary verdict for the picked model: null = not run, 'checking' = in flight.
  const [health, setHealth] = useState<'checking' | 'ok' | 'loops' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /** Detect providers, list the active provider's models, and settle on one.
   *  The choice is SAVED here (#299): this step used to show the first model
   *  as picked without persisting it, so finishing setup left Settings on the
   *  built-in default and the first real summary failed. */
  async function check(): Promise<void> {
    setChecking(true); setErr(null);
    try {
      const settings = (await api.settings.getAll()) as { summaryProvider: SummaryProvider; llmModel: string };
      setProvider(settings.summaryProvider);
      // Same detection the Settings provider dropdown uses — surfaced here so a
      // new user sees "LM Studio found / running" instead of a bare model list.
      setProviders(await api.llm.detectProviders());
      const models = (await api.models.list()) as string[];
      setLoaded(models);
      // Keep a model the user already saved if the server still offers it;
      // otherwise take the first one and save that.
      const choice = models.includes(settings.llmModel) ? settings.llmModel : models[0] ?? '';
      setPicked(choice);
      if (choice && choice !== settings.llmModel) await api.settings.set('llmModel', choice);
      if (choice) void runCanary(choice); else setHealth(null);
      onStatus(models.length > 0 ? 'ok' : 'warn');
    } catch (e) {
      setErr((e as Error).message);
      setLoaded([]);
      onStatus('warn');
    } finally { setChecking(false); }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount; the callback is recreated every render
  useEffect(() => { void check(); }, []);

  // Fire the exact health-check canary Settings runs, and fold its verdict into
  // the step status. A looping (reasoning) model -> 'warn': visible but the user
  // can still proceed (canAdvance('warn') === true).
  async function runCanary(modelId: string): Promise<void> {
    if (!modelId) return;
    setHealth('checking'); onStatus('checking');
    try {
      const result = await api.llm.healthCheckModel(modelId);
      setHealth(result.verdict);
      onStatus(statusFromProbe(result));
    } catch {
      // Best-effort canary — a transport error shouldn't trap the user.
      setHealth(null); onStatus('pending');
    }
  }

  async function pick(modelId: string): Promise<void> {
    setPicked(modelId);
    await api.settings.set('llmModel', modelId);
    void runCanary(modelId);
  }

  /** Switch where summaries run, save it, and re-read that server's models. */
  async function chooseProvider(next: SummaryProvider): Promise<void> {
    setProvider(next); setErr(null);
    try { await api.settings.set('summaryProvider', next); await check(); }
    catch (e) { setErr((e as Error).message); }
  }

  const name = PROVIDER_NAMES[provider];
  return (
    <div>
      <StepHeader title="Pick a summary model" />
      <label className="block text-sm mb-3">
        <span className="block text-xs font-semibold text-ink-muted mb-1">Run summaries with</span>
        <select aria-label="Summary provider" className="input" value={provider} disabled={checking}
          onChange={(e) => void chooseProvider(e.target.value as SummaryProvider)}>
          <option value="lm-studio" disabled={providers != null && !providers.lmStudio.binary}>
            LM Studio, started for me{providers && !providers.lmStudio.binary ? ' — not installed' : providers?.lmStudio.running ? ' — running' : ''}
          </option>
          <option value="ollama" disabled={providers != null && !providers.ollama.binary}>
            Ollama, started for me{providers && !providers.ollama.binary ? ' — not installed' : providers?.ollama.running ? ' — running' : ''}
          </option>
          <option value="external">A server I run myself (LM Studio, Ollama or compatible)</option>
        </select>
      </label>
      <p className="text-sm text-ink-muted leading-relaxed mb-3">
        Summaries and action items come from a local chat model. Install{' '}
        <a
          href="https://lmstudio.ai"
          onClick={(e) => { e.preventDefault(); void api.onboarding.openExternal('https://lmstudio.ai'); }}
          className="text-brand-indigo hover:underline"
        >
          LM Studio
        </a>{' '}or{' '}
        <a
          href="https://ollama.com"
          onClick={(e) => { e.preventDefault(); void api.onboarding.openExternal('https://ollama.com'); }}
          className="text-brand-indigo hover:underline"
        >
          Ollama
        </a>, download a chat model (qwen3.5-9b is a solid default for Apple
        Silicon under 32 GB RAM), and it will appear below.
      </p>
      {checking && <div className="text-sm text-ink-muted italic">Checking {name}…</div>}
      {!checking && (loaded?.length ?? 0) === 0 && (
        <div className="text-sm text-danger bg-danger-bg border border-danger-border rounded-lg p-3">
          No models were found on {name}.{' '}
          {provider === 'ollama' ? 'Pull a chat model (for example with “ollama pull”), then click Re-check.'
            : provider === 'lm-studio' ? 'Download a chat model in LM Studio, then click Re-check.'
            : 'Make sure the server is running with a chat model loaded, then click Re-check.'}
          {providers && provider !== 'ollama' && providers.ollama.running && ' Ollama is running on this Mac — choose it above to use its models.'}
          {providers && provider !== 'lm-studio' && providers.lmStudio.running && ' LM Studio is running on this Mac — choose it above to use its models.'}
        </div>
      )}
      {!checking && (loaded?.length ?? 0) > 0 && (
        <>
          <select
            aria-label="Summary model"
            value={picked}
            onChange={(e) => void pick(e.target.value)}
            className="input mb-2"
          >
            {loaded!.map((m) => (
              <option key={m} value={m}>{isKnownReasoningModel(m) ? `${m} (reasoning)` : m}</option>
            ))}
          </select>
          {health && (
            <div className={`text-xs mb-1.5 px-2.5 py-1 rounded-lg border ${
              health === 'checking'
                ? 'text-ink-muted border-surface-border bg-surface-sunken'
                : health === 'loops'
                  ? 'text-status-warnText border-status-warn/30 bg-status-warnBg'
                  : 'text-status-ok border-status-ok/30 bg-status-okBg/40'
            }`}>
              {health === 'checking'
                ? 'Checking whether this model tends to loop on structured tasks…'
                : health === 'loops'
                  ? 'This model looped on a quick extraction test — expect it to fail on real meetings too. You can continue, but consider a non-reasoning model.'
                  : <IconLabel icon="check">Passed a quick extraction canary.</IconLabel>}
            </div>
          )}
          {picked && isKnownReasoningModel(picked) && (
            <div className="text-xs text-status-warnText bg-status-warnBg border border-status-warn/30 rounded-lg px-2.5 py-1.5 mb-1.5 flex items-start gap-2">
              <Icon name="brain" className="w-4 h-4 shrink-0 mt-px" />
              <span>
                This looks like a reasoning model. It may ignore &ldquo;Disable model thinking&rdquo;
                and burn its token budget on chain-of-thought instead of answering.
              </span>
            </div>
          )}
        </>
      )}
      <button
        onClick={() => void check()}
        className="text-xs text-brand-indigo hover:underline mt-2"
      >
        Re-check
      </button>
      {err && <div className="text-xs text-danger mt-2">{err}</div>}
    </div>
  );
}

function StepHeader({ title }: { title: string }): JSX.Element {
  return <h2 className="text-base font-semibold mb-3">{title}</h2>;
}
