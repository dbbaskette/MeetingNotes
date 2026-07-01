# First-run Setup Wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the LLM/STT readiness education (provider detection, reasoning-model badges, the health-check canary, the STT `/health` probe) from failure-time in `SettingsView` into setup time in the existing first-run wizard (`OnboardingView`), and make the wizard re-openable from Settings — so a new user learns "this model loops" or "your transcription server is down" before the first meeting, not after it fails.

**Architecture:** Per the approved spec (`docs/superpowers/specs/2026-07-01-first-run-setup-wizard-design.md`): the wizard is a **pure consumer of existing IPC** (`llm.detectProviders`, `llm.probe`, `llm.healthCheckModel`, `stt.probe`, `models.list`, `permissions.*`, `onboarding.*`) — **no new IPC channel**, so neither `contracts.ts` nor the preload registry changes. The two pieces of real logic — the first-run gate (`firstRunStatus`) and the per-step status machine (`canAdvance`, `statusFromProbe`) — become pure, unit-tested functions in a new `setup-wizard.ts` lib (mirroring `reasoning-models.ts`). The React shell (enhanced `OnboardingView` LLM step + a new STT step) stays thin and gets a manual verification step. The first-run gate is reused via `firstRunStatus(onboardedAt, { forceOpen })` so the Settings "Run setup again" button and the auto-show path share one code path. No new setting and **no DB migration** — `settings.onboardedAt` already exists and the settings table falls back to defaults for missing keys.

**Tech Stack:** TypeScript, React (Electron renderer), vitest.

---

### Task 1: Pure setup-wizard logic (first-run gate + step-status machine)

**Files:**
- Create: `electron/renderer/src/lib/setup-wizard.ts`
- Test: `electron/renderer/src/lib/setup-wizard.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `electron/renderer/src/lib/setup-wizard.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { firstRunStatus, canAdvance, statusFromProbe } from './setup-wizard';

describe('firstRunStatus', () => {
  it("returns 'needed' when the app has never been onboarded", () => {
    expect(firstRunStatus(null)).toBe('needed');
  });

  it("returns 'done' once onboardedAt is stamped", () => {
    expect(firstRunStatus('2026-07-01T00:00:00.000Z')).toBe('done');
  });

  it("forceOpen re-opens the wizard without clearing the onboarded fact", () => {
    // Re-run from Settings: show the wizard even though the user has
    // onboarded before, and do NOT depend on wiping onboardedAt.
    expect(firstRunStatus('2026-07-01T00:00:00.000Z', { forceOpen: true })).toBe('needed');
    expect(firstRunStatus(null, { forceOpen: true })).toBe('needed');
  });
});

describe('canAdvance', () => {
  it('blocks only while a check is in flight', () => {
    expect(canAdvance('checking')).toBe(false);
  });

  it('lets the user proceed from pending, ok, and warn', () => {
    // 'warn' is deliberately advanceable — a user who knowingly keeps a
    // reasoning model or an unreachable STT server must never be trapped.
    expect(canAdvance('pending')).toBe(true);
    expect(canAdvance('ok')).toBe(true);
    expect(canAdvance('warn')).toBe(true);
  });
});

