# Action-Item Provenance — Design

**Date:** 2026-07-01
**Status:** Proposed

## Problem

Action items are extracted by an LLM from `summary.md` (not the raw transcript) and
persisted as `{ text, owner, due_date }` rows. There is NO stored link from an action
item back to the summary bullet or transcript region it came from. Users running a
small local model (~12B via LM Studio) can't trust the list without cross-checking:
"did the model drop a commitment?", "where did *this* item come from — is it real?".
Answering that today means re-reading the whole summary (and often the transcript) by
hand. Provenance lets a user audit the extraction chain by clicking one item.

The extract stage (`electron/main/pipeline/stages/extracting.ts`) reads `summary.md`,
calls `ctx.lmStudio.chat` with `ACTION_ITEM_SYSTEM_PROMPT`, parses the JSON with
`parseActionItemsLoose`, writes `action-items.json`, and calls
`ctx.actionItems.replaceForMeeting(meetingId, items)`. The model returns only
`{ text, owner, due_date }` — no source pointer exists to persist.

## Goal

Clicking an action item in the UI reveals WHERE it came from: switch to the Summary
tab and highlight the matching `## Action Items` bullet, scrolling it into view. The
summary already links to the transcript through the reader's own eyes (and the
transcript tab's click-to-seek), so summary-bullet highlight is the primary
deliverable; transcript is reachable one hop further and out of scope for v1.

## Decision — how to establish the mapping

We must attach a `source_quote` (a verbatim snippet from `summary.md`) to each action
item. Three ways to get one were considered:

- **(a) LLM emits `source_quote`.** Extend the schema/prompt so the model, alongside
  each item, returns the exact summary text it based the item on. Exact by
  construction — the pointer is whatever the model actually read.
- **(b) Post-hoc fuzzy match in code.** Keep the model unchanged; after parsing, match
  each item's `text` against the summary's `## Action Items` bullets in TypeScript
  (normalize + token-overlap / longest-common-substring), pick the best bullet over a
  threshold. Cheap, no model risk, but approximate.
- **(c) Match against transcript lines directly.** Same as (b) but against
  `transcript.md`. Rejected outright: the item text is a *paraphrase of the summary*,
  which is itself a paraphrase of the transcript — two hops of rewording make
  transcript matching the least reliable, and extract no longer even reads the
  transcript.

### Recommendation: (b) post-hoc fuzzy match, with the LLM path (a) explicitly rejected for now

**Rejecting (a) — model reliability.** This app targets 12B-class models that already
struggle with the *existing* strict-JSON extract task: reasoning models burn their
token budget "thinking" (the whole reason extract was just moved off the transcript
onto the smaller summary — see `2026-07-01-extract-from-summary-design.md`). Adding a
required per-item `source_quote` string makes the JSON larger, invites the model to
paraphrase rather than quote verbatim (a non-verbatim "quote" is useless for matching
and worse than none), and adds a new failure mode: a well-formed item with a bad
quote. `parseActionItemsLoose` would have to drop or repair those, which is exactly the
approximate matching of (b) — but now also paying the model-reliability tax. The prompt
change also risks regressing the precision rules we just tuned.

**Choosing (b) — the match target is small and structured.** The key insight: extract
reads `summary.md`, and the summary's `## Action Items` section is a short list of `-`
bullets, each of which the model turned into one item. So the search space per item is
~5–30 short bullets, not thousands of transcript lines. An item's `text` is a light
rewording of its source bullet (same owner name, same due date, same nouns), so
normalized token-overlap scoring lands the right bullet reliably. It costs one extra
LLM-free pass in the same stage, is fully unit-testable with deterministic fixtures,
and degrades gracefully: no bullet clears the threshold → store `source_quote = null`,
and the UI simply doesn't offer a jump for that item (no wrong jumps, no crashes).

**Escalation path preserved.** `source_quote` is stored as plain nullable text. If real
usage shows fuzzy matching missing too often, approach (a) can later populate the *same*
column from the model, with (b) as the fallback when the model's quote doesn't verify
against the summary — no schema change needed to switch. This spec ships the low-risk
half of that design.

## Changes

### 1. New nullable column: `action_items.source_quote`

Add a migration (version 12) that runs `ALTER TABLE action_items ADD COLUMN
source_quote TEXT;`. Nullable, no default → existing rows read back `null`, exactly the
"unknown provenance" state the UI already has to handle for hand-added items. Matches
the repo's migration style (each `MIGRATIONS` entry is a bare `ALTER TABLE … ADD
COLUMN`; see versions 8/10 for `owner_name`/`error_message`).

### 2. Persist `source_quote` through the repo

`ActionItemsRepo` learns to read/write the new column:

- `ActionItemRow` gains `sourceQuote: string | null`; `row()` maps
  `source_quote → sourceQuote`.
- `replaceForMeeting` accepts items carrying an optional `sourceQuote` and inserts it
  (the extract stage is the only writer that populates it).
- `create`/`update` leave it untouched (hand-added items have no source; that's `null`,
  the same as an unmatched extracted item — the UI treats both identically).

### 3. Matcher module: `electron/main/lib/action-item-source.ts`

A pure, LLM-free function:

```
matchSourceQuotes(items: ActionItem[], summaryMd: string): (ActionItem & { sourceQuote: string | null })[]
```

- Slice the `## Action Items` section out of `summaryMd` (from the heading to the next
  `## ` or EOF), split into `-`/`*` bullets, strip the marker + a leading bold label.
