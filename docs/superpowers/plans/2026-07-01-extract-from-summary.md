# Extract Action Items from the Summary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extract stage run its JSON action-item prompt over `summary.md` (1–3k tokens) instead of the full `transcript.md` (10k–50k+), so small local reasoning models stop burning their token budget "thinking" and failing the stage.

**Architecture:** Four small, independent changes per the approved spec (`docs/superpowers/specs/2026-07-01-extract-from-summary-design.md`): (1) reword `ACTION_ITEM_SYSTEM_PROMPT` for summary input, (2) make the summary prompt's Action Items rule recall-oriented since extract now depends on it, (3) swap the extract stage's input file and lower its `maxTokens` to 2000, (4) align the Settings health-check canary with the new task shape. Recall/precision split: the summary sweeps for every commitment; the extract prompt keeps its strict pruning rules.

**Tech Stack:** TypeScript (Electron main process), vitest.

---

### Task 1: Reword the extract prompt for summary input

**Files:**
- Modify: `electron/main/pipeline/prompts.ts:89-110` (`ACTION_ITEM_SYSTEM_PROMPT`)
- Test: `electron/main/pipeline/prompts.test.ts`

- [ ] **Step 1: Add the failing tests**

In `electron/main/pipeline/prompts.test.ts`, add to the existing `describe('ACTION_ITEM_SYSTEM_PROMPT', ...)` block (after the `'still requires a bare JSON array with no fences'` test):

