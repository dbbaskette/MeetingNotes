# Reasoning-Model Risk Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the "reasoning models ignore the thinking toggle and loop instead of answering" risk proactively — in the model picker, inline in the failure banner when it actually happens, and via an on-demand canary check — instead of only explaining it after a real meeting fails.

**Architecture:** Two fixes to the same underlying bug class (`extracting.ts`'s reasoning-preamble fix, `WeeklyView`'s narrative prompt fix) already exist in this codebase, but the model-selection surface itself has no way to warn a user before they pick a risky model. Investigation confirmed **no list of known reasoning-model name patterns exists anywhere** — the names (Gemma 4, Qwen3, DeepSeek-R1, gpt-oss) are only mentioned in comments and error strings. This plan adds that list once, as a small pure module, and reuses it in three places: (1) the Settings model picker, (2) new inline recovery controls in the failure banner (gated on the exact error-message signature so they only appear for the failure they fix), and (3) a new on-demand health-check IPC call that runs a cheap canary prompt through the existing `LMStudioClient.chat()` path.

**Tech Stack:** React renderer (Settings + meeting detail views), Electron main process (new IPC endpoint reusing the existing LM Studio client and action-item prompt), vitest.

**Coordination note:** Task 2 modifies `FailureBanner` in `MeetingDetailView.tsx` by adding new JSX (a conditional recovery-controls block) — it does not touch the `retry()` function's body. A separate plan, `2026-07-01-unify-retry.md`, changes that same function's body (swapping `api.meetings.start()` for `api.meetings.rerun()`). The two changes don't overlap logically, but apply them as sequential commits (not concurrent edits from two different workers) to avoid a merge conflict on the same file region.

---

### Task 1: Reasoning-model badge in the model picker

**Files:**
- Create: `electron/renderer/src/lib/reasoning-models.ts`
- Test: `electron/renderer/src/lib/reasoning-models.test.ts`
- Modify: `electron/renderer/src/views/SettingsView.tsx` (imports + the LLM model `<Field>`, currently ~lines 124-140)

- [ ] **Step 1: Write the failing test**

```ts
// electron/renderer/src/lib/reasoning-models.test.ts
import { describe, it, expect } from 'vitest';
import { isKnownReasoningModel } from './reasoning-models';

describe('isKnownReasoningModel', () => {
  it('flags Gemma-family models', () => {
    expect(isKnownReasoningModel('google/gemma-4-12b')).toBe(true);
  });

  it('flags Qwen3-family models, including point releases', () => {
    expect(isKnownReasoningModel('qwen/qwen3.5-9b')).toBe(true);
    expect(isKnownReasoningModel('qwen3-8b-instruct')).toBe(true);
  });

  it('flags DeepSeek-R1', () => {
    expect(isKnownReasoningModel('deepseek-r1-distill-llama-8b')).toBe(true);
  });

  it('flags gpt-oss', () => {
    expect(isKnownReasoningModel('gpt-oss-20b')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isKnownReasoningModel('GEMMA-4-12B')).toBe(true);
  });

  it('does not flag an unrelated model', () => {
    expect(isKnownReasoningModel('llama-3.1-8b')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/renderer/src/lib/reasoning-models.test.ts`
Expected: FAIL — cannot find module `./reasoning-models`.

- [ ] **Step 3: Create the module**

```ts
// electron/renderer/src/lib/reasoning-models.ts

// Name-pattern match for local models known to reason via chain-of-thought
// before answering. These are the exact four families already named
// consistently throughout this codebase's error messages and comments
// (see LMStudioClient.chat's disableThinking doc in
// electron/main/lm-studio/client.ts) — collected here once so the model
// picker and failure-recovery UI can warn proactively instead of only
// explaining the failure after it happens on a real meeting.
const REASONING_MODEL_PATTERNS = [/gemma/i, /qwen3/i, /deepseek-r1/i, /gpt-oss/i];

export function isKnownReasoningModel(modelId: string): boolean {
  return REASONING_MODEL_PATTERNS.some((p) => p.test(modelId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/renderer/src/lib/reasoning-models.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Badge the model picker in Settings**

In `electron/renderer/src/views/SettingsView.tsx`, add the import near the top:

```ts
import { isKnownReasoningModel } from '../lib/reasoning-models';
```

Replace the LLM Model `<Field>` block (currently ~lines 124-140):

```tsx
<Field label="LLM Model (loaded in LM Studio)">
  <select
    value={s.llmModel}
    onChange={(e) => update('llmModel', e.target.value)}
    className="input"
  >
    <option value="">(choose)</option>
    {models.map((m) => (
      <option key={m} value={m}>
        {m}
      </option>
    ))}
  </select>
  <div className="text-xs text-ink-muted mt-1">
    Loaded from {s.lmStudioUrl}/v1/models. Used for summarization and action-item extraction.
  </div>
