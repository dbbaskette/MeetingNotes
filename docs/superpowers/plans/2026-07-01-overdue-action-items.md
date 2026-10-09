# Overdue Action Items — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give overdue action items in the Weekly view a distinct visual tier instead of blending into the same "later" bucket as items due next month.

**Architecture:** `fmtDueLabel` in `electron/renderer/src/views/WeeklyView.tsx` currently buckets a due date into `'this-week' | 'later' | 'none'` by comparing it only to the displayed week's `rangeEnd` — it never compares against the actual current date, so a date from three weeks ago renders identically to one due next month. Extract the function into a testable module (mirroring the existing `electron/renderer/src/lib/theme.ts` pattern in this repo), add an `'overdue'` tier computed against the real current date, and give it dedicated danger styling in the rendering.

**Tech Stack:** React + TypeScript renderer, vitest.

---

### Task 1: Add an `overdue` tier to due-date labeling

**Files:**
- Create: `electron/renderer/src/lib/due-date.ts`
- Test: `electron/renderer/src/lib/due-date.test.ts`
- Modify: `electron/renderer/src/views/WeeklyView.tsx:141-148` (remove local `fmtDueLabel`, import the new module)
- Modify: `electron/renderer/src/views/WeeklyView.tsx:608-620` (add the `overdue` rendering branch)

- [ ] **Step 1: Write the failing test**

```ts
// electron/renderer/src/lib/due-date.test.ts
import { describe, it, expect } from 'vitest';
import { fmtDueLabel } from './due-date';

describe('fmtDueLabel', () => {
  const now = new Date('2026-07-01T15:00:00Z');
  const rangeEnd = '2026-07-05'; // end of the displayed week

  it('flags a date before today as overdue, regardless of the displayed week', () => {
    const result = fmtDueLabel('2026-06-10', rangeEnd, now);
    expect(result.tier).toBe('overdue');
    expect(result.label).toBe('Overdue — was due Wed, Jun 10');
  });

  it('does not flag today itself as overdue', () => {
    const result = fmtDueLabel('2026-07-01', rangeEnd, now);
    expect(result.tier).toBe('this-week');
  });

  it('keeps a date within the displayed week (and not yet past) as this-week', () => {
    const result = fmtDueLabel('2026-07-03', rangeEnd, now);
    expect(result.tier).toBe('this-week');
    expect(result.label).toBe('Due Fri, Jul 3');
  });

  it('keeps a date after the displayed week as later', () => {
    const result = fmtDueLabel('2026-07-20', rangeEnd, now);
    expect(result.tier).toBe('later');
  });

  it('returns none when there is no due date', () => {
    const result = fmtDueLabel(null, rangeEnd, now);
    expect(result).toEqual({ label: 'No due date', tier: 'none' });
  });

  it('defaults `now` to the real current date when omitted', () => {
    // Just confirm it doesn't throw and returns a valid tier — we can't
    // assert an exact value without controlling wall-clock time.
    const result = fmtDueLabel('2020-01-01', rangeEnd);
    expect(result.tier).toBe('overdue');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/renderer/src/lib/due-date.test.ts`
Expected: FAIL — cannot find module `./due-date`.

- [ ] **Step 3: Create the module**