- For each item, score every bullet by normalized token-set overlap (lowercase, strip
  punctuation, drop a small stopword set) and keep the best if it clears a threshold
  (Jaccard ≥ 0.5). Ties / no clear winner → `null`.
- Falls back to scanning the whole summary's bullets if there's no `## Action Items`
  section (some summaries fold commitments into Decisions/Follow-ups — the extract
  prompt already pulls from there).
- Returns the *verbatim* bullet text (original casing/punctuation) as `sourceQuote`, so
  the renderer can string-match it against the rendered summary. Pure function, no IO —
  same testability posture as `transcript-lines.ts`.

### 4. Extract stage wires the matcher in

`runExtracting` already has both `items` (parsed) and `summary` (the file it read). It
calls `matchSourceQuotes(items, summary)` and passes the enriched items to both
`action-items.json` and `ctx.actionItems.replaceForMeeting`. No new LLM call, no new IO
read — the summary is already in memory.

### 5. IPC surfaces `sourceQuote`

`meetings:get` (`handlers.ts`) maps `ai.sourceQuote` into each `actionItems[]` entry.
The renderer's `MeetingDetail['actionItems'][number]` type gains `sourceQuote: string |
null`.

### 6. Renderer: click an item → highlight its source bullet

- `MeetingDetailView` lifts a `provenanceTarget` state (the `sourceQuote` string to
  highlight) alongside the existing `tab` state, plus a nonce so re-clicking the same
  item re-triggers the scroll.
- `ActionItemDisplay` gets an optional "Show source" affordance (a small ↦ button on
  the row, shown only when `item.sourceQuote` is non-null). Clicking it sets `tab =
  'summary'` and `provenanceTarget = item.sourceQuote`, mirroring how the palette jump
  already sets `tab = 'transcript'` + `seekSeconds`.
- `SummaryPanel` / `MarkdownPreview` receive the target. After render, find the DOM
  node whose text contains the target quote (normalized compare over rendered `<li>` /
  `<p>` nodes), add a transient highlight class, and `scrollIntoView({ block:
  'center' })` — the same highlight+scroll pattern the transcript's active-line code
  uses. The highlight fades after a few seconds (matches the transcript active-line
  ring's transient feel). Items with `sourceQuote === null` show no affordance, so
  there's no dead click.

## What does not change

The `ActionItem` zod schema and `parseActionItemsLoose` (the model still returns only
`{ text, owner, due_date }`), `ACTION_ITEM_SYSTEM_PROMPT`, the summarize stage, the
failure banner / recovery, and the action-item edit/add/delete flow. No new LLM call is
introduced anywhere.

## Accepted trade-offs

- **Approximate, not exact.** A heavily reworded bullet or a merged/split item may not
  match; that item shows no "Show source" button rather than a wrong one. Silent
  no-match is the safe failure — the user is no worse off than today, and the item is
  still fully editable.
- **Summary-only, not transcript.** v1 highlights the summary bullet. Reaching the
  transcript region is left to the user (Transcript tab + click-to-seek) and a possible
  v2 that chains bullet → transcript line via the same fuzzy approach.
- **Highlight is DOM-text-based.** Matching rendered markdown by text (rather than
  injecting anchors during extract) keeps the summary on disk clean and editable, at
  the cost of a best-effort DOM search. If the user has edited the summary so the bullet
  no longer exists, the jump lands the user on the Summary tab with no highlight — an
  acceptable degradation.

## Testing strategy

Unit tests (vitest), matching existing patterns:

- `action-item-source.test.ts`: exact-bullet match, reworded-but-matchable bullet,
  below-threshold → `null`, missing `## Action Items` section falls back to whole-summary
  bullets, empty summary → all `null`. Pure function, deterministic fixtures.
- `extracting.test.ts`: assert the enriched items reaching `replaceForMeeting` and
  `action-items.json` carry `sourceQuote` for a summary whose bullet matches, and
  `null` for an invented item that matches nothing.
- `action-items-repo.test.ts`: round-trip `sourceQuote` through `replaceForMeeting` +
  `listByMeeting`; assert `create` yields `sourceQuote: null`.
- Migration: an existing `db.test.ts`-style assertion that `source_quote` exists after
  migrate and old rows read back `null`.

Manual verification: process a real meeting, open Actions, click "Show source" on an
item, confirm the Summary tab opens with the right bullet highlighted and scrolled into
view; confirm a hand-added item shows no button.

## Open design decisions (please confirm)

1. **Threshold + scoring.** Jaccard ≥ 0.5 on token sets is a starting point; do you want
   a stricter/looser default, or a longest-common-substring tiebreak? (Affects how often
   the button appears vs. how often it's wrong.)
2. **Affordance placement.** A dedicated "Show source" ↦ button on the action row, vs.
   making the whole row's click open source (the row click currently opens the inline
   editor for #44). Recommend the dedicated button to avoid overloading the existing
   click. Confirm.
3. **Transcript hop.** Confirm v1 stops at the summary bullet (recommended) rather than
   also trying to chain to a transcript line.
4. **Migration number.** Plan assumes the next free version is **12** (current head is
   11). Confirm no other in-flight branch has claimed 12.