</Field>
```

with:

```tsx
<Field label="LLM Model (loaded in LM Studio)">
  <select
    value={s.llmModel}
    onChange={(e) => update('llmModel', e.target.value)}
    className="input"
  >
    <option value="">(choose)</option>
    {models.map((m) => (
      <option key={m} value={m}>
        {isKnownReasoningModel(m) ? `🧠 ${m}` : m}
      </option>
    ))}
  </select>
  {s.llmModel && isKnownReasoningModel(s.llmModel) && (
    <div className="text-xs text-status-warnText bg-status-warnBg border border-status-warn/30 rounded-lg px-2.5 py-1.5 mt-1.5">
      🧠 This looks like a reasoning model. It may ignore &ldquo;Disable model thinking&rdquo; below
      and burn its token budget on chain-of-thought instead of answering — watch for
      extract/summarize failures that mention a large &ldquo;reasoning&rdquo; word count.
    </div>
  )}
  <div className="text-xs text-ink-muted mt-1">
    Loaded from {s.lmStudioUrl}/v1/models. Used for summarization and action-item extraction.
  </div>
</Field>
```

- [ ] **Step 6: Verify manually in the running app**

Run: `npm run dev`, open Settings.
Expected: any model whose name matches gemma/qwen3/deepseek-r1/gpt-oss shows a 🧠 prefix in the dropdown list, and selecting one shows the amber warning box beneath the select.

- [ ] **Step 7: Type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add electron/renderer/src/lib/reasoning-models.ts electron/renderer/src/lib/reasoning-models.test.ts electron/renderer/src/views/SettingsView.tsx
git commit -m "feat(settings): badge known reasoning models in the LLM picker"
```

---

### Task 2: Inline recovery controls in the failure banner

**Files:**
- Modify: `electron/renderer/src/views/MeetingDetailView.tsx` (imports + the `FailureBanner` component, currently ~lines 471-518; add a new sibling component)

- [ ] **Step 1: Add the import**

In `electron/renderer/src/views/MeetingDetailView.tsx`, add near the top:

```ts
import { isKnownReasoningModel } from '../lib/reasoning-models';
```

- [ ] **Step 2: Gate on the exact reasoning-loop failure signature**

In `FailureBanner` (currently `electron/renderer/src/views/MeetingDetailView.tsx:471-518`), add this line right after `const failedStep = ...`:

```tsx
  // The exact substring LMStudioClient.chat() throws when a reasoning model
  // burns its whole token budget "thinking" instead of answering (see the
  // empty-content guard in electron/main/lm-studio/client.ts). Gate the
  // inline recovery controls on it so they only appear for the failure they
  // actually fix, not every unrelated error.
  const isReasoningLoopFailure = (meeting.errorMessage ?? '').includes('spent its entire token budget');
```

- [ ] **Step 3: Render the recovery controls inside the banner**

Insert the new block right after the `{meeting.errorMessage ? (...) : (...)}` block and before the closing `</div>` of the `flex-1 min-w-0` container:

```tsx
        {isReasoningLoopFailure && <ReasoningRecoveryControls />}
```

So the surrounding structure reads:

```tsx
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-danger-text text-sm">
          Processing failed{failedStep ? ` during ${failedStep}` : ''}
        </div>
        {meeting.errorMessage ? (
          <pre className="mt-1.5 text-xs text-danger-text/90 bg-danger-bg/60 border border-danger-border rounded-md px-2.5 py-1.5 max-h-28 overflow-auto whitespace-pre-wrap font-mono">
            {meeting.errorMessage}
          </pre>
        ) : (
          <div className="text-xs text-danger-text/80 mt-0.5">
            No error detail was recorded. Check the logs in Settings → Diagnostics.
          </div>
        )}
        {isReasoningLoopFailure && <ReasoningRecoveryControls />}
      </div>
```

