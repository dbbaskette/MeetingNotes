# Unify Search Discoverability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the faster ⌘K search overlay discoverable from the Library's inline search box, so users don't have two disconnected mental models for "search" in this app.

**Architecture:** Investigation confirmed `LibraryView`'s inline search box and the global `SearchPalette` (⌘K) both call the exact same backend handler (`api.search.query`, same ranking, same main-process logic) — they only differ in result limit (100 vs 20) and interaction model (persistent inline list vs. keyboard-navigable overlay). Rather than merging two working, differently-purposed UIs (a much larger, riskier change than the brainstormed idea called for), add a small "⌘K" hint chip inside the Library search box that opens the palette — cheap, safe, and it's the actual fix for the discoverability gap that was identified.

**Tech Stack:** React renderer (Electron).

**Non-goal:** Merging the two result-rendering paths (Library's `SearchMatches` grouped-by-meeting list vs. the palette's flat ranked list) or unifying their result limits. Both serve genuinely different interaction models (browse vs. jump-to) and there's no evidence either limit is wrong for its context — that would be solving a problem nobody raised.

---

### Task 1: Add a "⌘K" hint to the Library search box that opens the palette

**Files:**
- Modify: `electron/renderer/src/views/LibraryView.tsx:22-37` (add `onOpenSearch` to `Props`)
- Modify: `electron/renderer/src/views/LibraryView.tsx:56-58` (destructure the new prop)
- Modify: `electron/renderer/src/views/LibraryView.tsx:449-461` (the search input block)
- Modify: `electron/renderer/src/App.tsx:293-300` (pass the new prop)

- [ ] **Step 1: Add the `onOpenSearch` prop**

In `electron/renderer/src/views/LibraryView.tsx`, add to the `Props` interface (after the existing `onWeekly: () => void;` at line 34):

```ts
  onWeekly: () => void;
  /** Opens the global ⌘K search palette. Surfaced as a hint inside this
   *  view's own inline search box so users discover the faster overlay
   *  instead of assuming this box is the only way to search. */
  onOpenSearch: () => void;
```

Update the function signature (`electron/renderer/src/views/LibraryView.tsx:56-58`):

```ts
export function LibraryView({
  onOpen, onSettings, onWeekly, onOpenSearch, liveRecording, onStartRecording, onRecordingStopped,
}: Props): JSX.Element {
```

- [ ] **Step 2: Import `shortcutMod`**

Add near the top of `electron/renderer/src/views/LibraryView.tsx`, alongside the existing imports:

```ts
import { shortcutMod } from '../lib/shortcut';
```

- [ ] **Step 3: Add the hint chip to the search input**

Replace the search input block (`electron/renderer/src/views/LibraryView.tsx:449-461`):

```tsx
<div className="relative flex-1 sm:flex-none sm:w-72 sm:ml-auto min-w-[8rem]">
  <input
    placeholder="Search titles, summaries, transcripts…"
    value={query}
    onChange={(e) => setQuery(e.target.value)}
    className="w-full py-1.5 px-3 pr-16 border border-surface-border rounded-lg text-sm bg-surface placeholder:text-ink-muted
               focus:outline-none focus:border-brand-indigo focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)]"
  />
  {isSearching && searchPending && (
    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] italic text-ink-muted pointer-events-none">
      searching…
    </span>
  )}
</div>
```

with:

```tsx
<div className="relative flex-1 sm:flex-none sm:w-72 sm:ml-auto min-w-[8rem]">
  <input
    placeholder="Search titles, summaries, transcripts…"
    value={query}
    onChange={(e) => setQuery(e.target.value)}
    className="w-full py-1.5 px-3 pr-16 border border-surface-border rounded-lg text-sm bg-surface placeholder:text-ink-muted
               focus:outline-none focus:border-brand-indigo focus:shadow-[0_0_0_3px_rgba(99,102,241,0.15)]"
  />
  {isSearching && searchPending ? (
    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] italic text-ink-muted pointer-events-none">
      searching…
    </span>
  ) : (
    <button
      type="button"
      onClick={onOpenSearch}
      title="Open quick search (jump to any meeting, keyboard-navigable)"
      className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-ink-muted
                 border border-surface-border rounded px-1.5 py-0.5 hover:border-brand-indigo hover:text-brand-indigo transition"
    >
      {shortcutMod()}K
    </button>
  )}
</div>
```

The hint chip only shows when the box isn't actively showing the "searching…" indicator, so the two never overlap.

- [ ] **Step 4: Wire the prop in `App.tsx`**

In `electron/renderer/src/App.tsx`, update the `<LibraryView>` call site (lines 293-300):

```tsx
<LibraryView
  onOpen={(id, hint, opts) => setView({ kind: 'detail', id, hint, seekSeconds: opts?.seekSeconds })}
  onSettings={() => setView({ kind: 'settings' })}
  onWeekly={() => setView({ kind: 'weekly' })}
  onOpenSearch={() => setSearchOpen(true)}
  liveRecording={liveRecording}
  onStartRecording={setLiveRecording}
  onRecordingStopped={() => setLiveRecording(null)}
/>
```

(`setSearchOpen` already exists in `App.tsx` — it's the same setter the ⌘K keydown handler uses.)

- [ ] **Step 5: Verify manually in the running app**

Run: `npm run dev`
- Open the Library view. Confirm a "⌘K" (or "CtrlK" on non-Mac) chip appears at the right edge of the search box when not actively searching.
- Click the chip: confirm the search palette opens.
- Type into the Library search box: confirm the chip is replaced by "searching…" while a query is pending, and reappears once results settle.

- [ ] **Step 6: Type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add electron/renderer/src/views/LibraryView.tsx electron/renderer/src/App.tsx
git commit -m "feat(search): hint the ⌘K palette from the Library search box"
```

---

## Self-Review

**Spec coverage:** Idea #7 — "two parallel search UIs, no visible link between them" — addressed via the cheapest fix that actually solves the stated problem (discoverability), without the risk of merging two UIs that serve genuinely different interaction models.

**Placeholder scan:** No TBD/TODO; complete JSX, prop threading, and import.

**Type consistency:** `onOpenSearch: () => void` is declared once in `Props` and used identically at the call site in `App.tsx` (`() => setSearchOpen(true)`, matching the existing `setSearchOpen` setter's signature) and in the destructured function parameters — no drift.
