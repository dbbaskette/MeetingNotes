# Off-topic Conversation Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect opening/closing small talk in a meeting and corral it into a brief `## Off-topic Conversation` section at the end of the notes, instead of letting it leak into the main bullets.

**Architecture:** Two prompt-level changes plus minimal wiring. `buildSummaryPrompt` gains a `knownTopic` parameter (injects either an "about: X" anchor or an "infer from transcript" instruction) and emits a new optional `## Off-topic Conversation` section with a precise content rule. The summarizing stage derives `knownTopic` from the existing `DEFAULT_TITLE_PATTERN` (real title → anchor, `recording-…` filename → infer) and adds the new heading to the H1→H2 post-processing normalization.

**Tech Stack:** TypeScript, Electron main process, Vitest. Local LLM via LM Studio (mocked in tests).

---

## File Structure

- `electron/main/pipeline/prompts.ts` — MODIFY `buildSummaryPrompt` (add `knownTopic` param, topic line, off-topic section + rule).
- `electron/main/pipeline/prompts.test.ts` — CREATE (new unit tests for `buildSummaryPrompt`; no test file exists for this module yet).
- `electron/main/pipeline/stages/summarizing.ts` — MODIFY to derive `knownTopic` and pass it; add the new heading to the post-processing regex.
- `electron/main/pipeline/stages/summarizing.test.ts` — MODIFY to add topic-anchor and heading-normalization tests.

---

## Task 1: `buildSummaryPrompt` — known-topic anchor + Off-topic Conversation section

**Files:**
- Modify: `electron/main/pipeline/prompts.ts:43-70`
- Test: `electron/main/pipeline/prompts.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `electron/main/pipeline/prompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSummaryPrompt } from './prompts.js';

