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

interface Props {
  onFinished: () => void;
}

type StepKey = 'permissions' | 'whisper' | 'hf' | 'llm';
const STEPS: StepKey[] = ['permissions', 'whisper', 'hf', 'llm'];

export function OnboardingView({ onFinished }: Props): JSX.Element {
  const [idx, setIdx] = useState(0);
  const step = STEPS[idx]!;

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
        <button
          onClick={() => void finish()}
          className="text-xs text-ink-muted hover:text-ink"
        >
          Skip all
        </button>
      </div>

      <div className="p-6 min-h-[260px]">
        {step === 'permissions' && <PermissionsStep />}
        {step === 'whisper' && <WhisperStep />}
        {step === 'hf' && <HfStep />}
        {step === 'llm' && <LlmStep />}
      </div>

      <div className="px-6 py-4 border-t border-surface-border flex items-center gap-3">
        <button
          disabled={idx === 0}
          onClick={() => setIdx((i) => Math.max(i - 1, 0))}
          className="text-sm text-ink-muted hover:text-ink disabled:opacity-30 px-3 py-1.5 rounded-lg"
        >
          Back
        </button>
        <div className="flex-1 flex gap-1">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full ${i <= idx ? 'bg-brand-indigo' : 'bg-surface-border'}`}
            />
          ))}
        </div>
        {done ? (
          <button
            onClick={() => void finish()}
            className="text-sm font-semibold bg-gradient-to-br from-brand-indigo to-brand-violet text-white px-4 py-1.5 rounded-lg"
          >
            Finish
          </button>
        ) : (
          <button
            onClick={next}
            className="text-sm font-semibold bg-gradient-to-br from-brand-indigo to-brand-violet text-white px-4 py-1.5 rounded-lg"
          >
            Next →
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Step 1: macOS permissions ─────────────────────────────────────────

type PermState = 'granted' | 'denied' | 'not-determined' | 'unknown';

function PermissionsStep(): JSX.Element {
  const [mic, setMic] = useState<PermState>('unknown');
  const [audioCapture, setAudioCapture] = useState<PermState>('unknown');

  async function refresh(): Promise<void> {
    const micState = (await api.permissions.micStatus()) as PermState;
    const perms = (await api.permissions.audio()) as { mic: PermState; audioCapture: PermState };
    setMic(micState);
    setAudioCapture(perms.audioCapture);
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
    : state === 'denied' ? 'text-rose-600'
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

function WhisperStep(): JSX.Element {
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<string>('medium.en');
  const [installing, setInstalling] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try { setInstalled((await api.onboarding.listWhisperModels()) as string[]); }
    catch (e) { setErr((e as Error).message); }
  }
  useEffect(() => { void refresh(); }, []);

  async function install(): Promise<void> {
    setInstalling(true); setErr(null);
    try {
      await api.onboarding.installWhisperModel(picked);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setInstalling(false); }
  }

  const hasAny = (installed?.length ?? 0) > 0;
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
        onChange={(e) => setPicked(e.target.value)}
        disabled={installing}
        className="input mb-2"
      >
        {WHISPER_MODELS.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name} · {m.size} · {m.desc}
          </option>
        ))}
      </select>
      <button
        onClick={() => void install()}
        disabled={installing}
        className="w-full bg-brand-indigo text-white font-semibold text-sm rounded-lg py-2 disabled:opacity-50"
      >
        {installing ? 'Downloading… (this can take a few minutes)' : `Download ${picked}`}
      </button>
      {err && <div className="text-xs text-rose-600 mt-2">{err}</div>}
      <div className="text-xs text-ink-muted mt-3">
        Requires <code className="bg-surface-sunken px-1 py-0.5 rounded">whisper-cpp</code> installed via Homebrew. If the install button errors, run{' '}
        <code className="bg-surface-sunken px-1 py-0.5 rounded">brew install whisper-cpp</code> in Terminal and retry.
      </div>
    </div>
  );
}

// ─── Step 3: Hugging Face token ────────────────────────────────────────

function HfStep(): JSX.Element {
  const [token, setToken] = useState('');
  const [validating, setValidating] = useState(false);
  const [status, setStatus] = useState<'idle' | 'valid' | 'invalid' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [savedUser, setSavedUser] = useState<string | null>(null);

  async function validateAndSave(): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) { setStatus('invalid'); setErr('Token is empty.'); return; }
    setValidating(true); setErr(null); setStatus('idle');
    try {
      const resp = await fetch('https://huggingface.co/api/whoami-v2', {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (!resp.ok) {
        setStatus('invalid');
        setErr(`HF rejected the token (${resp.status}). Double-check it's copied in full.`);
        return;
      }
      const who = (await resp.json()) as { name?: string };
      await api.onboarding.saveHfToken(trimmed);
      setStatus('valid');
      setSavedUser(who.name ?? null);
    } catch (e) {
      setStatus('error');
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
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="hf_..."
        disabled={validating || status === 'valid'}
        className="input mb-2"
      />
      <button
        onClick={() => void validateAndSave()}
        disabled={validating || status === 'valid'}
        className="w-full bg-brand-indigo text-white font-semibold text-sm rounded-lg py-2 disabled:opacity-50"
      >
        {validating ? 'Checking…' : status === 'valid' ? '✓ Saved' : 'Validate & save'}
      </button>
      {status === 'valid' && savedUser && (
        <div className="text-xs text-status-ok mt-2">
          ✓ Token valid — signed in as {savedUser}. Saved to{' '}
          <code className="bg-surface-sunken px-1 py-0.5 rounded">~/.cache/huggingface/token</code>.
        </div>
      )}
      {err && <div className="text-xs text-rose-600 mt-2">{err}</div>}
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

function LlmStep(): JSX.Element {
  const [loaded, setLoaded] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<string>('');
  const [checking, setChecking] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function check(): Promise<void> {
    setChecking(true); setErr(null);
    try {
      const models = (await api.models.list()) as string[];
      setLoaded(models);
      if (models[0] && !picked) setPicked(models[0]);
    } catch (e) {
      setErr((e as Error).message);
      setLoaded([]);
    } finally { setChecking(false); }
  }
  useEffect(() => { void check(); }, []);

  async function saveModel(): Promise<void> {
    if (!picked) return;
    await api.settings.set('llmModel', picked);
  }

  return (
    <div>
      <StepHeader title="Pick an LM Studio model" />
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
        <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-3">
          LM Studio isn&apos;t reachable at its default URL. Make sure
          LM Studio is running, the local-server toggle is on, and a
          chat model is loaded. Then click Re-check.
        </div>
      )}
      {!checking && (loaded?.length ?? 0) > 0 && (
        <>
          <select
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            className="input mb-2"
          >
            {loaded!.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button
            onClick={() => void saveModel()}
            className="w-full bg-brand-indigo text-white font-semibold text-sm rounded-lg py-2"
          >
            Use {picked}
          </button>
        </>
      )}
      <button
        onClick={() => void check()}
        className="text-xs text-brand-indigo hover:underline mt-2"
      >
        Re-check
      </button>
      {err && <div className="text-xs text-rose-600 mt-2">{err}</div>}
    </div>
  );
}

function StepHeader({ title }: { title: string }): JSX.Element {
  return <h2 className="text-base font-semibold mb-3">{title}</h2>;
}
