// electron/renderer/src/views/OnboardingView.tsx
//
// First-run wizard (#43). Gated on settings.onboardedAt — shown on launch
// when null. Walks the user through the four taxes a new install has to pay
// before the pipeline can run end-to-end:
//
//   1. macOS mic + screen/system-audio permissions
//   2. A downloaded Whisper model
//   3. A Hugging Face token accepted against the pyannote gates
//   4. A reachable LM Studio with a chat model loaded
//
// Every step has a Skip. Even a full skip stamps onboardedAt so the wizard
// doesn't re-prompt on every launch. Users can re-run via Settings → "Run
// setup again".
import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import { type StepStatus, statusFromProbe } from '../lib/setup-wizard';
import { isKnownReasoningModel } from '../lib/reasoning-models';

interface Props {
  onFinished: () => void;
}

type StepKey = 'permissions' | 'whisper' | 'hf' | 'llm' | 'stt';
const STEPS: StepKey[] = ['permissions', 'whisper', 'hf', 'llm', 'stt'];

/** Small colored pip a step reports up so the stepper bar reflects
 *  pending / checking / ok / warn without each step owning its own chrome. */
function StatusPip({ status }: { status: StepStatus }): JSX.Element {
  const cls =
    status === 'ok' ? 'bg-status-ok'
      : status === 'warn' ? 'bg-status-warn'
        : status === 'checking' ? 'bg-brand-indigo animate-pulse'
          : 'bg-surface-border';
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} aria-label={status} />;
}

