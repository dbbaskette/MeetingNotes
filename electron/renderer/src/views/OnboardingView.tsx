// First-run setup: capture permissions, native speech assets, and summaries.
import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import { type StepStatus, statusFromProbe } from '../lib/setup-wizard';
import { isKnownReasoningModel } from '../lib/reasoning-models';
import { Icon } from '../components/icons';
import { NativeSpeechPanel } from '../components/NativeSpeechPanel';

interface Props {
  onFinished: () => void;
}

type StepKey = 'permissions' | 'native' | 'llm';
const STEPS: StepKey[] = ['permissions', 'native', 'llm'];

/** Small colored pip a step reports up so the stepper bar reflects
 *  pending / checking / ok / warn without each step owning its own chrome. */
function StatusPip({ status }: { status: StepStatus }): JSX.Element {
  const cls =
    status === 'ok' ? 'bg-status-ok'
      : status === 'warn' ? 'bg-status-warn'
        : status === 'checking' ? 'bg-brand-solid animate-pulse'
          : 'bg-surface-border';
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} aria-label={status} />;
}

export function OnboardingView({ onFinished }: Props): JSX.Element {
  const [idx, setIdx] = useState(0);
  const [language, setLanguage] = useState('en');
  useEffect(() => { void api.settings.getAll().then(s => { setLanguage(s.sttLanguage); }); }, []);
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
        <div
          className="w-6 h-6 rounded-md"
          style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}
        />
        <div className="flex-1">
          <div className="font-semibold">Welcome to MeetingNotes</div>
          <div className="text-xs text-ink-muted">Setup · step {idx + 1} of {STEPS.length}</div>
        </div>
      </div>

      <div className="p-6 min-h-[260px]">
        {step === 'native' && <NativeSpeechPanel language={language} onReady={ready => setStatus('native', ready ? 'ok' : 'warn')} />}
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
              <StatusPip status={stepStatus[k]} />
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
              className="text-sm font-semibold bg-gradient-to-br from-brand-indigo to-brand-violet text-white px-4 py-1.5 rounded-lg"
            >
              Next →
            </button>
          </>
        )}
        {done && (
          <button
            onClick={() => void finish()}
            className="text-sm font-semibold bg-gradient-to-br from-brand-indigo to-brand-violet text-white px-4 py-1.5 rounded-lg"
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
        <PermRow
          label="Screen & System Audio"
          state={audioCapture}
          action={
            audioCapture !== 'granted' ? (
              <button
                onClick={() => void api.onboarding.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')}
                className="text-xs font-semibold border border-surface-border px-3 py-1 rounded-md"
              >
                System Settings
              </button>
            ) : null
          }
        />
      </div>
      <div className="text-xs text-ink-muted italic mt-4">
        Tip: macOS will also prompt for &ldquo;Screen &amp; System Audio
        Recording&rdquo; the first time you click Record — you can skip
        the System Settings button and grant it then.
      </div>
    </div>
  );
}

function PermRow({
  label, state, action,
}: {
  label: string;
  state: PermState;
  action?: React.ReactNode;
}): JSX.Element {
  const cls = state === 'granted' ? 'text-status-ok'
    : state === 'denied' ? 'text-danger'
      : 'text-ink-muted';
  const txt = state === 'granted' ? '✓ Granted'
    : state === 'denied' ? '✗ Denied'
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

function LlmStep({ onStatus }: { onStatus: (s: StepStatus) => void }): JSX.Element {
  const [providers, setProviders] = useState<
    { lmStudio: { binary: boolean; running: boolean }; ollama: { binary: boolean; running: boolean } } | null
  >(null);
  const [loaded, setLoaded] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<string>('');
  const [checking, setChecking] = useState(true);
  // Canary verdict for the picked model: null = not run, 'checking' = in flight.
  const [health, setHealth] = useState<'checking' | 'ok' | 'loops' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function check(): Promise<void> {
    setChecking(true); setErr(null);
    try {
      // Same detection the Settings provider dropdown uses — surfaced here so a
      // new user sees "LM Studio found / running" instead of a bare model list.
      setProviders(await api.llm.detectProviders());
      const models = (await api.models.list()) as string[];
      setLoaded(models);
      if (models[0] && !picked) { setPicked(models[0]); void runCanary(models[0]); }
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

  return (
    <div>
      <StepHeader title="Pick an LM Studio model" />
      {providers && (
        <div className="text-xs text-ink-muted mb-2">
          {providers.lmStudio.binary
            ? providers.lmStudio.running ? '✓ LM Studio detected and running.' : 'LM Studio CLI found — start its local server to load a model.'
            : 'LM Studio CLI not found.'}
          {providers.ollama.binary ? ' Ollama also detected.' : ''}
        </div>
      )}
      <p className="text-sm text-ink-muted leading-relaxed mb-3">
        The summariser runs through a chat model loaded in{' '}
        <a
          href="https://lmstudio.ai"
          onClick={(e) => { e.preventDefault(); void api.onboarding.openExternal('https://lmstudio.ai'); }}
          className="text-brand-indigo hover:underline"
        >
          LM Studio
        </a>. Load any chat model (qwen3.5-9b is a solid default for Apple
        Silicon under 32 GB RAM), enable the Local Server, and we&apos;ll
        pick it up below.
      </p>
      {checking && <div className="text-sm text-ink-muted italic">Checking LM Studio…</div>}
      {!checking && (loaded?.length ?? 0) === 0 && (
        <div className="text-sm text-danger bg-danger-bg border border-danger-border rounded-lg p-3">
          LM Studio isn&apos;t reachable at its default URL. Make sure
          LM Studio is running, the local-server toggle is on, and a
          chat model is loaded. Then click Re-check.
        </div>
      )}
      {!checking && (loaded?.length ?? 0) > 0 && (
        <>
          <select
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
                  : '✓ Passed a quick extraction canary.'}
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