- [ ] **Step 4: Add the `ReasoningRecoveryControls` component**

Add this new component after `FailureBanner` (in the same file):

```tsx
/** Lets the user fix a reasoning-model loop failure without leaving the
 *  meeting to visit Settings. Changing either field here updates the same
 *  global settings Settings would — this is a shortcut to that existing
 *  state, not a new per-run override concept — so the change also applies
 *  to future meetings until changed again. */
function ReasoningRecoveryControls(): JSX.Element {
  const [models, setModels] = useState<string[]>([]);
  const [llmModel, setLlmModel] = useState('');
  const [disableThinking, setDisableThinking] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([api.models.list(), api.settings.getAll()]).then(([m, settings]) => {
      if (!alive) return;
      const modelList = m as string[];
      const current = settings as { llmModel: string; disableThinking: boolean };
      setModels(modelList);
      setLlmModel(current.llmModel);
      setDisableThinking(current.disableThinking);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  async function changeModel(next: string): Promise<void> {
    setLlmModel(next);
    await api.settings.set('llmModel', next);
  }

  async function changeDisableThinking(next: boolean): Promise<void> {
    setDisableThinking(next);
    await api.settings.set('disableThinking', next);
  }

  if (!loaded) {
    return <div className="text-xs text-danger-text/70 mt-2 italic">Loading recovery options…</div>;
  }

  return (
    <div className="mt-3 pt-3 border-t border-danger-border/60 space-y-2">
      <div className="text-xs font-semibold text-danger-text">
        This looks like a reasoning-model loop. Fix it here, then hit Retry:
      </div>
      <select
        value={llmModel}
        onChange={(e) => void changeModel(e.target.value)}
        className="input text-xs"
      >
        <option value="">(choose)</option>
        {models.map((m) => (
          <option key={m} value={m}>{isKnownReasoningModel(m) ? `🧠 ${m}` : m}</option>
        ))}
      </select>
      <label className="flex items-center gap-2 text-xs text-danger-text cursor-pointer">
        <input
          type="checkbox"
          checked={disableThinking}
          onChange={(e) => void changeDisableThinking(e.target.checked)}
        />
        Disable model thinking
      </label>
    </div>
  );
}
```

- [ ] **Step 5: Verify manually in the running app**