export function OnboardingView({ onFinished }: Props): JSX.Element {
  const [idx, setIdx] = useState(0);
  const step = STEPS[idx]!;
  const [stepStatus, setStepStatus] = useState<Record<StepKey, StepStatus>>({
    permissions: 'pending', whisper: 'pending', hf: 'pending', llm: 'pending', stt: 'pending',
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
    <div className="max-w-xl mx-auto my-10 bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden">
      <div className="px-6 py-4 border-b border-surface-border flex items-center gap-3">
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
        {step === 'permissions' && <PermissionsStep onStatus={(s) => setStatus('permissions', s)} />}
        {step === 'whisper' && <WhisperStep onStatus={(s) => setStatus('whisper', s)} />}
        {step === 'hf' && <HfStep onStatus={(s) => setStatus('hf', s)} />}
        {step === 'llm' && <LlmStep onStatus={(s) => setStatus('llm', s)} />}
        {step === 'stt' && <SttStep onStatus={(s) => setStatus('stt', s)} />}
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
                className={`h-1 flex-1 rounded-full ${i <= idx ? 'bg-brand-indigo' : 'bg-surface-border'}`}
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
                  className="text-xs font-semibold bg-brand-indigo text-white px-3 py-1 rounded-md"
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

// ─── Step 2: Whisper model ─────────────────────────────────────────────

const WHISPER_MODELS: { name: string; size: string; desc: string }[] = [
  { name: 'tiny.en', size: '75 MB', desc: 'Fastest, English, low accuracy' },
  { name: 'base.en', size: '142 MB', desc: 'Fast, English, decent on clean audio' },
  { name: 'small.en', size: '466 MB', desc: 'Good balance for English' },
  { name: 'medium.en', size: '1.5 GB', desc: 'Recommended for English meetings' },
  { name: 'medium', size: '1.5 GB', desc: 'Multilingual medium' },
  { name: 'large-v3', size: '2.9 GB', desc: 'Best accuracy, slower' },
  { name: 'large-v3-turbo', size: '1.5 GB', desc: 'Near large-v3 accuracy, much faster' },
];

function WhisperStep({ onStatus }: { onStatus: (s: StepStatus) => void }): JSX.Element {
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<string>('medium.en');
  const [installing, setInstalling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The model that just finished downloading this session — drives the
  // explicit "✓ downloaded and ready" confirmation.
  const [justDownloaded, setJustDownloaded] = useState<string | null>(null);

  async function refresh(): Promise<string[]> {
    try {
      const models = (await api.onboarding.listWhisperModels()) as string[];
      setInstalled(models);
      onStatus((models?.length ?? 0) > 0 ? 'ok' : 'pending');
      return models ?? [];
    }
    catch (e) { setErr((e as Error).message); return []; }
  }
  useEffect(() => { void refresh(); }, []);

  async function install(): Promise<void> {
    setInstalling(true); setErr(null); setJustDownloaded(null);
    const target = picked;
    try {
      await api.onboarding.installWhisperModel(target);
      // Verify the model the user actually picked is now on disk, rather than
      // trusting the call resolved — a partial/interrupted download would leave
      // it absent, and the user deserves to know either way.
      const models = await refresh();
      if (models.includes(target)) {
        setJustDownloaded(target);
      } else {
        setErr(`Download finished but ${target} isn't showing as installed. Check free disk space and that whisper-cpp is installed, then retry.`);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setInstalling(false); }
  }

  const hasAny = (installed?.length ?? 0) > 0;
  const pickedInstalled = installed?.includes(picked) ?? false;
  return (
    <div>
      <StepHeader title="Download a Whisper model" />
      <p className="text-sm text-ink-muted leading-relaxed mb-4">
        Whisper runs on your machine for speech-to-text. Pick a model to
        download once — bigger models = more accurate but slower. Stored
        at{' '}
        <code className="text-xs bg-surface-sunken px-1 py-0.5 rounded">
          ~/Library/Application Support/MeetingNotes/whisper-models
        </code>
      </p>
      {hasAny && (
        <div className="text-xs text-status-ok mb-3">
          ✓ Installed: {installed!.join(', ')}
        </div>
      )}
      <select
        value={picked}
        onChange={(e) => { setPicked(e.target.value); setErr(null); setJustDownloaded(null); }}
        disabled={installing}
        className="input mb-1"
      >
        {WHISPER_MODELS.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name} · {m.size} · {m.desc}{installed?.includes(m.name) ? ' · installed' : ''}
          </option>
        ))}
      </select>
      <div className="text-xs text-ink-muted mb-2 h-4">
        {pickedInstalled && `${picked} is already installed — you're set.`}
      </div>
      <button
        onClick={() => void install()}
        disabled={installing}
        className="w-full bg-brand-indigo text-white font-semibold text-sm rounded-lg py-2 disabled:opacity-50"
      >
        {installing ? 'Downloading… (this can take a few minutes)'
          : pickedInstalled ? `Re-download ${picked}`
            : `Download ${picked}`}
      </button>
      {justDownloaded && (
        <div className="text-xs text-status-ok bg-status-okBg/40 border border-status-ok/30 rounded-lg px-2.5 py-1.5 mt-2">
          ✓ {justDownloaded} downloaded and ready to transcribe.
        </div>
      )}
      {err && <div className="text-xs text-danger mt-2">{err}</div>}
      <div className="text-xs text-ink-muted mt-3">
        Requires <code className="bg-surface-sunken px-1 py-0.5 rounded">whisper-cpp</code> installed via Homebrew. If the install button errors, run{' '}
        <code className="bg-surface-sunken px-1 py-0.5 rounded">brew install whisper-cpp</code> in Terminal and retry.
      </div>
    </div>
  );
}

// ─── Step 3: Hugging Face token ────────────────────────────────────────

function HfStep({ onStatus }: { onStatus: (s: StepStatus) => void }): JSX.Element {
  const [token, setToken] = useState('');
  const [validating, setValidating] = useState(false);
  const [status, setStatus] = useState<'idle' | 'valid' | 'invalid' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [savedUser, setSavedUser] = useState<string | null>(null);
  const [alreadySaved, setAlreadySaved] = useState(false);

  // Steps unmount when you navigate away, so this component re-mounts blank on
  // "Back". The token itself lives on disk — reflect that instead of showing an
  // empty field that looks like the token was lost. (We never read the secret
  // back into the UI; replacing it just means typing a new one.)
  useEffect(() => {
    void (async () => {
      try {
        const { saved } = await api.onboarding.hfTokenStatus();
        if (saved) { setAlreadySaved(true); onStatus('ok'); }
      } catch { /* best-effort */ }
    })();
    // onStatus is stable enough for a mount-only effect here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function validateAndSave(): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) { setStatus('invalid'); onStatus('warn'); setErr('Token is empty.'); return; }
    setValidating(true); setErr(null); setStatus('idle');
    try {
      const resp = await fetch('https://huggingface.co/api/whoami-v2', {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (!resp.ok) {
        setStatus('invalid');
        onStatus('warn');
        setErr(`HF rejected the token (${resp.status}). Double-check it's copied in full.`);
        return;
      }
      const who = (await resp.json()) as { name?: string };
      await api.onboarding.saveHfToken(trimmed);
      setStatus('valid');
      onStatus('ok');
      setSavedUser(who.name ?? null);
    } catch (e) {
      setStatus('error');
      onStatus('warn');
      setErr((e as Error).message);
    } finally { setValidating(false); }
  }

  return (
    <div>
      <StepHeader title="Add your Hugging Face token" />
      <p className="text-sm text-ink-muted leading-relaxed mb-3">
        pyannote&apos;s diarization models are gated on Hugging Face. Accept
        the licence on all three pages below, then paste a <strong>
        fine-grained</strong> token with &ldquo;Read gated repos&rdquo;
        scope.
      </p>
      <ul className="text-xs text-brand-indigo space-y-1 mb-3">
        {[
          ['pyannote/speaker-diarization-3.1', 'https://huggingface.co/pyannote/speaker-diarization-3.1'],
          ['pyannote/segmentation-3.0', 'https://huggingface.co/pyannote/segmentation-3.0'],
          ['pyannote/speaker-diarization-community-1', 'https://huggingface.co/pyannote/speaker-diarization-community-1'],
        ].map(([label, url]) => (
          <li key={label}>
            <a
              href={url}
              onClick={(e) => { e.preventDefault(); void api.onboarding.openExternal(url!); }}
              className="hover:underline"
            >
              → {label}
            </a>
          </li>
        ))}
      </ul>
      {alreadySaved && status !== 'valid' && (
        <div className="text-xs text-status-ok bg-status-okBg/40 border border-status-ok/30 rounded-lg px-2.5 py-1.5 mb-2">
          ✓ A Hugging Face token is already saved on this Mac — you&apos;re set.
          Enter a new one below only if you want to replace it.
        </div>
      )}
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={alreadySaved ? 'hf_… (replace the saved token)' : 'hf_...'}
        disabled={validating || status === 'valid'}
        className="input mb-2"
      />
      <button
        onClick={() => void validateAndSave()}
        disabled={validating || status === 'valid'}
        className="w-full bg-brand-indigo text-white font-semibold text-sm rounded-lg py-2 disabled:opacity-50"
      >
        {validating ? 'Checking…'
          : status === 'valid' ? '✓ Saved'
            : alreadySaved ? 'Replace token' : 'Validate & save'}
      </button>
      {status === 'valid' && savedUser && (
        <div className="text-xs text-status-ok mt-2">
          ✓ Token valid — signed in as {savedUser}. Saved to{' '}
          <code className="bg-surface-sunken px-1 py-0.5 rounded">~/.cache/huggingface/token</code>.
        </div>
      )}
      {err && <div className="text-xs text-danger mt-2">{err}</div>}
      <div className="text-xs text-ink-muted mt-3">
        Create a token at{' '}
        <a
          href="https://huggingface.co/settings/tokens"
          onClick={(e) => { e.preventDefault(); void api.onboarding.openExternal('https://huggingface.co/settings/tokens'); }}
          className="text-brand-indigo hover:underline"
        >
          huggingface.co/settings/tokens
        </a>. Pick &ldquo;Fine-grained&rdquo; → enable &ldquo;Read access to contents of all public gated repos you can access&rdquo;.
      </div>
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
              <option key={m} value={m}>{isKnownReasoningModel(m) ? `🧠 ${m}` : m}</option>
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
                  ? '⚠ This model looped on a quick extraction test — expect it to fail on real meetings too. You can continue, but consider a non-reasoning model.'
                  : '✓ Passed a quick extraction canary.'}
            </div>
          )}
          {picked && isKnownReasoningModel(picked) && (
            <div className="text-xs text-status-warnText bg-status-warnBg border border-status-warn/30 rounded-lg px-2.5 py-1.5 mb-1.5">
              🧠 This looks like a reasoning model. It may ignore &ldquo;Disable model thinking&rdquo;
              and burn its token budget on chain-of-thought instead of answering.
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

// ─── Step 5: STT (transcription) endpoint ─────────────────────────────
//
// New in the first-run wizard: verify the whisper-server actually answers
// BEFORE the first meeting, instead of failing the transcribe stage later.
// Reuses the exact stt:probe handler the Settings "Test" button uses — it
// fetches <url>/health and checks for {"status":"ok"}, so a green here is a
// real signal (unlike system-audio capture, which can't be verified upfront).
function SttStep({ onStatus }: { onStatus: (s: StepStatus) => void }): JSX.Element {
  const [url, setUrl] = useState<string>('');
  const [result, setResult] = useState<{ ok: true } | { ok: false; error: string } | null>(null);
  const [checking, setChecking] = useState(false);

  async function probe(target: string): Promise<void> {
    if (!target) return;
    setChecking(true); onStatus('checking');
    try {
      const r = await api.stt.probe(target);
      setResult(r);
      onStatus(statusFromProbe(r));
    } catch (e) {
      const r = { ok: false as const, error: (e as Error).message };
      setResult(r);
      onStatus('warn');
    } finally { setChecking(false); }
  }

  useEffect(() => {
    void (async () => {
      const all = (await api.settings.getAll()) as { sttUrl: string };
      setUrl(all.sttUrl);
      void probe(all.sttUrl);
    })();
  }, []);

  return (
    <div>
      <StepHeader title="Verify transcription (whisper-server)" />
      <p className="text-sm text-ink-muted leading-relaxed mb-3">
        Meetings are transcribed by a local whisper-server. Confirm it&apos;s
        reachable now so the transcribe stage doesn&apos;t fail on your first
        meeting. Start it with{' '}
        <code className="text-xs bg-surface-sunken px-1 py-0.5 rounded">./scripts/whisper-server.sh</code>.
      </p>
      <div className="flex gap-2 mb-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => void api.settings.set('sttUrl', url)}
          className="input flex-1"
          placeholder="http://127.0.0.1:8080"
        />
        <button
          onClick={() => { void api.settings.set('sttUrl', url); void probe(url); }}
          disabled={checking}
          className="text-sm font-semibold bg-brand-indigo text-white px-3 py-1.5 rounded-lg disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Test'}
        </button>
      </div>
      {result?.ok === true && (
        <div className="text-xs text-status-ok bg-status-okBg/40 border border-status-ok/30 rounded-lg px-2.5 py-1">
          ✓ whisper-server is up and answering /health.
        </div>
      )}
      {result && result.ok === false && (
        <div className="text-xs text-status-warnText bg-status-warnBg border border-status-warn/30 rounded-lg px-2.5 py-1">
          ⚠ Couldn&apos;t reach whisper-server: {result.error}. You can continue and fix this later in Settings.
        </div>
      )}
    </div>
  );
}

function StepHeader({ title }: { title: string }): JSX.Element {
  return <h2 className="text-base font-semibold mb-3">{title}</h2>;
}
