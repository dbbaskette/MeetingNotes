# Off-topic Conversation Section — Design

**Date:** 2026-06-02
**Status:** Approved, pending implementation plan

## Problem

Meetings often open with social small talk (greetings, weekend plans, weather)
and close with sign-off chit-chat. The summarizer currently has nowhere to put
this, so it sometimes surfaces as the *first bullet point* of the main notes —
giving unimportant chatter the most prominent position. We know what a meeting
is broadly about, so we should be able to recognize this off-topic conversation
and move it out of the main notes.

## Goal

Detect opening and closing small talk and corral it into a brief, clearly
labeled section at the **end** of the notes (`## Off-topic Conversation`),
keeping the main sections focused on the actual meeting.

## Behavior

- **Section content:** brief mention only — 1–3 short bullets naming the topics
  (e.g. `- Weekend plans and weather`). Not a full summary of the chatter.
- **Scope:** opening small talk and closing chit-chat **only**. Mid-meeting
  tangents are *not* pulled here — they stay in the main sections, because they
  are riskier to misclassify and may be relevant.
- **Topic anchor ("both"):** the meeting's title is passed to the model as the
  known topic when it is a real title; otherwise the model infers the meeting's
  purpose from the transcript itself.
- **Optional:** the section appears only when there is substantive off-topic
  chatter, consistent with the existing "SKIP any section that has nothing
  substantive" rule. A meeting that gets straight to business shows no such
  section.

## Changes

### 1. `buildSummaryPrompt` gains a `knownTopic` parameter

**File:** `electron/main/pipeline/prompts.ts`

New signature:

```ts
buildSummaryPrompt(detail: SummaryDetail = 'detailed', knownTopic?: string | null)
```

- When `knownTopic` is provided, inject a line near the top:
  *"This meeting is about: **{knownTopic}**. Use that as the anchor for what's
  on-topic."*
- When absent, inject: *"Infer the meeting's main purpose from the transcript
  itself."*
- Add `## Off-topic Conversation` as the **last** entry in the section list
  (after `## Open Questions`).
- Add a content rule describing the section precisely:
  > Off-topic Conversation: capture only the social/personal small talk that
  > **opens or closes** the meeting and is unrelated to the meeting's purpose
  > (greetings, weekend plans, weather, sign-offs). List it as 1–3 short bullets
  > naming the topics — do not summarize it in depth. Do NOT pull tangents from
  > the middle of the meeting here; those belong in the main sections. Omit this
  > section entirely if there was no such chatter.

Everything else in the prompt (goal line, length guidance, formatting rules,
faithfulness rules) is unchanged.

### 2. Pass the title from the summarizing stage

**File:** `electron/main/pipeline/stages/summarizing.ts`

Derive the known topic from the existing `DEFAULT_TITLE_PATTERN` (which already
distinguishes auto-generated `recording-…` filenames from real/derived titles):

```ts
const knownTopic = DEFAULT_TITLE_PATTERN.test(meeting.title) ? null : meeting.title;
// ...
{ role: 'system', content: buildSummaryPrompt(ctx.settings.get('summaryDetail'), knownTopic) },
```

A real user title (or a previously-derived title) anchors the judgment; a raw
filename falls back to inference. No new state is introduced.

### 3. Post-processing normalizes the new heading

**File:** `electron/main/pipeline/stages/summarizing.ts`

Add `Off-topic Conversation` to the H1→H2 demotion alternation
(`.replace(/^# (Overview|...)\b/gm, '## $1')`) so a stray `# Off-topic
Conversation` is normalized like the other headings.

## Out of scope / unchanged

- **Action Items extraction** (`ACTION_ITEM_SYSTEM_PROMPT`) — small talk produces
  no action items, so it needs no change.
- The summary detail-level system, settings storage, and Settings UI — untouched.
  This is always-on behavior with no new user setting.

## Testing

- Unit-test `buildSummaryPrompt`:
  - asserts the `## Off-topic Conversation` section and its content rule are
    present.
  - asserts the topic line switches between the "about: X" variant (when
    `knownTopic` is given) and the "infer from transcript" variant (when not).
- Unit-test the `knownTopic` derivation in the summarizing stage: a
  default-pattern title yields `null`; a real title is passed through.
- Follow the repo's existing Vitest conventions.
