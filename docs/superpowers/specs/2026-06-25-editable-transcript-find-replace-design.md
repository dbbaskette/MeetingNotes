# Design: Editable transcript, summary staleness, and find/replace

**Date:** 2026-06-25
**Status:** Approved (pending spec review)
**Area:** `electron/renderer` (Meeting detail view) + `electron/main` (IPC, detail assembly)

## Motivation

Whisper occasionally mishears a word or a name and repeats the mistake throughout a
transcript. Today the user can edit the **summary** but not the **transcript**, and there
is no way to fix a recurring mis-transcription in bulk. This adds:

1. An **editable transcript** (mirroring the existing summary editor).
2. A **find-and-replace** tool available in both editors — the fast path for "this name is
   wrong in 12 places."
3. A **staleness signal**: once the transcript is edited, the summary it was derived from is
   marked out of date, with a one-click path to regenerate it.

## Goals

- Edit and persist `transcript.md` from the Transcript tab, with the same draft / dirty /
  save / revert ergonomics as the summary editor.
- Find-and-replace within either editor: case-insensitive and whole-word toggles, a live
  match count, and Replace-all.
- When the transcript changes after the summary was generated, show a non-blocking banner on
  the Summary tab with a **Re-summarize** action.

## Non-goals (YAGNI)

- No regular-expression find/replace.
- No "also apply this replacement to the other document" — each editor is independent.
- No automatic re-summarize on transcript save (burns GPU; can clobber hand-edited
  summaries; risky given recent reasoning-loop failures).
- No separate "action items are stale" indicator — Re-summarize refreshes summary **and**
  actions together, which is sufficient.

## Architecture

### 1. Editable transcript

The Transcript tab gains a `View` / `Edit` toggle, matching `SummaryPanel`:

- **View** — unchanged: parsed click-to-seek lines.
- **Edit** — a textarea over the raw `transcript.md` text, plus the find/replace bar and
  Save / Revert. Reuses the draft / `savedValue` / `dirty` machinery the summary editor
  already uses.

Editing is offered **only when `transcript.md` exists** (i.e. post-merge, `transcriptMd !==
null`). The raw pre-merge preview (`rawTranscriptText`, shown before merge) stays read-only —
there is nothing durable to write yet.

**Persistence:** a new IPC channel `transcript:save` mirrors `meetings:saveSummary`:
type-check args, cap at ~5 MB, `mkdir -p` the meeting folder, write `transcript.md`, return
the written markdown. Wired through `contracts.ts`, `handlers.ts`, `preload/index.ts`, and
the renderer `api` wrapper as `api.meetings.saveTranscript(id, markdown)`.

**Overwrite semantics (documented caveat):** transcript edits live in `transcript.md` and are
overwritten if the pipeline is re-run from `transcribe` / `diarize` / `merge` (the same
caveat the summary editor already carries for re-summarize). The **Re-summarize** path
(`summarizing` → `extracting`) does **not** rewrite `transcript.md`, so the edit→re-summarize
loop is safe and is the intended flow.

### 2. Summary staleness (mtime-derived)

`meetings:get` (`handlers.ts:155`) already reads `transcript.md` and `summary.md` to build
`MeetingDetail`. Add a derived boolean:

```ts
const summaryStale = (() => {
  const t = path.join(folder, 'transcript.md');
  const su = path.join(folder, 'summary.md');
  if (!fs.existsSync(t) || !fs.existsSync(su)) return false;
  return fs.statSync(t).mtimeMs > fs.statSync(su).mtimeMs;
})();
```

Returned as `summaryStale` on the detail object.

**Why mtime over a DB flag:** the comparison is semantically exact and needs no migration or
pipeline wiring.

- Editing the transcript rewrites `transcript.md` → newer → stale.
- Re-summarizing rewrites `summary.md` → newer → fresh.
- Editing the *summary* touches only `summary.md` → never marks itself stale.
- Normal pipeline order is merge (`transcript.md`) then summarize (`summary.md`), so a
  freshly-processed meeting is never falsely stale.

The alternative — a `summary_stale` column set on transcript-save and cleared in the
summarize stage — adds a migration and two write-sites for no behavioral gain. Rejected.

**UI:** `SummaryPanel` renders a non-blocking banner when `meeting.summaryStale` is true and
the user is not mid-edit: *"Transcript edited after this summary was generated."* with a
**Re-summarize** button calling the existing `rerunFrom('summarizing')` (refreshes summary +
action items). The banner auto-clears on the next poll/reload once summarize rewrites
`summary.md`.