```ts
// electron/renderer/src/lib/due-date.ts

/** Tier used to style an action item's due-date chip in the Weekly view.
 *  `overdue` is judged against the real current date (`now`), independent
 *  of which week is being browsed — an item from three weeks ago is
 *  overdue even if the user is looking at last week's rollup. */
export type DueTier = 'overdue' | 'this-week' | 'later' | 'none';

export interface DueLabel {
  label: string;
  tier: DueTier;
}

/** Truncate to a date-only ISO string so same-day comparisons don't get
 *  tripped up by time-of-day (a task due "today" should not read as
 *  overdue just because it's already 3pm). */
function dateOnly(d: Date): number {
  return new Date(d.toISOString().slice(0, 10)).getTime();
}

export function fmtDueLabel(due: string | null, rangeEnd: string, now: Date = new Date()): DueLabel {
  if (!due) return { label: 'No due date', tier: 'none' };
  const dueT = new Date(due).getTime();
  const endT = new Date(rangeEnd).getTime();
  const todayT = dateOnly(now);
  const tier: DueTier = dueT < todayT ? 'overdue' : dueT <= endT ? 'this-week' : 'later';
  const fmtDate = (): string =>
    new Date(due).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const label = tier === 'overdue' ? `Overdue — was due ${fmtDate()}` : `Due ${fmtDate()}`;
  return { label, tier };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/renderer/src/lib/due-date.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the module into `WeeklyView.tsx`**

Remove the local `fmtDueLabel` function (currently at `electron/renderer/src/views/WeeklyView.tsx:141-148`):

```ts
function fmtDueLabel(due: string | null, rangeEnd: string): { label: string; tier: 'this-week' | 'later' | 'none' } {
  if (!due) return { label: 'No due date', tier: 'none' };
  const dueT = new Date(due).getTime();
  const endT = new Date(rangeEnd).getTime();
  const tier: 'this-week' | 'later' = dueT <= endT ? 'this-week' : 'later';
  const label = `Due ${new Date(due).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
  return { label, tier };
}
```

Add this import near the top of the file, alongside the existing imports (`electron/renderer/src/views/WeeklyView.tsx:12-15`):

```ts
import { fmtDueLabel } from '../lib/due-date';
```

- [ ] **Step 6: Add the `overdue` rendering branch**

In `electron/renderer/src/views/WeeklyView.tsx`, replace the due-tier rendering block (currently lines 608-620):

```tsx
{due.tier === 'this-week' ? (
  <span className="text-[11px] px-2 py-0.5 rounded-full bg-status-warnBg text-status-warnText font-medium shrink-0">
    {due.label}
  </span>
) : due.tier === 'later' ? (
  <span className="text-[11px] px-2 py-0.5 rounded-full bg-skeleton text-ink-muted font-medium shrink-0">
    {due.label}
  </span>
) : (
  <span className="text-[11px] px-2 py-0.5 text-ink-muted shrink-0">
    {due.label}
  </span>
)}
```

with:

```tsx
{due.tier === 'overdue' ? (
  <span className="text-[11px] px-2 py-0.5 rounded-full bg-danger-bg text-danger-text font-semibold shrink-0">
    {due.label}
  </span>
) : due.tier === 'this-week' ? (
  <span className="text-[11px] px-2 py-0.5 rounded-full bg-status-warnBg text-status-warnText font-medium shrink-0">
    {due.label}
  </span>
) : due.tier === 'later' ? (
  <span className="text-[11px] px-2 py-0.5 rounded-full bg-skeleton text-ink-muted font-medium shrink-0">
    {due.label}
  </span>
) : (
  <span className="text-[11px] px-2 py-0.5 text-ink-muted shrink-0">
    {due.label}
  </span>
)}
```

- [ ] **Step 7: Type-check and run the full test suite**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx vitest run`
Expected: no type errors; all tests (including the 6 new ones) pass.

- [ ] **Step 8: Commit**

```bash
git add electron/renderer/src/lib/due-date.ts electron/renderer/src/lib/due-date.test.ts electron/renderer/src/views/WeeklyView.tsx
git commit -m "feat(weekly): add overdue tier to action-item due dates"
```

---

## Self-Review

**Spec coverage:** The brainstormed idea was "'Later' due dates and 'overdue' due dates look identical — overdue should out-rank and out-color everything else." Task 1 adds a distinct `overdue` tier, computed against the real current date (not just the displayed week), styled with the `danger` tokens so it visually outranks the amber "this-week" and neutral "later" chips. Covered.

**Placeholder scan:** No TBD/TODO markers; every step has complete, runnable code.

**Type consistency:** `DueTier` is defined once in `due-date.ts` and used verbatim in both the test file and the `WeeklyView.tsx` rendering branch (via the return type of `fmtDueLabel`, not re-declared). `fmtDueLabel`'s signature (`due, rangeEnd, now`) matches every call site, including the existing one at `WeeklyView.tsx:587` (`fmtDueLabel(it.dueDate, data.rangeEnd)`) — the new `now` parameter is optional with a default, so that call site needs no change.