Run: `npm run dev`
- Reproduce (or simulate by editing a meeting's stored `error_message` in the SQLite DB directly for a test meeting) a `failed` meeting whose error message contains "spent its entire token budget".
- Confirm the failure banner now shows the model dropdown + "Disable model thinking" checkbox beneath the error text.
- Change the model in the dropdown, hit Retry: confirm the meeting retries with the newly selected model (cross-check against Settings — the change should be reflected there too, since it's the same global setting).
- Open a `failed` meeting whose error is unrelated (e.g. "STT unreachable"): confirm the recovery controls do NOT appear.

- [ ] **Step 6: Type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add electron/renderer/src/views/MeetingDetailView.tsx
git commit -m "feat(recovery): inline model + thinking-toggle controls in the failure banner"
```

---

### Task 3: On-demand model health-check

**Files:**
- Modify: `electron/main/storage/settings-repo.ts` (Settings interface + DEFAULT_SETTINGS)
- Modify: `electron/main/ipc/contracts.ts` (new channel)
- Modify: `electron/preload/index.ts` (new channel + new `llm.healthCheckModel` method)
- Modify: `electron/main/ipc/handlers.ts` (new handler + two new imports)
- Test: `electron/main/ipc/handlers.test.ts`
- Modify: `electron/renderer/src/views/SettingsView.tsx` (trigger the check on model change, show the verdict)

- [ ] **Step 1: Add the settings field**

In `electron/main/storage/settings-repo.ts`, add to the `Settings` interface (after `disableThinking: boolean;`):

```ts
  /** Cache of on-demand model health-check verdicts, keyed by model id, so
   *  a model already confirmed "ok" or "loops" isn't re-checked every time
   *  Settings re-renders. Populated by the llm:health-check-model IPC
   *  handler; the renderer only reads the immediate call result, but this
   *  cache lets a future "show past checks" UI reuse the data without a
   *  new schema migration. */
  modelHealthChecks: Record<string, { verdict: 'ok' | 'loops'; checkedAt: string }>;
```

And to `DEFAULT_SETTINGS` (after `disableThinking: true,`):

```ts
  modelHealthChecks: {},
```

- [ ] **Step 2: Add the channel to both channel registries**

In `electron/main/ipc/contracts.ts`, in `IPC_CHANNELS`, find the `llmProbe: '...'` entry and add immediately after it:

```ts
  llmProbe: 'llm:probe',
  llmHealthCheckModel: 'llm:health-check-model',
```

Make the identical addition in `electron/preload/index.ts`'s separate `IPC_CHANNELS` literal (these two registries are not shared via import — preload runs in an isolated context — so both must be updated by hand):

```ts
  llmProbe: 'llm:probe',
  llmHealthCheckModel: 'llm:health-check-model',
```

- [ ] **Step 3: Add the preload method**

In `electron/preload/index.ts`, inside the `llm: { ... }` namespace, after the existing `probe` method:

```ts
  llm: {
    detectProviders: () =>
      ipcRenderer.invoke(IPC_CHANNELS.llmDetectProviders) as Promise<{
        lmStudio: { binary: boolean; running: boolean };
        ollama: { binary: boolean; running: boolean };
      }>,
    probe: (url: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.llmProbe, url) as Promise<
        | { ok: true; models: string[] }
        | { ok: false; error: string }
      >,
    // Fires one cheap canary extraction prompt through the real LM Studio
    // chat path and reports whether the model answered normally or hit the
    // "burned its whole token budget thinking" failure — lets a user learn
    // this at model-selection time instead of on a real meeting.
    healthCheckModel: (modelId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.llmHealthCheckModel, modelId) as Promise<{
        verdict: 'ok' | 'loops';
        checkedAt: string;
      }>,
  },
```

(Only the new `healthCheckModel` entry is being added — `detectProviders` and `probe` are shown for placement context and are unchanged.)

- [ ] **Step 4: Write the failing test**

In `electron/main/ipc/handlers.test.ts`, refactor the inline `services` object into a shared factory so the new test doesn't duplicate the whole fixture, then add the new test. Replace the full file with:

```ts
import { describe, it, expect, vi } from 'vitest';
import { registerIpcHandlers } from './handlers.js';
import { LMStudioError } from '../lm-studio/client.js';

function baseServices(overrides: Record<string, unknown> = {}): any {
  return {
    meetings: { listAll: () => [] },
    speakers: { list: () => [] },
    actionItems: { listByMeeting: () => [] },
    settings: { getAll: () => ({}), get: () => '', set: () => {} },
    lmStudio: { listModels: async () => [] },
    recordingManager: { start: async () => ({ sessionId: 's', outputPath: '/o' }), stop: async () => {}, state: () => 'idle', on: () => {} },
    appEnumerator: { list: async () => [] },
    helperPath: '/bin/meeting-notes-tap',
    roster: { confirmSpeaker: () => 'id', confirmSpeakerFor: () => {} },
    pipeline: {
      enqueue: () => {},
      getStatus: () => ({ paused: false, currentId: null, queueLength: 0, queueIds: [] }),
      pause: () => {},
      resume: () => {},
      clearQueue: () => [],
    },
    exporters: {},
    libraryRoot: '/tmp',
    ...overrides,
  };
}

describe('registerIpcHandlers', () => {
  it('registers all known channels', () => {
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    registerIpcHandlers(fakeIpc, baseServices());
    const channels = handle.mock.calls.map((c) => c[0]);
    expect(channels).toContain('meetings:list');
    expect(channels).toContain('meetings:get');
    expect(channels).toContain('export:run');
    expect(channels).toContain('models:list');
    // New endpoints from the UX-review pass: Settings "Test connection"
    // probes (one per LLM/STT side) and the drag-and-drop import handler.
    expect(channels).toContain('stt:probe');
    expect(channels).toContain('llm:probe');
    expect(channels).toContain('meetings:import-dropped');
    expect(channels).toContain('transcript:export');
    // Queue controls (pause / resume / clear / status snapshot).
    expect(channels).toContain('pipeline:pause');
    expect(channels).toContain('pipeline:resume');
    expect(channels).toContain('pipeline:clear');
    expect(channels).toContain('pipeline:status');
    // Reasoning-model health check.
    expect(channels).toContain('llm:health-check-model');
  });

  it('llm:health-check-model reports ok for a well-behaved model and loops for one that burns its budget', async () => {
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const stored: Record<string, unknown> = {};
    const chat = vi.fn()
      .mockResolvedValueOnce('[]')
      .mockRejectedValueOnce(new LMStudioError(
        'LM Studio produced no answer — the model spent its entire token budget "thinking" (~500 reasoning words) without writing any output.',
      ));
    const services = baseServices({
      settings: {
        getAll: () => ({}),
        get: (key: string) => stored[key] ?? {},
        set: (key: string, value: unknown) => { stored[key] = value; },
      },
      lmStudio: { listModels: async () => [], chat },
    });
    registerIpcHandlers(fakeIpc, services);
    const call = handle.mock.calls.find((c) => c[0] === 'llm:health-check-model');
    expect(call).toBeDefined();
    const handler = call![1] as (e: unknown, modelId: unknown) => Promise<{ verdict: string; checkedAt: string }>;

    const ok = await handler(null, 'good-model');
    expect(ok.verdict).toBe('ok');

    const loops = await handler(null, 'bad-model');
    expect(loops.verdict).toBe('loops');

    // Both verdicts get cached under their model id.
    const cache = stored.modelHealthChecks as Record<string, { verdict: string }>;
    expect(cache['good-model']!.verdict).toBe('ok');
    expect(cache['bad-model']!.verdict).toBe('loops');
  });

  it('llm:health-check-model re-throws a genuine (non-reasoning-loop) error', async () => {
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const chat = vi.fn().mockRejectedValueOnce(new LMStudioError('LM Studio 500 on /v1/chat/completions'));
    const services = baseServices({ lmStudio: { listModels: async () => [], chat } });
    registerIpcHandlers(fakeIpc, services);
    const call = handle.mock.calls.find((c) => c[0] === 'llm:health-check-model');
    const handler = call![1] as (e: unknown, modelId: unknown) => Promise<unknown>;
    await expect(handler(null, 'some-model')).rejects.toThrow('LM Studio 500');
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run electron/main/ipc/handlers.test.ts`
Expected: FAIL — no handler registered for channel `'llm:health-check-model'`.

- [ ] **Step 6: Add the two new imports to `handlers.ts`**

In `electron/main/ipc/handlers.ts`, change the existing type-only LMStudioClient import to also bring in the `LMStudioError` class (a runtime value, needed for the `instanceof` check below):

```ts
import { LMStudioError, type LMStudioClient } from '../lm-studio/client.js';
```

(This replaces the current `import type { LMStudioClient } from '../lm-studio/client.js';` line.)

Add a new import for the action-item prompt, alongside the other pipeline-related imports:

```ts
import { ACTION_ITEM_SYSTEM_PROMPT } from '../pipeline/prompts.js';
```

- [ ] **Step 7: Implement the handler**

Add this handler in `electron/main/ipc/handlers.ts`, near the existing `llmProbe` handler:

```ts
  ipc.handle(IPC_CHANNELS.llmHealthCheckModel, async (_e, modelId: unknown) => {
    if (typeof modelId !== 'string' || modelId.length === 0) throw new Error('invalid model id');
    const checkedAt = new Date().toISOString();
    // Short, representative canary — the exact task shape (structured JSON
    // extraction) that surfaced the original reasoning-loop bug. Small
    // enough that a looping model hits the failure fast rather than after
    // several minutes.
    const canaryTranscript =
      '[00:00:00] Dan: We will ship the v2 API by Friday.\n' +
      '[00:00:05] Priya: I will write the migration guide by Wednesday.';
    let verdict: 'ok' | 'loops';
    try {
      await s.lmStudio.chat({
        model: modelId,
        temperature: 0,
        disableThinking: true,
        maxTokens: 1500,
        messages: [
          { role: 'system', content: ACTION_ITEM_SYSTEM_PROMPT },
          { role: 'user', content: canaryTranscript },
        ],
      });
      verdict = 'ok';
    } catch (e) {
      // Only the specific reasoning-loop failure counts as "loops" — a
      // network error or an unloaded model shouldn't be mislabeled as a
      // reasoning problem.
      if (e instanceof LMStudioError && e.message.includes('spent its entire token budget')) {
        verdict = 'loops';
      } else {
        throw e;
      }
    }
    const result = { verdict, checkedAt };
    const cache = s.settings.get('modelHealthChecks');
    s.settings.set('modelHealthChecks', { ...cache, [modelId]: result });
    return result;
  });
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run electron/main/ipc/handlers.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 9: Trigger the check from Settings and show the verdict**

In `electron/renderer/src/views/SettingsView.tsx`, add new state near the existing `models`/`providers` state:

```tsx
const [healthCheck, setHealthCheck] = useState<{ modelId: string; state: 'checking' | 'ok' | 'loops' } | null>(null);
```

Add this function alongside the existing `update` function:

```tsx
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
```

Update the model `<select>`'s `onChange` (from Task 1's edit) from:

```tsx
onChange={(e) => update('llmModel', e.target.value)}
```

to:

```tsx
onChange={(e) => void changeLlmModel(e.target.value)}
```

Add the status display right after the `<select>` and before Task 1's reasoning-model warning box:

```tsx
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
```

- [ ] **Step 10: Verify manually in the running app**

Run: `npm run dev`, open Settings.
- Select a known-good (non-reasoning) model in LM Studio: confirm "Checking…" appears briefly, then "✓ Passed a quick extraction canary."
- Select a reasoning model that's known to loop: confirm it eventually shows "⚠ This model looped…" (this requires an actual LM Studio instance with such a model loaded to observe the real failure path; the automated test in Step 4 already covers the logic without one).

- [ ] **Step 11: Type-check and run the full test suite**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx vitest run`
Expected: no type errors; all tests pass, including the new ones.

- [ ] **Step 12: Commit**

```bash
git add electron/main/storage/settings-repo.ts electron/main/ipc/contracts.ts electron/preload/index.ts electron/main/ipc/handlers.ts electron/main/ipc/handlers.test.ts electron/renderer/src/views/SettingsView.tsx
git commit -m "feat(settings): on-demand reasoning-loop health check for the selected model"
```

---

## Self-Review

**Spec coverage:** All three ideas grouped into this plan are covered — #1 (badge in the picker, Task 1), #2 (inline recovery controls, Task 2), #6 (health-check on select, Task 3).

**Placeholder scan:** No TBD/TODO; every step has complete, runnable code, including the full refactored `handlers.test.ts`.

**Type consistency:**
- `isKnownReasoningModel(modelId: string): boolean` is defined once in Task 1 and imported verbatim (same name, same signature) into both `SettingsView.tsx` (Task 1) and `MeetingDetailView.tsx` (Task 2).
- `{ verdict: 'ok' | 'loops'; checkedAt: string }` is the exact shape returned by the Task 3 handler, typed identically in the preload method's `Promise<...>` annotation, and consumed with matching field names (`result.verdict`) in the Task 3 renderer code — no drift.
- `modelHealthChecks: Record<string, { verdict: 'ok' | 'loops'; checkedAt: string }>` in `settings-repo.ts` matches the object the handler writes via `s.settings.set('modelHealthChecks', { ...cache, [modelId]: result })`.

**Risk check:** The health-check canary (Task 3) calls the real `LMStudioClient.chat()` — on a genuinely large/slow local model this could take up to the full 10-minute timeout before surfacing "loops" if it degenerates into the failure. This is inherent to testing the real behavior (a synthetic/instant check couldn't actually detect the failure) and mirrors the risk already accepted by the existing `llm:probe` "test connection" pattern. No mitigation beyond what's already in `LMStudioClient.chat()` (the 10-minute abort) is added here, since a shorter timeout would risk false "loops" verdicts on a merely-slow-but-fine model.
