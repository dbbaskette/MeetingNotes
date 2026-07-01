# Extract Action Items from the Summary — Design

**Date:** 2026-07-01
**Status:** Approved

## Problem

The extract stage sends the **full transcript** (10k–50k+ tokens) to the LLM with a
strict JSON prompt — a second heavyweight call right after summarize already digested
the same transcript. On the small local models this app targets (~12B on a laptop via
LM Studio), reasoning-capable models (Gemma 4, Qwen3, …) routinely burn their entire
8000-token budget on chain-of-thought against that huge input and produce no output,
failing the stage with the "spent its entire token budget thinking" error. The
"Disable model thinking" toggle (`chat_template_kwargs: { enable_thinking: false }`)
is ignored by some of these models (notably Gemma 4), so prompt-level mitigation
loses against a transcript-sized input.

Meanwhile the summary prompt already requires an `## Action Items` section with owner
and due date — a distilled version of the answer exists in `summary.md` before
extract ever runs.

All prior work on this bug class (reasoning-model badges, failure-banner recovery
controls, health-check canary) is mitigation. This change removes the root cause:
extract should not re-process the full transcript.

## Decision

Extract runs the same JSON extraction prompt over **`summary.md`** (1–3k tokens)
instead of `transcript.md`. No transcript fallback. To keep quality, the summary
prompt's Action Items section is tightened so it errs toward **recall** (catch every
commitment); the extract prompt keeps its strict **precision** rules (prune
non-items). That division of labor replaces the single do-everything transcript pass.

### Considered alternatives

- **Rule-based parse of the summary's Action Items section (no second LLM call):**
  immune to loops, but depends on small models following an exact bullet format, and
  loses fuzzy owner/date normalization. Rejected.
- **Summary-first with transcript fallback:** most thorough, but keeps the risky
  path alive and adds a branch to maintain/test. Rejected — explicitly no fallback.

## Changes

### 1. `electron/main/pipeline/stages/extracting.ts` — input swap

- Read `summary.md` from the meeting folder instead of `transcript.md`.
- If `summary.md` is missing or empty, throw a clear error (e.g. "summary.md is
  missing or empty — re-run processing so the summarize stage regenerates it")
  rather than silently falling back to the transcript. The stage machine
  (`summarizing → extracting`) guarantees the file exists in normal operation.
- Lower `maxTokens` from 8000 to **2000**: input is now 1–3k tokens, output is a
  short JSON array (~50 items fit comfortably), and a model that still loops now
  fails in tens of seconds instead of minutes. The existing looping-detection error
  in `lm-studio/client.ts` is unchanged and still catches that case.

### 2. `electron/main/pipeline/prompts.ts` — extract prompt rewording

`ACTION_ITEM_SYSTEM_PROMPT` changes from "from the meeting transcript" to "from the
meeting notes below", plus:

- The notes contain an `## Action Items` section — treat it as the primary source,
  but also pick up committed tasks that appear only under Decisions or Follow-ups.
- Map the notes' conventions to the schema: "(owner TBD)" → `owner: null`,
  "(no date)" → `due_date: null`.
- All existing precision rules stay verbatim (what is NOT an action item; "when in
  doubt, OMIT"; the no-preamble / answer-immediately framing; the JSON shape
  `{ "text": string, "owner": string | null, "due_date": "YYYY-MM-DD" | null }`).

### 3. `electron/main/pipeline/prompts.ts` — summary prompt Action Items tightening

The Action Items content rule in `buildSummaryPrompt` becomes recall-oriented, since
extract now depends on it:

- Sweep the ENTIRE transcript for commitments — action items are often stated
  mid-discussion or in the closing minutes, not only in a wrap-up recap.
- One bullet per item, each naming the task, the owner (or "(owner TBD)"), and the
  due date (or "(no date)").
- The Action Items section is exempt from the brevity guidance: even at the
  `concise` detail level, include every genuine commitment, however small. Missing
  a real action item is worse than an extra bullet here.

This applies at all three detail levels (the rule lives in the constant content-rules
block, not the per-level Length & depth block).

### 4. `electron/main/ipc/handlers.ts` — health-check canary alignment

The `llm:health-check-model` canary currently sends a two-line fake transcript with
`ACTION_ITEM_SYSTEM_PROMPT`. Its input becomes a tiny summary-shaped snippet (a mini
`## Action Items` section with one or two bullets) so the health check keeps testing
the exact task shape extract really runs.

### 5. Tests

- `extracting.test.ts`: fixtures switch to writing/reading `summary.md`; new case
  asserting the clear error when `summary.md` is missing or empty; assert the
  lowered `maxTokens` reaches the client call.
- `prompts.test.ts`: update any assertions on the extract prompt wording; add
  assertions that the summary prompt contains the new Action Items recall rules at
  every detail level.

## What does not change

`parseActionItemsLoose` and the action-item schema, the failure banner and its
recovery controls, pipeline retry/recovery, the summarize stage's flow and
post-processing, and the reasoning-model badges in Settings.

## Accepted trade-off

Action items are now bounded by summary quality: if the summary drops a commitment,
extract cannot recover it from the transcript. The recall-oriented summary rules
(§3) are the counterweight. If summarize itself loops, that is the same failure that
exists today, surfaced one stage earlier.

## Error handling

- Missing/empty `summary.md` → stage fails with an actionable message (see §1);
  the normal pipeline failure/retry UI applies.
- Model loops anyway → same `LMStudioError` path as today, but bounded at 2000
  tokens, so it surfaces fast and the existing failure-banner recovery controls
  (model picker + thinking toggle) appear as before.

## Testing strategy

Unit tests as in §5 (vitest, mocked LM Studio client — same pattern the stage tests
already use). Manual verification: process a real meeting with `google/gemma-4-12b`
in LM Studio and confirm extract completes; compare the resulting action-items list
against the summary's Action Items section.
