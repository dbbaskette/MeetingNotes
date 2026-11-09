# Cult UI Motion Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four hand-ported Cult UI interaction patterns (expandable panels, sliding pills and tabs, animated toasts, a recording pill) to the renderer.

**Architecture:** Small animation components live in `electron/renderer/src/components/motion/` and use the `motion` library. Logic that is not visual (toast timers, tab keys, inbox summary) lives in `lib/` as pure functions with Vitest tests. Existing components adopt the new pieces; no IPC or main-process change.

**Tech Stack:** React 18, Tailwind 3.4, `motion` (new), Vitest under Electron's Node (`npm test`).

Spec: `docs/superpowers/specs/2026-11-09-cult-ui-motion-patterns-design.md`.

All paths below are relative to `electron/renderer/src/` unless they start with `docs/` or are `package.json`.

---

### Task 1: Dependency and shared motion pieces

**Files:** Modify `package.json`; create `components/motion/spring.ts`, `components/motion/Expandable.tsx`, `components/motion/SlidingPill.tsx`; modify `App.tsx`, `index.css`.

- [ ] **Step 1:** `npm install motion` (adds it to `dependencies`).
- [ ] **Step 2:** Create `components/motion/spring.ts`:

```ts
export const SPRING = { type: 'spring', stiffness: 420, damping: 36, mass: 0.9 } as const;
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
```

- [ ] **Step 3:** Create `components/motion/Expandable.tsx`:

```tsx
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { SPRING } from './spring';

/** Opens and closes its children by height. Unmounts them when closed. */
export function Expandable({ open, id, className, children }: {
  open: boolean; id?: string; className?: string; children: ReactNode;
}): JSX.Element {
  return <AnimatePresence initial={false}>
    {open && <motion.div id={id} key="content" className={className} style={{ overflow: 'hidden' }}
      initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }} transition={SPRING}>{children}</motion.div>}
  </AnimatePresence>;
}
```

- [ ] **Step 4:** Create `components/motion/SlidingPill.tsx`. It is rendered inside the selected item only. On mount it animates from the last box recorded for its group, so it works both within one control and across views that each render their own nav.

```tsx
import { useLayoutEffect, useRef } from 'react';
import { animate } from 'motion';
import { SPRING, prefersReducedMotion } from './spring';

const lastBox = new Map<string, DOMRect>();

export function SlidingPill({ group, className = '' }: { group: string; className?: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.width === 0) return; // hidden view: keep the last visible box
    const previous = lastBox.get(group);
    lastBox.set(group, box);
    if (!previous || prefersReducedMotion()) return;
    const controls = animate(el, {
      x: [previous.left - box.left, 0], y: [previous.top - box.top, 0],
      width: [previous.width, box.width],
    }, SPRING);
    void controls.then(() => { el.style.width = ''; });
    return () => controls.stop();
  }, [group]);
  return <span ref={ref} aria-hidden="true" className={`sliding-pill pointer-events-none absolute left-0 w-full ${className}`} />;
}
```

- [ ] **Step 5:** In `App.tsx`, import `MotionConfig` from `motion/react` and wrap `<AppInner />` in `<MotionConfig reducedMotion="user">`.
- [ ] **Step 6:** In `index.css`, replace the selected-item rule (lines 131–136) so the background lives on the pill:

```css
.primary-nav button[aria-current='page'], .segmented-control button[aria-pressed='true'],
.settings-navigation button[aria-pressed='true'] { color: rgb(var(--ink)); }
.sliding-pill.pill-surface {
  background: rgb(var(--surface)); border-radius: 6px;
  box-shadow: 0 1px 3px rgb(var(--material-shadow) / 0.14), inset 0 1px 0 rgb(var(--material-highlight) / 0.5);
}
```