### 3. Find/replace bar (shared)

New `electron/renderer/src/components/FindReplaceBar.tsx`, shown in each editor's Edit mode.

**UI:** find input, replace input, case-insensitive toggle, whole-word toggle, live
`"N matches"` count, **Replace all** button (disabled when find is empty or count is 0).

**Core logic** is a pure, exported, unit-tested function — the risky part lives here, isolated
from React:

```ts
export function replaceAll(
  text: string,
  find: string,
  replace: string,
  opts: { caseInsensitive: boolean; wholeWord: boolean },
): { result: string; count: number };

export function countMatches(
  text: string,
  find: string,
  opts: { caseInsensitive: boolean; wholeWord: boolean },
): number;
```

- `find` is regex-escaped before use (so a name like `C++` or an initial like `a.b` is treated
  literally).
- `wholeWord` wraps the escaped term in `\b…\b`.
- `caseInsensitive` adds the `i` flag.
- The replacement string is inserted literally (escape `$` so `$&`/`$1` are not interpreted).

The bar mutates only the current editor's `draft` via its `onChange`, which marks the editor
dirty; the user still presses Save to persist. Replacement is independent per editor.

### Code organization

`MeetingDetailView.tsx` is ~2207 lines — too large to keep growing. New code lands in new
files, and the shared edit machinery is extracted so Summary and Transcript don't duplicate
it:

- `components/FindReplaceBar.tsx` — the bar + `replaceAll` / `countMatches`.
- `components/useDocEditor.ts` — a hook encapsulating `draft` / `savedValue` / `dirty` /
  `save` / `revert` / re-seed-on-prop-change (lifted from today's `SummaryPanel`).
- `components/DocEditorToolbar.tsx` — the mode toggle + dirty/saved/error status + Save/Revert
  (lifted from `SummaryToolbar`).
- `SummaryPanel` is refactored to consume the hook + toolbar (behavior unchanged) and to show
  the stale banner.
- A new `TranscriptPanel` (Edit mode) consumes the same hook + toolbar + bar; its View mode is
  the existing click-to-seek renderer.

This is a focused extraction in service of the feature, not a broad refactor.

## Data flow

```
Edit transcript ─Save→ transcript:save writes transcript.md (mtime > summary.md)
      │
      └─onReload→ meetings:get → summaryStale = true → banner on Summary tab
                        │
                  Re-summarize → rerunFrom('summarizing')
                        │            summarize reads edited transcript.md,
                        │            writes summary.md (mtime > transcript.md)
                        └─poll/reload→ summaryStale = false → banner clears
```

Find/replace (either editor): mutate that editor's draft → dirty → Save → persist that file
only.

## Error handling

- `transcript:save`: invalid args → throw; `> 5 MB` → throw "transcript too large"; surfaced
  in the editor toolbar exactly like summary save errors.
- `FindReplaceBar`: empty find → 0 matches, Replace-all disabled. No regex means no
  invalid-pattern state.
- Missing `transcript.md` or `summary.md` → `summaryStale = false` (never blocks).

## Testing

**Pure (highest value):** `replaceAll` / `countMatches` —
case-sensitive vs insensitive; whole-word boundaries (`Dan` must not hit `Danielle`);
regex-special find terms (`C++`, `a.b`, `(x)`); replacement strings containing `$`; zero
matches; multi-line text; accurate counts.

**Main process:** `transcript:save` writes `transcript.md` and enforces the size cap;
`summaryStale` mtime logic — newer transcript → true, newer summary → false, either file
missing → false.

**Regression:** existing 418 tests stay green; `SummaryPanel` behavior (save, dirty, revert,
re-seed) unchanged after the hook/toolbar extraction.

## Files touched

- `electron/main/ipc/contracts.ts` — add `transcript:save` channel.
- `electron/main/ipc/handlers.ts` — add `transcript:save` handler; compute `summaryStale` in
  `meetings:get`.
- `electron/preload/index.ts` — expose `saveTranscript`.
- renderer `api` wrapper — `api.meetings.saveTranscript`.
- `electron/renderer/src/components/FindReplaceBar.tsx` — new.
- `electron/renderer/src/components/useDocEditor.ts` — new.
- `electron/renderer/src/components/DocEditorToolbar.tsx` — new.
- `electron/renderer/src/views/MeetingDetailView.tsx` — refactor `SummaryPanel` (hook +
  toolbar + stale banner); add `TranscriptPanel` edit mode; add `summaryStale` to the detail
  type.
- Test files alongside the new modules.