describe('statusFromProbe', () => {
  it("maps a null outcome to 'pending'", () => {
    expect(statusFromProbe(null)).toBe('pending');
  });

  it('maps an ok probe to ok and a failed probe to warn', () => {
    expect(statusFromProbe({ ok: true })).toBe('ok');
    expect(statusFromProbe({ ok: false })).toBe('warn');
  });

  it("maps a health-check verdict: 'ok' -> ok, 'loops' -> warn", () => {
    expect(statusFromProbe({ verdict: 'ok' })).toBe('ok');
    expect(statusFromProbe({ verdict: 'loops' })).toBe('warn');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/renderer/src/lib/setup-wizard.test.ts`
Expected: FAIL — module `./setup-wizard` does not exist yet.

- [ ] **Step 3: Implement the pure functions**

Create `electron/renderer/src/lib/setup-wizard.ts` with:

```ts
// electron/renderer/src/lib/setup-wizard.ts
//
// Pure logic for the first-run setup wizard, extracted from OnboardingView so
// the two real decisions — "should the wizard show" and "how does a probe/canary
// outcome map to a step's status" — are unit-testable and reused by both the
// auto-show path (App.tsx) and the "Run setup again" re-open path (SettingsView).
// The React shell stays thin; everything with a branch lives here.

/** Whether the first-run wizard should be shown. `onboardedAt` is the existing
 *  gate (settings-repo.ts): null = never onboarded. `forceOpen` re-opens the
 *  wizard from Settings without clearing that fact, so a cancelled re-run leaves
 *  the "has onboarded" state intact. */
export function firstRunStatus(
  onboardedAt: string | null,
  opts?: { forceOpen?: boolean },
): 'needed' | 'done' {
  if (opts?.forceOpen) return 'needed';
  return onboardedAt ? 'done' : 'needed';
}

/** Per-step status in the linear stepper.
 *   - pending  : not checked yet
 *   - checking : a probe/canary is in flight (only state that blocks advancing)
 *   - ok       : verified good
 *   - warn     : a proceed-able risk (reasoning model, unreachable STT, denied
 *                mic) — visible but never blocking. */
export type StepStatus = 'pending' | 'checking' | 'ok' | 'warn';

/** The wizard lets the user advance from any status except an in-flight check.
 *  'warn' is intentionally advanceable — see StepStatus. */
export function canAdvance(status: StepStatus): boolean {
  return status !== 'checking';
}

/** Fold a probe result ({ ok }) or a health-check verdict ({ verdict }) into a
 *  step status. One tested mapping instead of ternaries scattered across the
 *  React step components. `null` = not run yet -> pending. */
export function statusFromProbe(
  outcome: { ok: boolean } | { verdict: 'ok' | 'loops' } | null,
): StepStatus {
  if (outcome == null) return 'pending';
  if ('verdict' in outcome) return outcome.verdict === 'ok' ? 'ok' : 'warn';
  return outcome.ok ? 'ok' : 'warn';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/renderer/src/lib/setup-wizard.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/src/lib/setup-wizard.ts electron/renderer/src/lib/setup-wizard.test.ts
git commit -m "feat(setup): pure first-run gate + step-status machine for the wizard"
```

---

### Task 2: Route the first-run gate through the pure function

**Files:**
- Modify: `electron/renderer/src/App.tsx` (import + the `onboardStatus` load effect at lines 132–140; the render branch at lines 286–291)

- [ ] **Step 1: Import the gate helper**

In `electron/renderer/src/App.tsx`, add to the imports near line 13
(`import { resolveDark, type ThemeChoice } from './lib/theme';`):

```ts
import { firstRunStatus } from './lib/setup-wizard';
```

- [ ] **Step 2: Add a forceOpen state and use the gate helper**

In `App.tsx`, replace the wizard-state block (currently lines 132–140):

```ts
  // Wizard state (#43). `null` = not loaded yet (show nothing),
  // 'needed' = show wizard, 'done' = past onboarding.
  const [onboardStatus, setOnboardStatus] = useState<null | 'needed' | 'done'>(null);
  useEffect(() => {
    void (async () => {
      const all = (await api.settings.getAll()) as { onboardedAt: string | null };
      setOnboardStatus(all.onboardedAt ? 'done' : 'needed');
    })();
  }, []);
```

with:

```ts
  // Wizard state (#43). `null` = not loaded yet (show nothing),
  // 'needed' = show wizard, 'done' = past onboarding. `forceOpen` is set by
  // the Settings "Run setup again" button to re-open the wizard without
  // clearing onboardedAt — firstRunStatus() folds both inputs into one answer.
  const [onboardStatus, setOnboardStatus] = useState<null | 'needed' | 'done'>(null);
  const [forceOpenSetup, setForceOpenSetup] = useState(false);
  useEffect(() => {
    void (async () => {
      const all = (await api.settings.getAll()) as { onboardedAt: string | null };
      setOnboardStatus(firstRunStatus(all.onboardedAt));
    })();
  }, []);
  // Re-open path: recompute from the flag once it flips. onboardedAt stays put.
  useEffect(() => {
    if (forceOpenSetup) setOnboardStatus(firstRunStatus('forced', { forceOpen: true }));
  }, [forceOpenSetup]);
```

- [ ] **Step 3: Reset the force flag when the wizard finishes**

In `App.tsx`, in the render branch, replace the OnboardingView line (currently line 289):

```ts
    <OnboardingView onFinished={() => setOnboardStatus('done')} />
```

with:

```ts
    <OnboardingView onFinished={() => { setForceOpenSetup(false); setOnboardStatus('done'); }} />
```

- [ ] **Step 4: Pass the re-open callback to SettingsView**

In `App.tsx`, replace the SettingsView render line (currently line 315):

```ts
    <SettingsView onBack={() => setView({ kind: 'library' })} />
```

with:

```ts
    <SettingsView
      onBack={() => setView({ kind: 'library' })}
      onRunSetupAgain={() => { setView({ kind: 'library' }); setForceOpenSetup(true); }}
    />
```

- [ ] **Step 5: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: one error — `SettingsView` doesn't yet accept `onRunSetupAgain`. Fixed in Task 3. (If your renderer tsconfig has a different name, use the one that covers `electron/renderer`; check `package.json` scripts for the exact `tsc` invocation.)

- [ ] **Step 6: Commit**

```bash
git add electron/renderer/src/App.tsx
git commit -m "feat(setup): route first-run gate through firstRunStatus + add re-open flag"
```

---

### Task 3: "Run setup again" button in Settings

**Files:**
- Modify: `electron/renderer/src/views/SettingsView.tsx` (the `Props`/component signature; the header row at lines 93–100)

- [ ] **Step 1: Add the prop to SettingsView's signature**

In `electron/renderer/src/views/SettingsView.tsx`, find the component's props/signature (the `export function SettingsView({ onBack }: { onBack: () => void })` declaration near the top of the component) and add the optional callback:

```ts
export function SettingsView({
  onBack,
  onRunSetupAgain,
}: {
  onBack: () => void;
  onRunSetupAgain?: () => void;
}): JSX.Element {
```

(If the props are declared via a named `interface Props`, add `onRunSetupAgain?: () => void;` to that interface instead and keep the destructure in sync.)

- [ ] **Step 2: Add the button to the Settings header row**

In `SettingsView.tsx`, replace the header row (currently lines 93–100):

```tsx
    <div className="max-w-2xl mx-auto p-8 space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-ink-muted text-sm">
          ← Back
        </button>
        <h1 className="font-semibold">Settings</h1>
      </div>
```

with:

```tsx
    <div className="max-w-2xl mx-auto p-8 space-y-5">
      <div className="flex items-center gap-3">
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
      </div>
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS — App.tsx now passes `onRunSetupAgain` and SettingsView accepts it.

- [ ] **Step 4: Commit**

```bash
git add electron/renderer/src/views/SettingsView.tsx
git commit -m "feat(settings): add 'Run setup again' button to re-open the wizard"
```

---

### Task 4: Give the wizard chrome a per-step status pip

**Files:**
- Modify: `electron/renderer/src/views/OnboardingView.tsx` (imports; the `StepKey`/`STEPS` block at lines 22–23; the `OnboardingView` shell at lines 25–109)

- [ ] **Step 1: Import the status machine and widen the step model**

In `electron/renderer/src/views/OnboardingView.tsx`, add to the imports (after line 16, `import { api } from '../ipc/client';`):

```ts
import { type StepStatus } from '../lib/setup-wizard';
```

Replace the step-key block (currently lines 22–23):

```ts
type StepKey = 'permissions' | 'whisper' | 'hf' | 'llm';
const STEPS: StepKey[] = ['permissions', 'whisper', 'hf', 'llm'];
```

with (adds the new `stt` step and a shared status map):

```ts
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
```

- [ ] **Step 2: Lift per-step status into the shell and render pips**

In `OnboardingView.tsx`, inside the `OnboardingView` component, add a status map next to `const [idx, setIdx] = useState(0);` (line 26):

```ts
  const [stepStatus, setStepStatus] = useState<Record<StepKey, StepStatus>>({
    permissions: 'pending', whisper: 'pending', hf: 'pending', llm: 'pending', stt: 'pending',
  });
  const setStatus = (k: StepKey, s: StepStatus): void =>
    setStepStatus((prev) => ({ ...prev, [k]: s }));
```

Then render a pip beside each progress segment. Replace the progress-bar map (currently lines 69–74):

```tsx
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full ${i <= idx ? 'bg-brand-indigo' : 'bg-surface-border'}`}
            />
          ))}
```

with:

```tsx
          {STEPS.map((k, i) => (
            <div key={k} className="flex-1 flex items-center gap-1">
              <div
                className={`h-1 flex-1 rounded-full ${i <= idx ? 'bg-brand-indigo' : 'bg-surface-border'}`}
              />
              <StatusPip status={stepStatus[k]} />
            </div>
          ))}
```

- [ ] **Step 3: Wire the new step and pass status setters to the enhanced/new steps**

In `OnboardingView.tsx`, replace the step-render block (currently lines 50–53):

```tsx
        {step === 'permissions' && <PermissionsStep />}
        {step === 'whisper' && <WhisperStep />}
        {step === 'hf' && <HfStep />}
        {step === 'llm' && <LlmStep />}
```

with (Task 5 defines the new `LlmStep` props and `SttStep`; the other three keep reporting a simple pass/fail as noted):

```tsx
        {step === 'permissions' && <PermissionsStep onStatus={(s) => setStatus('permissions', s)} />}
        {step === 'whisper' && <WhisperStep onStatus={(s) => setStatus('whisper', s)} />}
        {step === 'hf' && <HfStep onStatus={(s) => setStatus('hf', s)} />}
        {step === 'llm' && <LlmStep onStatus={(s) => setStatus('llm', s)} />}
        {step === 'stt' && <SttStep onStatus={(s) => setStatus('stt', s)} />}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: errors — the step components don't yet accept `onStatus`, and `SttStep` doesn't exist. All resolved in Task 5. (This task and Task 5 land together; commit at the end of Task 5.)

---

### Task 5: Enhance the LLM step (detect + badge + canary) and add the STT step

**Files:**
- Modify: `electron/renderer/src/views/OnboardingView.tsx` (add `isKnownReasoningModel` + `statusFromProbe` imports; rewrite `LlmStep` at lines 379–454; add `SttStep`; add `onStatus` to `PermissionsStep`/`WhisperStep`/`HfStep`)

- [ ] **Step 1: Add the reasoning-badge + probe-mapping imports**

In `OnboardingView.tsx`, extend the imports added in Task 4:

```ts
import { type StepStatus, statusFromProbe } from '../lib/setup-wizard';
import { isKnownReasoningModel } from '../lib/reasoning-models';
```

- [ ] **Step 2: Add `onStatus` to the three unchanged steps (minimal reporting)**

Give each existing step an `onStatus` prop and report `ok`/`warn` from the state it already computes. Concretely:

- `PermissionsStep({ onStatus }: { onStatus: (s: StepStatus) => void })` — in its
  `refresh()`, after `setMic`/`setAudioCapture`, add (mirrors `PermissionsModal.tsx:23`,
  the only honest audio signal — mic is authoritative, system-audio is not verifiable):
  ```ts
      onStatus(micState === 'granted' && perms.audioCapture !== 'denied' ? 'ok' : 'warn');
  ```
- `WhisperStep({ onStatus }: { onStatus: (s: StepStatus) => void })` — in `refresh()`,
  after `setInstalled(...)`, add:
  ```ts
      onStatus((models?.length ?? 0) > 0 ? 'ok' : 'pending'); // where `models` is the fetched list
  ```
  (Use the value just fetched, not stale state.)
- `HfStep({ onStatus }: { onStatus: (s: StepStatus) => void })` — in `validateAndSave()`,
  set `onStatus('ok')` right after `setStatus('valid')`, and `onStatus('warn')` in the
  invalid/error branches.

- [ ] **Step 3: Rewrite `LlmStep` to detect providers, badge reasoning models, and run the canary**

In `OnboardingView.tsx`, replace the entire `LlmStep` function (currently lines 381–454) with:

```tsx
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
```

- [ ] **Step 4: Add the new `SttStep`**

In `OnboardingView.tsx`, add this function directly after `LlmStep` (before the
`StepHeader` helper at the bottom):

```tsx
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
```

- [ ] **Step 5: Type-check the whole renderer**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS — all steps accept `onStatus`, `SttStep` exists, imports resolve.

- [ ] **Step 6: Run the full renderer test suite**

Run: `npx vitest run electron/renderer/src`
Expected: PASS — `setup-wizard.test.ts` passes; no existing renderer test asserted `STEPS.length` or `LlmStep` internals, so nothing else breaks. If any test referenced the old 4-step array, update it to expect 5.

- [ ] **Step 7: Commit**

```bash
git add electron/renderer/src/views/OnboardingView.tsx
git commit -m "feat(setup): wizard detects providers, badges reasoning models, runs canary + STT probe"
```

---

### Task 6: Manual verification (thin React shell)

**Files:** none (manual).

- [ ] **Step 1: Fresh-install path**

Temporarily clear the gate so the wizard auto-shows: in a dev build, set
`onboardedAt` to null (Settings DB or `api.settings.set('onboardedAt', null)` from
the devtools console), reload. Confirm:
- The wizard shows on launch with **5** progress segments, each with a status pip.
- **LLM step:** the provider line reflects `detectProviders` ("LM Studio detected and
  running" when it is); models list with 🧠 on reasoning models; picking a model runs
  the canary and shows the verdict badge; the step pip goes `checking` → `ok`/`warn`.
- Pick a known reasoning model (e.g. a `qwen3`/`gemma` build) and confirm the step is
  `warn` but **Next** is still enabled (proceed-able).
- **STT step:** with whisper-server up, the step goes green ("up and answering"). Stop
  the server, click Test, confirm it flips to a `warn` with the error and Next stays
  enabled.

- [ ] **Step 2: Re-open path**

Finish (or skip) the wizard so `onboardedAt` is stamped. Open Settings, click
**"Run setup again"**, and confirm:
- The wizard re-opens from step 1.
- After skipping/finishing, `onboardedAt` is still set (the wizard does **not**
  re-prompt on the next reload — the re-run didn't clear the onboarded fact).

- [ ] **Step 3: Full suite + type-check**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

---

## Self-Review

**Spec coverage:**
- First-run detection via existing `onboardedAt`, extracted into `firstRunStatus` → Task 1 + Task 2 (no `setupCompleted`, no migration, per the spec's "First-run detection").
- Step-status machine (`canAdvance`, `statusFromProbe`) as pure functions → Task 1.
- Modal-vs-routed decision: wizard stays the existing inline `OnboardingView` (not a portal), matching the app's blocking-flow pattern → Tasks 2/4/5.
- Reuse-don't-reinvent: every step orchestrates existing IPC (`detectProviders`,
  `probe` llm+stt, `healthCheckModel`, `models.list`, `permissions.*`) with signatures
  confirmed against the preload — **no new IPC**, so neither `contracts.ts` nor the
  preload registry is touched → Tasks 4/5.
- Audio honesty: permissions step reports `ok` only from the **authoritative** mic
  signal (`micStatus`), never from the empty-tap system-audio probe, and keeps the
  "macOS will prompt on first Record" instruction → Task 5 Step 2.
- Linear stepper, per-step pending/checking/ok/warn, proceed-past-warn with visible
  risk → Tasks 1 (machine) + 4 (pips) + 5 (LLM/STT `warn` copy).
- Skippable + re-openable, auto-show only on first run → existing Skip buttons + Task 2/3.

**Placeholder scan:** Task 1 and Task 5's `LlmStep`/`SttStep` show complete code. Task
5 Step 2's three unchanged steps are described as surgical additions (an `onStatus`
prop + one report line each) rather than full re-listings, because the plan must not
re-paste the ~150 unchanged lines of `PermissionsStep`/`WhisperStep`/`HfStep` — the
exact insertion points and the exact line to add are given. Every run step has a
command and an expected outcome.

**No new IPC / no migration:** confirmed — the wizard is a pure consumer of channels
that already exist in both `contracts.ts` and the preload registry, and `onboardedAt`
is a pre-existing key/value setting that needs no SQL migration.

**Ordering note:** Task 4 and Task 5 intentionally land together (Task 4's type-check
is expected to fail until Task 5 defines the `onStatus` props and `SttStep`); the
single commit is at the end of Task 5. Task 2's type-check is expected to fail until
Task 3 adds the `onRunSetupAgain` prop. Task 1 and its tests are fully independent and
pass on their own.

**tsconfig caveat:** the exact renderer tsconfig name (`tsconfig.json` used above)
should be confirmed against `package.json`'s `typecheck`/`build` scripts before
running; substitute the project's actual renderer config if it differs.