- [ ] **Step 7:** `npx tsc -p tsconfig.json --noEmit` (or the project's renderer typecheck) passes. Commit: `Add motion and shared animation pieces`.

### Task 2: Sliding pills on nav, segmented control, settings sections

**Files:** Modify `components/AppNav.tsx`, `views/LibraryView.tsx` (segmented control and `AppNav` key), `views/WeeklyView.tsx` (`AppNav` key), `components/SettingsNavigation.tsx`.

- [ ] **Step 1:** `AppNav`: every button gets `relative` and no background class; the active one renders `<SlidingPill group="primary-nav" className="inset-y-0 pill-surface" />` before a `<span className="relative">{label}</span>`.
- [ ] **Step 2:** `LibraryView` and `WeeklyView` stay mounted while hidden, so pass `key={active ? 'shown' : 'hidden'}` to their `AppNav` to replay the slide when the view returns.
- [ ] **Step 3:** Library segmented control: same pattern with `group="library-view-mode"`; drop the `bg-brand-solid text-white` classes that `index.css` already overrode.
- [ ] **Step 4:** `SettingsNavigation` section buttons: same pattern with `group="settings-sections"`; selected text uses `text-ink`.
- [ ] **Step 5:** Preview check: click through the four nav items, the toggle, and the settings sections. Commit: `Slide the selection pill on nav and segmented controls`.

### Task 3: Meeting tabs with tab semantics

**Files:** Create `lib/tab-keys.ts`, `lib/tab-keys.test.ts`; modify `views/MeetingDetailView.tsx` (the `detail-tabs` block in `CenterPane`).

- [ ] **Step 1:** Write `lib/tab-keys.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { nextTabIndex } from './tab-keys';

describe('nextTabIndex', () => {
  it('moves right and wraps', () => {
    expect(nextTabIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
  });
  it('moves left and wraps', () => {
    expect(nextTabIndex('ArrowLeft', 1, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
  });
  it('jumps to the ends', () => {
    expect(nextTabIndex('Home', 2, 3)).toBe(0);
    expect(nextTabIndex('End', 0, 3)).toBe(2);
  });
  it('ignores other keys and empty lists', () => {
    expect(nextTabIndex('Enter', 0, 3)).toBeNull();
    expect(nextTabIndex('ArrowRight', 0, 0)).toBeNull();
  });
});
```

- [ ] **Step 2:** Run `npm test -- electron/renderer/src/lib/tab-keys.test.ts`; expect failure (module missing).
- [ ] **Step 3:** Write `lib/tab-keys.ts`:

```ts
/** Index a tab-list key press moves to, or null when the key is not a tab key. */
export function nextTabIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
```

- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** In `CenterPane`, the tab strip becomes `role="tablist" aria-label="Meeting sections"`. Each button: `role="tab"`, `id={`detail-tab-${t}`}`, `aria-selected`, `aria-controls="detail-tabpanel"`, `tabIndex={tab === t ? 0 : -1}`, `relative`, and an `onKeyDown` that calls `nextTabIndex`, switches tab and focuses the new button. Arrow keys must `stopPropagation` so the audio transport's Left/Right handler does not also fire. The selected tab renders `<SlidingPill group="detail-tabs" className="-bottom-px h-0.5 bg-brand-indigo" />` in place of the border classes. The content wrapper gets `id="detail-tabpanel" role="tabpanel" aria-labelledby={`detail-tab-${tab}`}`.
- [ ] **Step 6:** Commit: `Give meeting tabs tab semantics and a sliding underline`.

### Task 4: Expandable recovery panels and collapsible Needs attention

**Files:** Create `lib/attention-summary.ts`, `lib/attention-summary.test.ts`; modify `components/RecoveryRow.tsx`, `components/NeedsAttentionPanel.tsx`.

- [ ] **Step 1:** Write `lib/attention-summary.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { attentionSummary, readAttentionCollapsed, saveAttentionCollapsed } from './attention-summary';

const memory = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const map = new Map<string, string>();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); } };
};

describe('attentionSummary', () => {
  it('joins counts with lower-case labels', () => {
    expect(attentionSummary([
      { label: 'Processing failed', totalCount: 1 },
      { label: 'Ready to process', totalCount: 2 },
    ])).toBe('1 processing failed · 2 ready to process');
  });
  it('is empty for no groups', () => { expect(attentionSummary([])).toBe(''); });
});

describe('collapsed preference', () => {
  it('defaults to expanded and round-trips', () => {
    const store = memory();
    expect(readAttentionCollapsed(store)).toBe(false);
    saveAttentionCollapsed(true, store);
    expect(readAttentionCollapsed(store)).toBe(true);
  });
  it('survives a throwing store', () => {
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(readAttentionCollapsed(broken)).toBe(false);
    expect(() => saveAttentionCollapsed(true, broken)).not.toThrow();
  });
});
```

- [ ] **Step 2:** Run it; expect failure.
- [ ] **Step 3:** Write `lib/attention-summary.ts`:

```ts
const KEY = 'needsAttentionCollapsed';
type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function attentionSummary(groups: { label: string; totalCount: number }[]): string {
  return groups.map(group => `${group.totalCount} ${group.label.toLowerCase()}`).join(' · ');
}
export function readAttentionCollapsed(store: Store = window.localStorage): boolean {
  try { return store.getItem(KEY) === '1'; } catch { return false; }
}
export function saveAttentionCollapsed(collapsed: boolean, store: Store = window.localStorage): void {
  try { store.setItem(KEY, collapsed ? '1' : '0'); } catch { /* preference only */ }
}
```

- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** `RecoveryRow`: replace `{confirmingDelete && <div id=…>…</div>}` with `<Expandable open={confirmingDelete} id={`${panelId}-delete`}>` around the same div (move the `id` to `Expandable`, keep `mt-3` on an inner wrapper so the margin animates with it). Do the same for the preview panel with `open={preview !== null}`; keep rendering the last preview while it closes by reading from a `shownPreview` ref.
- [ ] **Step 6:** `NeedsAttentionPanel`: add `collapsed` state seeded from `readAttentionCollapsed`. The header's dot, title and count become one `<button aria-expanded={!collapsed} aria-controls="attention-items">` with a chevron that rotates. When collapsed, show `attentionSummary(allGroups…)` as muted text in the header and hide "View all". Wrap the error line and `#attention-items` in `<Expandable open={!collapsed}>`. Errors force the panel open.
- [ ] **Step 7:** Preview check; commit: `Animate recovery panels and make Needs attention collapsible`.

### Task 5: Toasts

**Files:** Create `lib/toast-queue.ts`, `lib/toast-queue.test.ts`; modify `components/Toasts.tsx`.

- [ ] **Step 1:** Write `lib/toast-queue.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPausableTimer, toastDuration, visibleToasts, TOAST_CAP } from './toast-queue';

describe('toastDuration', () => {
  it('defaults neutral toasts to 6s', () => { expect(toastDuration({})).toBe(6000); });
  it('keeps errors until dismissed', () => { expect(toastDuration({ variant: 'error' })).toBeNull(); });
  it('honours an explicit duration, including for errors', () => {
    expect(toastDuration({ variant: 'error', durationMs: 4000 })).toBe(4000);
    expect(toastDuration({ durationMs: null })).toBeNull();
  });
});

describe('visibleToasts', () => {
  it('keeps the newest up to the cap', () => {
    const list = [1, 2, 3, 4, 5, 6];
    expect(visibleToasts(list)).toEqual(list.slice(-TOAST_CAP));
    expect(visibleToasts([1])).toEqual([1]);
  });
});

describe('createPausableTimer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it('fires after the duration', () => {
    const done = vi.fn();
    createPausableTimer(1000, done);
    vi.advanceTimersByTime(999); expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(done).toHaveBeenCalledTimes(1);
  });
  it('pauses and resumes with the remaining time', () => {
    const done = vi.fn();
    const timer = createPausableTimer(1000, done);
    vi.advanceTimersByTime(600); timer.pause();
    vi.advanceTimersByTime(5000); expect(done).not.toHaveBeenCalled();
    timer.resume();
    vi.advanceTimersByTime(399); expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(done).toHaveBeenCalledTimes(1);
  });
  it('does nothing after cancel, and ignores double pause/resume', () => {
    const done = vi.fn();
    const timer = createPausableTimer(1000, done);
    timer.pause(); timer.pause(); timer.resume(); timer.resume();
    timer.cancel(); vi.advanceTimersByTime(5000);
    expect(done).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2:** Run it; expect failure.
- [ ] **Step 3:** Write `lib/toast-queue.ts`:

```ts
export const TOAST_CAP = 4;

export function toastDuration(request: { durationMs?: number | null; variant?: 'default' | 'error' }): number | null {
  if (request.durationMs !== undefined) return request.durationMs !== null && request.durationMs > 0 ? request.durationMs : null;
  return request.variant === 'error' ? null : 6000;
}

export function visibleToasts<T>(toasts: T[], cap: number = TOAST_CAP): T[] {
  return toasts.length > cap ? toasts.slice(-cap) : toasts;
}

export interface PausableTimer { pause(): void; resume(): void; cancel(): void; }

export function createPausableTimer(durationMs: number, onExpire: () => void): PausableTimer {
  let remaining = durationMs;
  let startedAt = Date.now();
  let handle: ReturnType<typeof setTimeout> | null = setTimeout(onExpire, remaining);
  let cancelled = false;
  return {
    pause() {
      if (cancelled || handle === null) return;
      clearTimeout(handle); handle = null;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
    },
    resume() {
      if (cancelled || handle !== null) return;
      startedAt = Date.now();
      handle = setTimeout(onExpire, remaining);
    },
    cancel() {
      cancelled = true;
      if (handle !== null) { clearTimeout(handle); handle = null; }
    },
  };
}
```

- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** `Toasts.tsx`: `timersRef` holds `PausableTimer`s created with `toastDuration(req)`. `ToastItem` becomes a `motion.div` with `layout`, `initial={{ opacity: 0, x: 24 }}`, `animate={{ opacity: 1, x: 0 }}`, `exit={{ opacity: 0, x: 24 }}`, `transition={SPRING}`, `role={variant === 'error' ? 'alert' : 'status'}`, and `onMouseEnter/onFocus` → pause, `onMouseLeave/onBlur` → resume. The host maps `visibleToasts(toasts)` inside `<AnimatePresence initial={false}>` and no longer sets `aria-live` on the container (each item carries its own role).
- [ ] **Step 6:** Commit: `Animate toasts, pause on hover, keep errors until dismissed`.

### Task 6: Recording pill

**Files:** Create `components/motion/RecordingPill.tsx`; modify `App.tsx`, `index.css`.

- [ ] **Step 1:** Create `RecordingPill.tsx`. Props are `LiveRecordingRow`'s props. It renders, fixed at the top centre inside the title-bar strip:
  - a 24 px-high button (`aria-expanded`, `aria-controls`, name "Recording, {elapsed}. Show controls") with a pulsing red dot, `fmtElapsed(useElapsed(startedAt, true))`, and a three-bar meter driven by `api.recording.onLevel` for the `mixed` source;
  - a `motion.div` panel below it that stays mounted (so `LiveRecordingRow` keeps its capture-health history) and animates between `{ opacity: 0, scale: 0.96, y: -6 }` with `visibility: hidden` and `{ opacity: 1, scale: 1, y: 0 }`; it sets `inert` while collapsed and contains `<LiveRecordingRow {...props} />`.
  - Esc and outside `mousedown` collapse it, except when a modal dialog (`[role="dialog"][aria-modal="true"]`) is open.
- [ ] **Step 2:** `App.tsx`: replace the `showTopBanner` block with `{showTopBanner && <RecordingPill … />}` and render the drag strip with `data-split` when the pill is shown.
- [ ] **Step 3:** `index.css`: when split, the strip leaves a 240 px gap in the centre so the pill is never underneath it:

```css
.window-drag-strip[data-split='left'] { right: calc(50% + 120px); }
.window-drag-strip[data-split='right'] { left: calc(50% + 120px); }
```

- [ ] **Step 4:** Preview check: start a recording from the Library (stub returns a session), go to Actions, expand and collapse the pill. Commit: `Show a compact recording pill outside the Library`.

### Task 7: Verify

- [ ] `npm test` passes.
- [ ] `npm run lint` shows no new errors in touched files.
- [ ] Production `vite build` into a scratch directory; record the `App` chunk size before (218.64 kB) and after.
- [ ] Preview in light, dark, and with reduced motion; screenshots.
- [ ] Not verifiable here: the pill inside the real Electron title bar. Say so in the report.
