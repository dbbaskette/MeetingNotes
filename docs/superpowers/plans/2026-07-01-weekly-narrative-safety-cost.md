# Weekly Narrative Safety & Cost Signal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the one remaining gap in the Weekly narrative's reasoning-model safety (it already sets a generous token budget and disables thinking, but its system prompt doesn't forbid a reasoning preamble the way `extract`'s does), and show a cost signal before the user clicks "Regenerate" instead of only after.

**Architecture:** Investigation (this plan is the direct result of it) confirmed Weekly's LLM call already does two of the three things that fixed `extract`'s reasoning-model bug: `disableThinking: true` is passed, and `maxTokens: 16000` is generous. The one gap is the system prompt itself — it says "Output ONLY the JSON object" but never forbids the preamble a reasoning model tends to emit first, unlike `ACTION_ITEM_SYSTEM_PROMPT`'s explicit "the FIRST character you output must be...". Separately, the renderer already receives `hasFreshCache`, `fromCache`, and `generatedAt` from the backend but never surfaces them before the Regenerate click — that's a pure UI change, no backend work needed.

**Tech Stack:** Electron main process (LM Studio prompt), React renderer, vitest.

---

### Task 1: Forbid reasoning preamble in the weekly narrative prompt

**Files:**
- Modify: `electron/main/weekly/prompt.ts:15-26` (the `SYSTEM_PROMPT` constant)
- Test: `electron/main/weekly/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `electron/main/weekly/prompt.test.ts` (alongside the existing `describe('createNarrativeGenerator', ...)` block):

```ts
it('forbids reasoning preamble so reasoning models emit the JSON directly', async () => {
  // Regression guard: extracting.ts hit this exact failure — a reasoning
  // model (Gemma 4-class) restates the input and burns its whole token
  // budget before ever emitting the answer. maxTokens and disableThinking
  // are already generous here; the missing piece was the system prompt
  // never forbidding the preamble outright the way ACTION_ITEM_SYSTEM_PROMPT
  // does. Guard both the "no preamble" instruction and that the JSON-only
  // contract survives it.
  const chat = vi.fn(async () => '{"narrative":"x","themes":[],"decisions":[]}');
  const gen = createNarrativeGenerator({ chat } as never, () => 'some-model');
  await gen({ weekLabel: 'W', meetings: [], openActions: [] });
  const arg = chat.mock.calls[0]![0] as { messages: { content: string }[] };
  const systemPrompt = arg.messages[0]!.content;
  expect(systemPrompt).toContain('Do NOT think out loud');
  expect(systemPrompt).toContain('skip your chain-of-thought');
  expect(systemPrompt).toContain('Output ONLY the JSON object');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/main/weekly/prompt.test.ts -t "forbids reasoning preamble"`
Expected: FAIL — `systemPrompt` does not contain "Do NOT think out loud".

- [ ] **Step 3: Update the system prompt**

In `electron/main/weekly/prompt.ts`, replace the `SYSTEM_PROMPT` constant (lines 15-26):

```ts
const SYSTEM_PROMPT = `You synthesize a person's week of meeting notes into a detailed summary they can use to catch up on and recall what actually happened.

Return JSON with exactly three fields:
- narrative: 2-3 short paragraphs (200-350 words total) giving the high-level shape of the week: the overall focus, the key follow-ups owed and to whom, and what's heading into next week. Plain prose. No bullet points, no markdown headings, no emoji. Use the user's voice ("you" / "your") naturally.
- themes: array of 3-6 topic threads that run through the week — this is the most important field for recall. Each theme is an object:
    - title: a short noun phrase naming the thread (e.g. "Q3 Postgres migration", "Hiring", "Pricing rework").
    - detail: 2-4 sentences on what was actually discussed across the week, where it landed, and what's still open. Be concrete — name the substance, not just that it "was discussed".
    - meetings: array of the source meeting TITLES (verbatim, as given below) this thread draws from.
  Group related discussions even when they span multiple meetings. Only build threads from what's in the summaries; don't invent. Cover the substantive topics — don't collapse the week into one vague theme.
- decisions: array of 3-6 strings, each one explicit decision made during the week. Format each as "<decision> — <source meeting title>". Only include decisions actually stated in the meeting summaries; don't invent.

Answer immediately with the JSON object and nothing else: the FIRST character you output must be "{" and the LAST must be "}". Do NOT think out loud, plan, restate the input, or explain your reasoning before answering — no preamble, no commentary, no code fences. Reasoning-capable models: skip your chain-of-thought entirely and emit the object directly.

Output ONLY the JSON object. No prose before or after, no code fences, no comments.`;
```

(This inserts one new paragraph before the existing closing line — everything else is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/main/weekly/prompt.test.ts`
Expected: PASS (all tests, including the new one).

- [ ] **Step 5: Commit**

```bash
git add electron/main/weekly/prompt.ts electron/main/weekly/prompt.test.ts
git commit -m "fix(weekly): forbid reasoning preamble in narrative prompt"
```

---

### Task 2: Show cache/cost status before the Regenerate click

**Files:**
- Modify: `electron/renderer/src/views/WeeklyView.tsx` (the Regenerate button footer, currently ~lines 766-786)

- [ ] **Step 1: Locate the current footer block**

The existing code (`electron/renderer/src/views/WeeklyView.tsx:766-786`):

```tsx
{!inProgress && (
  <div className="mt-5 pt-4 border-t border-surface-border flex items-center justify-between text-xs text-ink-muted">
    <span>
      {narrative?.generatedAt
        ? `Generated ${new Date(narrative.generatedAt).toLocaleString()}`
        : narrState === 'loading'
          ? '…'
          : 'Not yet generated'}
    </span>
    <button
      onClick={onRegenerate}
      disabled={narrState === 'loading'}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:bg-surface-sunken text-ink-soft hover:text-ink transition disabled:opacity-50"
    >
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M21 12a9 9 0 1 1-3.5-7.1L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
      {narrState === 'loading' ? 'Drafting…' : 'Regenerate'}
    </button>
  </div>
)}
```

`hasFreshCache` (on `structured: WeeklyStructured`) and `narrative?.generatedAt` are already available in this component's scope — this is a pure rendering change, no new data fetching.

- [ ] **Step 2: Add a cost hint next to the Regenerate button**

Replace the `<button>` in that block with:

```tsx
<button
  onClick={onRegenerate}
  disabled={narrState === 'loading'}
  title={
    structured?.hasFreshCache
      ? 'This week is already cached — regenerating will still take ~30s+ to call the model fresh.'
      : 'No cached narrative yet — first generation typically takes 30s+.'
  }
  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:bg-surface-sunken text-ink-soft hover:text-ink transition disabled:opacity-50"
>
  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M21 12a9 9 0 1 1-3.5-7.1L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
  {narrState === 'loading' ? 'Drafting…' : 'Regenerate (~30s)'}
</button>
```

The label change ("Regenerate" → "Regenerate (~30s)") is the visible signal that survives a screenshot or a quick glance; the `title` tooltip gives the fuller explanation, including the fact that regenerating is never instant even when a cache exists (it always calls the model fresh — `hasFreshCache` only affects the *initial* page load, not what Regenerate does).

- [ ] **Step 3: Manually verify in the running app**

Run: `npm run dev`, open the Weekly view for a week with an existing narrative.
Expected: the Regenerate button reads "Regenerate (~30s)"; hovering shows the tooltip explaining the cost.

- [ ] **Step 4: Commit**

```bash
git add electron/renderer/src/views/WeeklyView.tsx
git commit -m "feat(weekly): show cost signal on Regenerate before it's clicked"
```

---

## Self-Review

**Spec coverage:** Idea #9 had two parts — "does Weekly share the same reasoning-model risk as extract" (yes, partially — Task 1 closes the gap) and "show cost signal before Regenerate" (Task 2). Both covered.

**Placeholder scan:** No TBD/TODO; all code is complete and runnable.

**Type consistency:** Task 2 references `structured?.hasFreshCache`, matching the `WeeklyStructured` interface's existing `hasFreshCache: boolean` field (confirmed in `WeeklyView.tsx:68`) — no new type introduced, no rename risk.

**Note on scope:** Investigation found `maxTokens` (16000) and `disableThinking` were already correct for Weekly — only the system-prompt preamble guard was missing. This plan does not touch `maxTokens` or `disableThinking`, since both are already right; touching them would be an unnecessary, unjustified change.