```ts
  it('targets the meeting notes and maps the summary conventions to nulls', () => {
    // Extract now runs over summary.md, not the transcript (see the
    // 2026-07-01-extract-from-summary spec). The prompt must name the notes
    // as the input, point at the Action Items section as the primary source,
    // and translate the summary's "(owner TBD)"/"(no date)" markers to null.
    expect(ACTION_ITEM_SYSTEM_PROMPT).toContain('meeting notes');
    expect(ACTION_ITEM_SYSTEM_PROMPT).not.toContain('meeting transcript');
    expect(ACTION_ITEM_SYSTEM_PROMPT).toContain('"## Action Items" section');
    expect(ACTION_ITEM_SYSTEM_PROMPT).toContain('"(owner TBD)"');
    expect(ACTION_ITEM_SYSTEM_PROMPT).toContain('"(no date)"');
  });
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `npx vitest run electron/main/pipeline/prompts.test.ts`
Expected: FAIL — `ACTION_ITEM_SYSTEM_PROMPT` contains `meeting transcript` and lacks the new strings.

- [ ] **Step 3: Reword the prompt**

In `electron/main/pipeline/prompts.ts`, replace the entire `ACTION_ITEM_SYSTEM_PROMPT` constant (currently lines 89–110) with:

```ts
export const ACTION_ITEM_SYSTEM_PROMPT = `Output ONLY genuine action items from the meeting notes below as a JSON array.

Answer immediately with the JSON array and nothing else: the FIRST character you output must be "[" and the LAST must be "]". Do NOT think out loud, plan, restate the notes, or explain your reasoning before answering — no preamble, no commentary, no code fences. Reasoning-capable models: skip your chain-of-thought entirely and emit the array directly.

The notes are a structured meeting summary. If they contain an "## Action Items" section, treat it as the primary source, but also include committed tasks that appear only under other sections (such as Decisions or Follow-ups). Where the notes write "(owner TBD)", output owner: null; where they write "(no date)", output due_date: null.

An action item is a specific, committed task someone agreed to do after the meeting. It MUST have:
- A clear future-tense action (a verb describing work that hasn't happened yet).
- An implied or stated owner (someone who committed to it).
- Ideally a deadline or timeframe.

The following are NOT action items — DO NOT extract them:
- Opinions, observations, or analysis ("the system is slow", "I think we should…").
- Topics discussed but not assigned ("we talked about migrating to Postgres").
- Past events or things already done ("I merged the PR yesterday").
- Paraphrases of decisions without a follow-up task.
- General intentions without a committed owner ("someone should look at this").
- Questions, open issues, or things marked TBD without a concrete next step.

When in doubt, OMIT. Precision matters more than recall — a short accurate list is better than a long speculative one.

Each item: { "text": string, "owner": string | null, "due_date": "YYYY-MM-DD" | null }

Return ONLY the JSON array — no prose, no code fences. If there are no action items, return [].`;
```

(Only three things change: "meeting transcript" → "meeting notes below", "restate the transcript" → "restate the notes", and the new third paragraph about the summary structure and null mapping. Everything else is verbatim.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/main/pipeline/prompts.test.ts`
Expected: PASS (all tests, including the two pre-existing ACTION_ITEM tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/pipeline/prompts.ts electron/main/pipeline/prompts.test.ts
git commit -m "feat(extract): retarget the action-item prompt at the meeting summary"
```

---

### Task 2: Recall-oriented Action Items rule in the summary prompt

**Files:**
- Modify: `electron/main/pipeline/prompts.ts` (the Content rules block inside `buildSummaryPrompt`, currently line 83)
- Test: `electron/main/pipeline/prompts.test.ts`

- [ ] **Step 1: Add the failing test**

In `electron/main/pipeline/prompts.test.ts`, add to the `describe('buildSummaryPrompt', ...)` block:

```ts
  it('makes the Action Items section recall-oriented at every detail level', () => {
    // Action-item extraction now reads the summary instead of the transcript,
    // so a commitment the summary drops is lost for good. The Action Items
    // rule must demand a full sweep and exempt itself from brevity guidance —
    // at all three detail levels, since the rule lives in the shared content
    // rules, not the per-level length block.
    for (const detail of ['concise', 'standard', 'detailed'] as const) {
      const p = buildSummaryPrompt(detail);
      expect(p).toContain('sweep the ENTIRE transcript for commitments');
      expect(p).toContain('exempt from the brevity guidance');
      expect(p).toContain('"(owner TBD)"');
      expect(p).toContain('"(no date)"');
    }
  });
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `npx vitest run electron/main/pipeline/prompts.test.ts`
Expected: FAIL — the summary prompt lacks the sweep/exempt wording.

- [ ] **Step 3: Replace the Action Items content rule**

In `electron/main/pipeline/prompts.ts`, inside the template returned by `buildSummaryPrompt`, replace this single line (currently line 83):

```
- Action Items must have owner and due date if the transcript gives them; otherwise write "(owner TBD)" or "(no date)".
```

with:

```
- Action Items: sweep the ENTIRE transcript for commitments — they are often stated mid-discussion or in the closing minutes, not only in a wrap-up recap. One bullet per item, naming the task, the owner (or "(owner TBD)" if unstated), and the due date (or "(no date)"). This section is exempt from the brevity guidance above: include every genuine commitment, however small — missing a real action item is worse than an extra bullet here.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/main/pipeline/prompts.test.ts`
Expected: PASS (all tests — the pre-existing buildSummaryPrompt tests don't reference the old wording).

- [ ] **Step 5: Commit**

```bash
git add electron/main/pipeline/prompts.ts electron/main/pipeline/prompts.test.ts
git commit -m "feat(summary): recall-oriented Action Items rule (extract now depends on it)"
```

---

### Task 3: Extract stage reads summary.md with a 2000-token cap

**Files:**
- Modify: `electron/main/pipeline/stages/extracting.ts`
- Test: `electron/main/pipeline/stages/extracting.test.ts`

- [ ] **Step 1: Rewrite the tests for the new behavior**

Replace the full contents of `electron/main/pipeline/stages/extracting.test.ts` with:

```ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runExtracting } from './extracting.js';

function makeCtx(chat: (input: unknown) => Promise<string>): { ctx: any; folder: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-e-'));
  const folder = path.join(dir, 'meetings', 'slug');
  fs.mkdirSync(folder, { recursive: true });
  const ctx: any = {
    libraryRoot: dir,
    llmSupervisor: { ensureReady: async () => {} },
    lmStudio: { chat: vi.fn(chat) },
    meetings: { findById: () => ({ slug: 'slug' }) },
    actionItems: { replaceForMeeting: vi.fn() },
    settings: { get: () => 'llama-3.1-8b' },
    logger: { info: () => {} },
  };
  return { ctx, folder };
}

const SUMMARY = '## Overview\nWeekly sync.\n\n## Action Items\n- Send update — Dan — 2026-04-22';

describe('runExtracting', () => {
  it('sends summary.md to the LLM, parses JSON, writes action-items.json + repo', async () => {
    const { ctx, folder } = makeCtx(
      async () => '[{"text":"Send update","owner":"Dan","due_date":"2026-04-22"}]',
    );
    fs.writeFileSync(path.join(folder, 'summary.md'), SUMMARY);
    await runExtracting({ meetingId: 'm' }, ctx);
    // The user message is the summary, not a transcript.
    const arg = ctx.lmStudio.chat.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(arg.messages[1]!.content).toBe(SUMMARY);
    expect(ctx.actionItems.replaceForMeeting).toHaveBeenCalledWith(
      'm',
      expect.arrayContaining([expect.objectContaining({ text: 'Send update' })]),
    );
    const written = JSON.parse(fs.readFileSync(path.join(folder, 'action-items.json'), 'utf8'));
    expect(written).toHaveLength(1);
  });

  it('fails with an actionable error when summary.md is missing or empty', async () => {
    // No-fallback by design: extract must never silently fall back to the
    // transcript (the input that made small reasoning models loop). A missing
    // summary means the pipeline state is broken — say so and stop.
    const missing = makeCtx(async () => '[]');
    await expect(runExtracting({ meetingId: 'm' }, missing.ctx)).rejects.toThrow(
      /summary\.md is missing or empty/,
    );
    const empty = makeCtx(async () => '[]');
    fs.writeFileSync(path.join(empty.folder, 'summary.md'), '  \n');
    await expect(runExtracting({ meetingId: 'm' }, empty.ctx)).rejects.toThrow(
      /summary\.md is missing or empty/,
    );
    expect(missing.ctx.lmStudio.chat).not.toHaveBeenCalled();
    expect(empty.ctx.lmStudio.chat).not.toHaveBeenCalled();
  });

  it('caps the budget at 2000 tokens and keeps the preamble-forbidding prompt', async () => {
    // The summary input is 1–3k tokens, so 2000 output tokens is generous for
    // the short JSON answer while bounding a still-looping reasoning model to
    // tens of seconds instead of minutes.
    const { ctx, folder } = makeCtx(async () => '[]');
    fs.writeFileSync(path.join(folder, 'summary.md'), SUMMARY);
    await runExtracting({ meetingId: 'm' }, ctx);
    const arg = ctx.lmStudio.chat.mock.calls[0]![0] as {
      maxTokens: number;
      messages: { content: string }[];
    };
    expect(arg.maxTokens).toBe(2000);
    expect(arg.messages[0]!.content).toContain('Do NOT think out loud');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/main/pipeline/stages/extracting.test.ts`
Expected: FAIL — the stage still reads `transcript.md` (first test throws ENOENT since no transcript fixture exists; third test sees `maxTokens` 8000).

- [ ] **Step 3: Rewrite the stage**

Replace the full contents of `electron/main/pipeline/stages/extracting.ts` with:

```ts
// electron/main/pipeline/stages/extracting.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { ACTION_ITEM_SYSTEM_PROMPT } from '../prompts.js';
import { parseActionItemsLoose } from '../../lib/action-item-schema.js';

export const runExtracting: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  // Extract from the summary, not the transcript. The stage machine runs
  // summarizing → extracting, so summary.md exists by now, and it is 10–30x
  // smaller than the transcript — small enough that 12B-class reasoning
  // models (Gemma 4, Qwen3) stop burning their whole token budget "thinking"
  // about a transcript-sized input. The summary prompt's Action Items rule is
  // recall-oriented specifically so this stage has everything it needs;
  // deliberately NO transcript fallback — that would silently reintroduce
  // the failing path.
  const summaryPath = path.join(folder, 'summary.md');
  const summary = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8').trim() : '';
  if (!summary) {
    throw new Error(
      'summary.md is missing or empty — re-run processing so the summarize stage regenerates it before action-item extraction.',
    );
  }
  // Wake the LLM provider on demand. No-op when summaryProvider='external'
  // (user-managed LM Studio / Ollama). For managed providers, spawns the
  // server if needed and resets the idle timer.
  await ctx.llmSupervisor.ensureReady();
  const raw = await ctx.lmStudio.chat({
    model: ctx.settings.get('llmModel'),
    temperature: 0,
    disableThinking: ctx.settings.get('disableThinking'),
    // The summary input is small and the JSON answer is short, so 2000 is
    // generous for a well-behaved model while bounding a still-looping
    // reasoning model to tens of seconds instead of minutes. The client
    // rejects budget-burned/looping output.
    maxTokens: 2000,
    messages: [
      { role: 'system', content: ACTION_ITEM_SYSTEM_PROMPT },
      { role: 'user', content: summary },
    ],
  });
  const items = parseActionItemsLoose(raw);
  fs.writeFileSync(path.join(folder, 'action-items.json'), JSON.stringify(items, null, 2));
  ctx.actionItems.replaceForMeeting(meetingId, items);
  ctx.logger.info('extract:done', { meetingId, items: items.length });
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/main/pipeline/stages/extracting.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/pipeline/stages/extracting.ts electron/main/pipeline/stages/extracting.test.ts
git commit -m "feat(extract): read summary.md instead of the transcript, cap at 2000 tokens"
```

---

### Task 4: Align the health-check canary with the summary task shape

**Files:**
- Modify: `electron/main/ipc/handlers.ts:883-899` (the `llmHealthCheckModel` handler's canary)

- [ ] **Step 1: Swap the canary input**

In `electron/main/ipc/handlers.ts`, replace lines 883–889 (the comment and `canaryTranscript` declaration):

```ts
    // Short, representative canary — the exact task shape (structured JSON
    // extraction) that surfaced the original reasoning-loop bug. Small
    // enough that a looping model hits the failure fast rather than after
    // several minutes.
    const canaryTranscript =
      '[00:00:00] Dan: We will ship the v2 API by Friday.\n' +
      '[00:00:05] Priya: I will write the migration guide by Wednesday.';
```

with:

```ts
    // Short, representative canary — the exact task shape extract really
    // runs (JSON extraction over a summary, not a raw transcript — see the
    // 2026-07-01-extract-from-summary spec). Small enough that a looping
    // model hits the failure fast rather than after several minutes.
    const canarySummary =
      '## Action Items\n' +
      '- Ship the v2 API — Dan — 2026-07-03\n' +
      '- Write the migration guide — Priya — (no date)';
```

and update the message that references it (line 899) from `content: canaryTranscript` to `content: canarySummary`.

- [ ] **Step 2: Run the handlers tests (no changes expected)**

Run: `npx vitest run electron/main/ipc/handlers.test.ts`
Expected: PASS — the existing tests mock `chat` and never assert the canary text, so they must pass unchanged. If any fail, stop and re-check.

- [ ] **Step 3: Type-check and run the full suite**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add electron/main/ipc/handlers.ts
git commit -m "feat(settings): health-check canary mirrors the summary-based extract task"
```

---

## Self-Review

**Spec coverage:** §1 input swap + maxTokens + missing-summary error → Task 3. §2 extract prompt rewording → Task 1. §3 summary recall rule → Task 2. §4 canary alignment → Task 4. §5 tests → embedded in Tasks 1–3 (Task 4 needs no new tests per the spec — existing handler tests don't assert canary content). "What does not change" — no task touches `parseActionItemsLoose`, the schema, the banner, or recovery. No gaps.

**Placeholder scan:** Every code step shows complete code; every run step has a command and expected outcome. No TBDs.

**Type consistency:** `ACTION_ITEM_SYSTEM_PROMPT` keeps its name and export across Tasks 1/3/4. The `chat` input shape (`model`, `temperature`, `disableThinking`, `maxTokens`, `messages`) matches the existing `LMStudioClient.chat` signature — no new fields. Task 3's test helper types `ctx` as `any`, matching the existing test file's pattern.

**Ordering note:** Task 1 must land before Task 3's Step 4 only in the sense that the final suite run expects the new prompt wording; each task's own tests pass independently in the listed order.
