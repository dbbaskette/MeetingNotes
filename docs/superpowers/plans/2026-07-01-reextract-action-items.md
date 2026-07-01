# Re-extract Action Items from the Edited Summary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user who edited and saved `summary.md` click "Re-extract" on the Action Items panel to regenerate the meeting's action items from the current on-disk summary — re-running ONLY the extract step (one LLM call over `summary.md`, ≤2000 tokens), without touching the pipeline or the meeting's `done`/pipeline state.

**Architecture:** Per the approved spec (`docs/superpowers/specs/2026-07-01-reextract-action-items-design.md`): a dedicated, state-neutral IPC endpoint `action-items:reextract` inlines the same extract logic the stage runs (read `summary.md` → `ensureLLMReady()` → one `chat()` with `ACTION_ITEM_SYSTEM_PROMPT` + `maxTokens: 2000` → `parseActionItemsLoose` → `replaceForMeeting` + write `action-items.json`) and returns `{ count }`. It does NOT reuse the Pipeline (which mutates `pipelineStage`/`status`) or `meetings:rerun` (which re-enqueues + clears artifacts). The button lives in `ActionItemsPanel` with idle / in-progress / error states and calls `onReload()` on success.

**Tech Stack:** TypeScript (Electron main + preload), React renderer, vitest.

**IPC sync warning:** This adds an IPC channel. Three files hold IPC state that must stay in sync **by hand**: `electron/main/ipc/contracts.ts` (`IPC_CHANNELS`), `electron/preload/index.ts` (a *separate* `IPC_CHANNELS` literal + the `api.*` methods), and `electron/main/ipc/handlers.ts` (the handler registration). Task 1 does contracts + preload together; Task 2 does the handler. Missing either registry means the renderer calls a channel main never registered (silent `invoke` rejection).

---

### Task 1: Declare the `action-items:reextract` channel in BOTH IPC registries

**Files:**
- Modify: `electron/main/ipc/contracts.ts` (the `IPC_CHANNELS` map, after `actionItemsCreate` at line 80)
- Modify: `electron/preload/index.ts` (the *separate* `IPC_CHANNELS` literal after `actionItemsCreate` at line 38, and the `api.actionItems` object after `create` at line 205)

- [ ] **Step 1: Add the channel to the main-process contract**

In `electron/main/ipc/contracts.ts`, add this line to `IPC_CHANNELS` immediately after `actionItemsCreate: 'action-items:create',` (line 80):

```ts
  /** Re-run ONLY the extract step against the current on-disk summary.md and
   *  replace the meeting's action items. Does NOT touch pipeline state — a
   *  'done' meeting stays 'done'. Used by the Action Items panel's Re-extract
   *  button after the user edits + saves the summary. Returns { count }. */
  actionItemsReextract: 'action-items:reextract',
```

- [ ] **Step 2: Add the SAME channel to the preload's copy of the literal**

In `electron/preload/index.ts`, add this line to *its* `IPC_CHANNELS` literal immediately after `actionItemsCreate: 'action-items:create',` (line 38):

```ts
  actionItemsReextract: 'action-items:reextract',
```

- [ ] **Step 3: Expose `api.actionItems.reextract`**

In `electron/preload/index.ts`, inside the `actionItems: { ... }` object, add this after the `create` method (line 205, before the closing `},`):

```ts
    /** Re-run only the extract step over the current saved summary.md and
     *  replace this meeting's action items. Resolves with the new count. */
    reextract: (meetingId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.actionItemsReextract, meetingId) as Promise<{ count: number }>,
```

- [ ] **Step 4: Type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors (both literals now carry the key; the `api` method references it).

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/contracts.ts electron/preload/index.ts
git commit -m "feat(ipc): declare action-items:reextract in both IPC registries"
```

---

### Task 2: Register the `action-items:reextract` handler

**Files:**
- Modify: `electron/main/ipc/handlers.ts` (the `IpcServices` interface at lines 47–65; a new import near line 24; a new handler registered next to `actionItemsCreate` at line 512)
- Test: `electron/main/ipc/handlers.test.ts`

- [ ] **Step 1: Add the failing tests**

In `electron/main/ipc/handlers.test.ts`, first extend `baseServices()` so the new handler's dependency exists. Add these two keys to the object returned by `baseServices` (after `libraryRoot: '/tmp',` at line 24):

```ts
    llmSupervisor: { ensureReady: async () => {} },
    logger: { info: () => {}, error: () => {} },
