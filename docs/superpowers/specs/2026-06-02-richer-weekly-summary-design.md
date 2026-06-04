# Richer Weekly Summary — Design

**Date:** 2026-06-02
**Status:** Approved (brainstormed)

## Problem

The weekly summary "isn't super useful." Today it produces a short
200–350 word narrative (theme → follow-ups → next week), 3–6 decision
strings, a meetings table, and action items grouped by owner. For the
user's primary use — **catching up / recall** (reconstructing what
actually happened across the week) — it's too shallow: a 3-paragraph
overview can't carry the substance of a week, and the per-meeting
"highlight" is just the first sentence of each summary.

## Goal

Add depth aimed at recall, without paying to regenerate content that
already exists per meeting:

1. **Themes / threads** *(new)* — 3–6 topic threads synthesized across the
   week, each with a substantive paragraph (what was discussed, where it
   landed, what's open) and a back-reference to the source meetings. This
   is the connective tissue a weekly view can provide that clicking into
   individual meetings cannot.
2. **Richer per-meeting recaps** — upgrade the in-list highlight from "first
   sentence" to "the Overview paragraph (~3 sentences)", extracted
   deterministically from each `summary.md`. No LLM cost; full summary stays
   a click away.

Non-goals (YAGNI): full LLM-generated per-meeting recaps (redundant with
each meeting's own `summary.md`); risks/wins/blockers sections (that's
status-reporting, not recall); a second LLM call.

## Design

### 1. Themes via the existing single LLM call

The narrative generator already receives every meeting's full
`summary.md`. Extend its JSON contract from `{narrative, decisions}` to
`{narrative, themes, decisions}` — no extra round-trip.

- New type `WeeklyTheme { title: string; detail: string; meetings: string[] }`
  where `meetings` lists source meeting titles for traceability.
- `prompt.ts`:
  - `SYSTEM_PROMPT` rewritten to request the overview narrative, then a
    `themes` array (3–6 items; each `title`, a 2–4 sentence `detail`, and a
    `meetings` array of the source meeting titles it draws from), then the
    existing `decisions`. Instruction: only use source titles that appear
    in the input; don't invent threads.
  - `parseNarrativeResponse` extended to parse + validate `themes`: drop
    entries missing a title or detail; coerce `meetings` to a string array
    (default `[]`); cap detail length defensively. `narrative` empty still
    throws; missing/empty `themes` is tolerated (→ `[]`) so a model that
    ignores the field doesn't fail the whole call.
  - `createNarrativeGenerator` sets a generous `max_tokens` on the chat
    call so the larger JSON isn't truncated (verify the LMStudioClient.chat
    signature supports it; if not, add it).
- `NarrativeOutput` gains `themes: WeeklyTheme[]`.

### 2. Deterministic per-meeting recap

`aggregator.ts buildWeeklyMeeting` currently extracts the first sentence of
the Overview. Replace that logic with a small pure helper
`extractOverviewRecap(summaryMd, maxSentences = 3, maxChars = 320)`:

- Find the `## Overview` section; take its first paragraph; return up to
  `maxSentences` sentences, capped at `maxChars`.
- Fallbacks: no `## Overview` heading → first non-heading paragraph; no
  paragraphs → null.
- Lives in a new `electron/main/weekly/recap.ts` (pure, unit-tested).

`WeeklyMeeting.highlight` keeps its name (so the renderer/contract don't
churn) but now holds the multi-sentence recap.

### 3. Storage & caching

- Migration 11: `ALTER TABLE weekly_summaries ADD COLUMN themes_json TEXT
  NOT NULL DEFAULT '[]'`.
- `WeeklySummaryRow`/`WeeklySummaryUpsert` gain `themes: WeeklyTheme[]`;
  repo serializes to `themes_json`, parses on read.
- `input_hash` invalidation unchanged (still meetings id+updatedAt). The
  per-meeting recap is on the deterministic fast path and isn't cached, so
  it always reflects the current `summary.md`.

### 4. Aggregator wiring

- `regenerate` threads `out.themes` into the upsert and return value.
- `WeeklyNarrative` (slow path) and `WeeklyData` gain `themes: WeeklyTheme[]`.
- `getOrGenerateNarrative` cache-hit branch returns `cached.themes`;
  empty-week / in-progress branches return `themes: []`.

### 5. Surfaces

- **Renderer (`WeeklyView.tsx`):** a new **Themes** card rendered directly
  under the Overview narrative card (most prominent — it's the recall
  payload). Each theme: bold title, the detail paragraph, and source-meeting
  chips (clickable → open that meeting, matched by title to the structured
  meetings list; non-matching titles render as plain text). Themes live in
  the narrative payload, so the card shows only once `narrState === 'ready'`
  (same gating as decisions). The meetings list already renders
  `m.highlight`; it now shows the longer recap (widen/wrap as needed).
- **Markdown export (`markdown.ts`):** new `## Themes` section after
  Overview — each theme as `### <title>` + detail + an italic
  *(from: meeting a, meeting b)* line. Meetings rendered as a list (title +
  recap) instead of a bare table row, so the recap is included.

### 6. Tests

- `recap.test.ts` *(new)*: Overview extraction — heading present, multiple
  paragraphs, no heading fallback, sentence/char caps, empty input.
- `prompt.test.ts`: themes parsing (valid, missing fields dropped, missing
  `themes` → `[]`, `meetings` coercion); new prompt assembly includes the
  themes instruction.
- `aggregator.test.ts`: recap flows into `WeeklyMeeting.highlight`; themes
  round-trip through cache (upsert → get); cache-hit returns themes.
- `markdown.test.ts`: `## Themes` section renders with source line; meeting
  recaps appear; section omitted when no themes.
- `weekly-summaries-repo` coverage for `themes_json` round-trip (in the
  aggregator or a repo test).

## Risks

- **Bigger prompt/response** could hit context/output limits on small local
  models. Mitigations: generous `max_tokens`; `themes` parsing is tolerant
  (a model that drops the field degrades to today's behavior, not an error).
- **Source-meeting matching** is by title string; duplicate or renamed
  titles may not link. Acceptable — chips fall back to plain text, and the
  detail is still readable.
- Migration adds a NOT NULL column with a default, so existing cached rows
  upgrade cleanly (themes show empty until the next regeneration).