describe('buildSummaryPrompt', () => {
  it('includes the Off-topic Conversation section and its content rule', () => {
    const p = buildSummaryPrompt('detailed');
    expect(p).toContain('## Off-topic Conversation');
    expect(p).toContain('OPENS or CLOSES');
    expect(p).toContain('Omit this section entirely if there was no such chatter.');
  });

  it('anchors on the known topic when one is given', () => {
    const p = buildSummaryPrompt('detailed', 'Q3 roadmap planning');
    expect(p).toContain('This meeting is about: **Q3 roadmap planning**');
    expect(p).not.toContain('Infer the meeting');
  });

  it('falls back to inferring the topic when none is given', () => {
    const p = buildSummaryPrompt('detailed');
    expect(p).toContain("Infer the meeting's main purpose from the transcript itself.");
    expect(p).not.toContain('This meeting is about:');
  });

  it('treats null knownTopic the same as omitted (infer)', () => {
    const p = buildSummaryPrompt('detailed', null);
    expect(p).toContain("Infer the meeting's main purpose from the transcript itself.");
    expect(p).not.toContain('This meeting is about:');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/main/pipeline/prompts.test.ts`
Expected: FAIL — current prompt has no `## Off-topic Conversation`, no topic line, and `buildSummaryPrompt` ignores a second argument.

- [ ] **Step 3: Implement the changes in `prompts.ts`**

Replace the entire `buildSummaryPrompt` function (`electron/main/pipeline/prompts.ts:40-70`) with:

```ts
/** Build the summarization system prompt for a given detail level. Everything
 *  except the goal line, the topic anchor, and the Length & depth block is
 *  constant across levels — sections, formatting, and faithfulness rules don't
 *  change with verbosity.
 *
 *  `knownTopic` is the meeting's real (user-set or previously-derived) title,
 *  used to anchor what counts as on-topic. Pass `null`/omit it when the title is
 *  still an auto-generated `recording-…` filename — the model then infers the
 *  purpose from the transcript instead. */
export function buildSummaryPrompt(
  detail: SummaryDetail = 'detailed',
  knownTopic?: string | null,
): string {
  const topicLine = knownTopic
    ? `This meeting is about: **${knownTopic}**. Use that as the anchor for what's on-topic.`
    : `Infer the meeting's main purpose from the transcript itself.`;
  return `You are a meeting-notes assistant for a professional setting. ${GOAL_LINE[detail]}

${topicLine}

Given the speaker-labeled transcript of a business meeting, produce a self-contained summary in GitHub-flavored Markdown that a reader who didn't attend can use as a complete substitute for the meeting.

Use these sections as relevant — SKIP any section that has nothing substantive:
## Overview
## Key Discussion Points
## Decisions
## Action Items
## Follow-ups
## Open Questions
## Off-topic Conversation

${LENGTH_GUIDANCE[detail]}

Formatting rules (strict — the output will be rendered directly):
- Start the first line with "## Overview". No preamble, no blank leading lines, no title, no closing remarks.
- Use "##" for section headings (never "#"). "###" is okay for sub-topics inside a section.
- Bullet lists use "-" (hyphen + space), not "*" or "•".
- Bold a short label at the start of a bullet when it helps scanning, e.g. "- **Security story:** …".
- Sentences inside bullets are fine. Full paragraphs inside a section are also fine when the topic warrants it.
- Separate sections with one blank line.

Content rules:
- Be concrete. Name people, systems, numbers where the transcript supports them.
- Action Items must have owner and due date if the transcript gives them; otherwise write "(owner TBD)" or "(no date)".
- Off-topic Conversation: capture only the social/personal small talk that OPENS or CLOSES the meeting and is unrelated to the meeting's purpose (greetings, weekend plans, weather, sign-offs). List it as 1–3 short bullets naming the topics — do not summarize it in depth. Do NOT pull tangents from the middle of the meeting here; those belong in the main sections. Omit this section entirely if there was no such chatter.
- Do NOT invent attendees, decisions, commitments, or details the transcript does not support. Faithfulness to the transcript beats producing a polished-sounding summary.`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run electron/main/pipeline/prompts.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/pipeline/prompts.ts electron/main/pipeline/prompts.test.ts
git commit -m "feat(summary): add Off-topic Conversation section and topic anchor to prompt"
```

---

## Task 2: Wire `knownTopic` through the summarizing stage + normalize the new heading

**Files:**
- Modify: `electron/main/pipeline/stages/summarizing.ts:53-72`
- Test: `electron/main/pipeline/stages/summarizing.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these three tests inside the existing `describe('runSummarizing', …)` block in `electron/main/pipeline/stages/summarizing.test.ts` (before its closing `});`):

```ts
  it('passes the meeting title to the prompt as the known topic', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-s-topic-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.md'), '[SPEAKER_00 00:00] Hi.');

    const chat = vi.fn(async () => '## Overview\nshort meeting.');
    const ctx: any = {
      libraryRoot: dir,
      llmSupervisor: { ensureReady: async () => {} },
      lmStudio: { chat },
      meetings: { findById: () => ({ slug: 'slug', title: 'Team sync' }), updateTitle: vi.fn() },
      settings: { get: (k: string) => (k === 'llmModel' ? 'llama-3.1-8b' : 'detailed') },
      logger: { info: () => {} },
    };
    await runSummarizing({ meetingId: 'm' }, ctx);
    const systemMsg = chat.mock.calls[0][0].messages[0].content as string;
    expect(systemMsg).toContain('This meeting is about: **Team sync**');
  });

  it('omits the topic anchor for default recording-... titles', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-s-noanchor-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.md'), '[SPEAKER_00 00:00] Hi.');

    const chat = vi.fn(async () => '## Overview\nshort meeting.');
    const ctx: any = {
      libraryRoot: dir,
      llmSupervisor: { ensureReady: async () => {} },
      lmStudio: { chat },
      meetings: {
        findById: () => ({ slug: 'slug', title: 'recording-20260421-163203-47c0c0f5' }),
        updateTitle: vi.fn(),
      },
      settings: { get: (k: string) => (k === 'llmModel' ? 'llama-3.1-8b' : 'detailed') },
      logger: { info: () => {} },
    };
    await runSummarizing({ meetingId: 'm' }, ctx);
    const systemMsg = chat.mock.calls[0][0].messages[0].content as string;
    expect(systemMsg).toContain("Infer the meeting's main purpose");
    expect(systemMsg).not.toContain('This meeting is about:');
  });

  it('demotes a stray "# Off-topic Conversation" H1 to H2', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-s-h1-'));
    const f = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.md'), '[SPEAKER_00 00:00] Hi.');

    const chat = vi.fn(async () => '## Overview\nx.\n\n# Off-topic Conversation\n- Weekend plans.');
    const ctx: any = {
      libraryRoot: dir,
      llmSupervisor: { ensureReady: async () => {} },
      lmStudio: { chat },
      meetings: { findById: () => ({ slug: 'slug', title: 'Team sync' }), updateTitle: vi.fn() },
      settings: { get: (k: string) => (k === 'llmModel' ? 'llama-3.1-8b' : 'detailed') },
      logger: { info: () => {} },
    };
    await runSummarizing({ meetingId: 'm' }, ctx);
    const out = fs.readFileSync(path.join(f, 'summary.md'), 'utf8');
    expect(out).toContain('## Off-topic Conversation');
    expect(out).not.toMatch(/^# Off-topic Conversation/m);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/main/pipeline/stages/summarizing.test.ts`
Expected: FAIL — the prompt currently receives no topic argument (no "This meeting is about" / "Infer the meeting's main purpose" text), and the post-processing regex does not demote `# Off-topic Conversation`.

- [ ] **Step 3: Derive and pass `knownTopic` in `summarizing.ts`**

In `electron/main/pipeline/stages/summarizing.ts`, replace the chat call block (`electron/main/pipeline/stages/summarizing.ts:53-60`):

```ts
  const content = await ctx.lmStudio.chat({
    model: ctx.settings.get('llmModel'),
    temperature: 0.2,
    messages: [
      { role: 'system', content: buildSummaryPrompt(ctx.settings.get('summaryDetail')) },
      { role: 'user', content: transcript },
    ],
  });
```

with:

```ts
  // Anchor off-topic detection on the meeting's real title. A still-default
  // `recording-…` filename tells us nothing, so fall back to letting the model
  // infer the purpose from the transcript.
  const knownTopic = DEFAULT_TITLE_PATTERN.test(meeting.title) ? null : meeting.title;
  const content = await ctx.lmStudio.chat({
    model: ctx.settings.get('llmModel'),
    temperature: 0.2,
    messages: [
      { role: 'system', content: buildSummaryPrompt(ctx.settings.get('summaryDetail'), knownTopic) },
      { role: 'user', content: transcript },
    ],
  });
```

- [ ] **Step 4: Add the new heading to the post-processing regex**

In the same file, update the H1→H2 demotion line (`electron/main/pipeline/stages/summarizing.ts:70`):

```ts
    .replace(/^# (Overview|Key Discussion Points|Decisions|Action Items|Follow-ups|Open Questions)\b/gm, '## $1')
```

to:

```ts
    .replace(/^# (Overview|Key Discussion Points|Decisions|Action Items|Follow-ups|Open Questions|Off-topic Conversation)\b/gm, '## $1')
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run electron/main/pipeline/stages/summarizing.test.ts`
Expected: PASS (all tests in the file, including the 3 new ones).

- [ ] **Step 6: Run the full pipeline test suite for regressions**

Run: `npx vitest run electron/main/pipeline`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add electron/main/pipeline/stages/summarizing.ts electron/main/pipeline/stages/summarizing.test.ts
git commit -m "feat(summary): anchor off-topic detection on meeting title; normalize new heading"
```

---

## Self-Review Notes

- **Spec coverage:** Section content (brief mention) + scope (opening/closing only) → Task 1 prompt rule. Topic anchor "both" → Task 1 `knownTopic` param + Task 2 `DEFAULT_TITLE_PATTERN` derivation. Optional section (skip rule) → covered by existing "SKIP any section" line plus the new "Omit this section entirely…" rule. Heading normalization → Task 2 Step 4. Action-item prompt unchanged → no task, as specified.
- **Type consistency:** `buildSummaryPrompt(detail, knownTopic)` signature is identical in Task 1 (definition) and Task 2 (call site). `DEFAULT_TITLE_PATTERN` is the existing constant in `summarizing.ts`, already in scope.
- **No placeholders:** every code/test block is complete.