```

Add `action-items:reextract` to the channel-registration assertion in the `'registers all known channels'` test (after line 51, `expect(channels).toContain('llm:health-check-model');`):

```ts
    // Re-extract action items from the edited summary.
    expect(channels).toContain('action-items:reextract');
```

Then add this new test to the `describe('registerIpcHandlers', ...)` block (after the last existing test, before the closing `});` at line 98):

```ts
  it('action-items:reextract re-runs extract over summary.md and replaces the items', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-re-'));
    const folder = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'summary.md'),
      '## Action Items\n- Send the update — Dan — 2026-04-22',
    );

    const chat = vi.fn().mockResolvedValue(
      '[{"text":"Send the update","owner":"Dan","due_date":"2026-04-22"}]',
    );
    const replaceForMeeting = vi.fn();
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const services = baseServices({
      libraryRoot: dir,
      meetings: { listAll: () => [], findById: () => ({ id: 'm', slug: 'slug' }) },
      actionItems: { listByMeeting: () => [], replaceForMeeting },
      settings: { getAll: () => ({}), get: () => 'llama-3.1-8b', set: () => {} },
      lmStudio: { listModels: async () => [], chat },
    });
    registerIpcHandlers(fakeIpc, services);
    const call = handle.mock.calls.find((c) => c[0] === 'action-items:reextract');
    expect(call).toBeDefined();
    const handler = call![1] as (e: unknown, id: unknown) => Promise<{ count: number }>;

    const result = await handler(null, 'm');

    // Sent the summary, capped at 2000 tokens, with the strict extract prompt.
    const arg = chat.mock.calls[0]![0] as { maxTokens: number; messages: { content: string }[] };
    expect(arg.maxTokens).toBe(2000);
    expect(arg.messages[1]!.content).toContain('## Action Items');
    // Replaced the meeting's items with the parsed output and reported the count.
    expect(replaceForMeeting).toHaveBeenCalledWith(
      'm',
      expect.arrayContaining([expect.objectContaining({ text: 'Send the update' })]),
    );
    expect(result.count).toBe(1);
    // Persisted the JSON snapshot alongside the summary.
    expect(fs.existsSync(path.join(folder, 'action-items.json'))).toBe(true);
  });

  it('action-items:reextract throws (without calling the LLM) when summary.md is missing', async () => {
    const chat = vi.fn();
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const services = baseServices({
      libraryRoot: '/tmp/does-not-exist-mn',
      meetings: { listAll: () => [], findById: () => ({ id: 'm', slug: 'no-such-slug' }) },
      lmStudio: { listModels: async () => [], chat },
    });
    registerIpcHandlers(fakeIpc, services);
    const call = handle.mock.calls.find((c) => c[0] === 'action-items:reextract');
    const handler = call![1] as (e: unknown, id: unknown) => Promise<unknown>;
    await expect(handler(null, 'm')).rejects.toThrow(/summary\.md is missing or empty/);
    expect(chat).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/main/ipc/handlers.test.ts`
Expected: FAIL — `action-items:reextract` isn't registered, so the channel-list assertion and both new tests fail (`call` is `undefined`).

- [ ] **Step 3: Add the import and the service dependency**

In `electron/main/ipc/handlers.ts`, add this import after the `ACTION_ITEM_SYSTEM_PROMPT` import (line 15):

```ts
import { parseActionItemsLoose } from '../lib/action-item-schema.js';
```

Then add this field to the `IpcServices` interface, right after `lmStudio: LMStudioClient;` (line 52):

```ts
  /** Lazy-spawn supervisor for the summary LLM. reextract calls
   *  ensureReady() before its chat() call, exactly as the extract stage
   *  does — a no-op when provider='external' (user-managed LM Studio). */
  llmSupervisor: { ensureReady: () => Promise<void> };
```

- [ ] **Step 4: Register the handler**

In `electron/main/ipc/handlers.ts`, add this handler immediately after the `actionItemsCreate` handler (after its closing `});` at line 521):

```ts
  ipc.handle(IPC_CHANNELS.actionItemsReextract, async (_e, meetingId: unknown) => {
    if (typeof meetingId !== 'string' || meetingId.length === 0) throw new Error('invalid args');
    const meeting = s.meetings.findById(meetingId);
    if (!meeting) throw new Error('meeting not found');
    // Re-run ONLY the extract step against the current on-disk summary.md.
    // Same file, prompt, and token budget as the extract stage
    // (electron/main/pipeline/stages/extracting.ts) — keep them in lockstep.
    // Deliberately state-neutral: we never touch pipelineStage/status, so a
    // 'done' meeting stays 'done' and can't be dragged back into the queue.
    const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
    const summaryPath = path.join(folder, 'summary.md');
    const summary = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8').trim() : '';
    if (!summary) {
      throw new Error(
        'summary.md is missing or empty — save a summary (with an Action Items section) before re-extracting.',
      );
    }
    await s.llmSupervisor.ensureReady();
    const raw = await s.lmStudio.chat({
      model: s.settings.get('llmModel'),
      temperature: 0,
      disableThinking: s.settings.get('disableThinking'),
      // Small input, short JSON answer: 2000 is generous while bounding a
      // still-looping reasoning model to seconds. Matches the extract stage.
      maxTokens: 2000,
      messages: [
        { role: 'system', content: ACTION_ITEM_SYSTEM_PROMPT },
        { role: 'user', content: summary },
      ],
    });
    const items = parseActionItemsLoose(raw);
    fs.writeFileSync(path.join(folder, 'action-items.json'), JSON.stringify(items, null, 2));
    s.actionItems.replaceForMeeting(meetingId, items);
    s.logger.info('action-items:reextract', { meetingId, items: items.length });
    return { count: items.length };
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run electron/main/ipc/handlers.test.ts`
Expected: PASS (all tests, including the two new ones and the extended channel-list assertion).

- [ ] **Step 6: Pass `llmSupervisor` into `registerIpcHandlers`**

In `electron/main/index.ts`, add `llmSupervisor,` to the object passed to `registerIpcHandlers` — the local `llmSupervisor` const already exists (it's in the pipeline `ctx`). Add it after `lmStudio,` in that services object (around line 570):

```ts
    lmStudio,
    llmSupervisor,
```

- [ ] **Step 7: Type-check the full main/preload project**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors — `IpcServices` now requires `llmSupervisor`, and index.ts supplies it; `logger` was already a required `IpcServices` field and is already passed.

- [ ] **Step 8: Commit**

```bash
git add electron/main/ipc/handlers.ts electron/main/ipc/handlers.test.ts electron/main/index.ts
git commit -m "feat(ipc): action-items:reextract handler re-runs extract over the saved summary"
```

---

### Task 3: Re-extract button in the Action Items panel

**Files:**
- Modify: `electron/renderer/src/views/MeetingDetailView.tsx` (`ActionItemsPanel`, lines 1240–1301)

- [ ] **Step 1: Add re-extract state to `ActionItemsPanel`**

In `electron/renderer/src/views/MeetingDetailView.tsx`, in `ActionItemsPanel`, replace the state declarations and `items` line (lines 1246–1248):

```tsx
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const items = meeting.actionItems;
```

with:

```tsx
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [reextracting, setReextracting] = useState(false);
  const [reextractError, setReextractError] = useState<string | null>(null);
  const items = meeting.actionItems;

  // Re-run ONLY the extract step over the current SAVED summary.md and swap in
  // the fresh items. The meeting's pipeline state is untouched (a 'done'
  // meeting stays 'done'); the whole thing is one short LLM call. onReload()
  // re-fetches the meeting so the regenerated items render.
  async function reextract(): Promise<void> {
    if (reextracting) return;
    setReextracting(true);
    setReextractError(null);
    try {
      await api.actionItems.reextract(meeting.id);
      await onReload();
    } catch (e) {
      setReextractError((e as Error).message);
    } finally {
      setReextracting(false);
    }
  }
```

- [ ] **Step 2: Add the button + helper line + error to the footer**

In the same `ActionItemsPanel`, replace the trailing "+ Add item" block (lines 1291–1298):

```tsx
      {!adding && (
        <button
          onClick={() => setAdding(true)}
          className="mt-3 text-xs font-semibold text-brand-indigo hover:underline"
        >
          + Add item
        </button>
      )}
```

with:

```tsx
      {!adding && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setAdding(true)}
              className="text-xs font-semibold text-brand-indigo hover:underline"
            >
              + Add item
            </button>
            <button
              onClick={() => void reextract()}
              disabled={reextracting}
              className="text-xs font-semibold text-brand-indigo hover:underline disabled:opacity-50 disabled:no-underline"
            >
              {reextracting ? 'Re-extracting…' : '↻ Re-extract from summary'}
            </button>
          </div>
          <div className="text-[11px] text-ink-muted">
            Re-extract reads the <span className="font-semibold">saved</span> summary. Edit the
            summary&rsquo;s Action Items section and Save first, then re-extract to pick up your changes.
          </div>
          {reextractError && (
            <div className="text-xs text-danger-text bg-danger-bg border border-danger-border rounded-md px-2.5 py-1.5 whitespace-pre-wrap font-mono">
              {reextractError}
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors — `api.actionItems.reextract(id)` returns `Promise<{ count: number }>` (declared in preload, Task 1), and the component already receives `onReload`.

- [ ] **Step 4: Verify manually in the running app**

Run: `npm run dev`
- Open a `done` meeting that has a summary and some action items.
- On the Summary tab, edit the `## Action Items` section (add a bullet like `- Follow up with Priya — Dan — (no date)`) and click Save.
- On the Action Items tab, click "↻ Re-extract from summary".
- Confirm the button shows "Re-extracting…", then the new item appears in the list and the meeting's status pill still reads Done (no re-processing, no queue movement).
- Optional error path: stop LM Studio, click Re-extract, confirm the inline error box shows the failure message and the meeting is unchanged.

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/src/views/MeetingDetailView.tsx
git commit -m "feat(action-items): Re-extract-from-summary button with in-progress/error states"
```

---

### Task 4: Full verification

- [ ] **Step 1: Type-check + full test suite**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx vitest run`
Expected: no type errors; all tests pass (including the extended `handlers.test.ts`).

- [ ] **Step 2: Commit any stragglers**

Only if `git status` shows uncommitted changes from the run (there shouldn't be):

```bash
git status
```

---

## Self-Review

**Spec coverage:** §1 contract channel → Task 1 Step 1. §2 preload literal + `api` method → Task 1 Steps 2–3. §3 handler + `llmSupervisor` in `IpcServices` → Task 2 Steps 3–5. §4 wire `llmSupervisor` in index.ts → Task 2 Step 6. §5 button + states + helper line → Task 3. §6 tests → Task 2 Step 1 (handler + missing-summary) and the channel-list assertion. "What does not change" — no task touches `extracting.ts`, the pipeline, the stage machine, `meetings:rerun`, `meetings:save-summary`, `parseActionItemsLoose`, or the schema. No gaps.

**IPC three-registry sync:** contracts.ts (Task 1 Step 1) + preload literal (Task 1 Step 2) + handler registration (Task 2 Step 4) are all covered, and the "registers all known channels" assertion (Task 2 Step 1) guards against forgetting the handler. The plan calls the by-hand duplication out explicitly in the header.

**Drift risk (the one to watch):** the handler duplicates the extract contract (summary.md path, missing-summary error, `ACTION_ITEM_SYSTEM_PROMPT`, `maxTokens: 2000`, `temperature: 0`, `disableThinking`, `parseActionItemsLoose`, `action-items.json` write) rather than importing `runExtracting`. This is deliberate (spec "Why not reuse `runExtracting`" — the stage needs a full `PipelineContext` and routes through the state-mutating Pipeline). If the extract contract changes, both `extracting.ts` and this handler must change together. Accepted; noted here so a reviewer knows it's intentional.

**State-neutrality:** the handler reads/writes only `summary.md` (read), `action-items.json` (write), and the `action_items` DB rows (`replaceForMeeting`). It never calls `updateStage`/`updateStatus`/`enqueue`, so a `done` meeting stays `done` — verified in Task 3 Step 4's manual check.

**Placeholder scan:** every code step shows complete code; every run step has a command and an expected outcome. No TBDs.

**Type consistency:** `api.actionItems.reextract(id: string): Promise<{ count: number }>` (preload) matches the renderer call and the handler's `return { count }`. The handler's `chat({ model, temperature, disableThinking, maxTokens, messages })` shape matches the existing `LMStudioClient.chat` signature (identical to the extract stage and the health-check handler). `llmSupervisor: { ensureReady: () => Promise<void> }` matches the pipeline `ctx` object index.ts already builds, so passing the same const needs no new construction.
