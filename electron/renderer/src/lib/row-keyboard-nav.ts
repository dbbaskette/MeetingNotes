// electron/renderer/src/lib/row-keyboard-nav.ts
//
// j / k / Enter for the organized Library (#298). The flat list had j/k, but
// the default organized view (groups, each with its own virtual window) had
// none, and neither bound Enter. Rows here live in several lists, so this
// works on what is rendered: it moves real keyboard focus to the next row's
// open control, which also makes Enter and Space open it natively and lets
// each list's own focus retention keep the row mounted.
import { useEffect, type RefObject } from 'react';
import { stepMeetingIndex } from './virtual-window';

/** The row to move to from `currentId` in `orderedIds`, or null if there are none. */
export function nextRowId(orderedIds: readonly string[], currentId: string | null, delta: 1 | -1): string | null {
  const index = currentId === null ? -1 : orderedIds.indexOf(currentId);
  const next = stepMeetingIndex(orderedIds.length, index === -1 ? null : index, delta);
  return next === null ? null : orderedIds[next]!;
}

const INTERACTIVE = 'input, textarea, select, [contenteditable="true"]';

export function useRowKeyboardNav(scroll: RefObject<HTMLElement>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'j' && key !== 'k') return;
      const root = scroll.current;
      // A retained but hidden Library, or an open dialog, does not own the keys.
      if (!root?.getClientRects().length || document.querySelector('[role="dialog"][aria-modal="true"],[role="menu"]')) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(INTERACTIVE)) return;
      const rows = [...root.querySelectorAll<HTMLElement>('[data-row-id]')]
        .map((el) => ({ el, top: el.getBoundingClientRect().top }))
        .sort((a, b) => a.top - b.top);
      if (rows.length === 0) return;
      event.preventDefault();
      const currentId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-row-id]')?.dataset.rowId ?? null;
      const nextId = nextRowId(rows.map((row) => row.el.dataset.rowId!), currentId, key === 'j' ? 1 : -1);
      const next = rows.find((row) => row.el.dataset.rowId === nextId)?.el;
      const control = next?.querySelector<HTMLElement>('[role="button"], button');
      if (!next || !control) return;
      control.focus({ preventScroll: true });
      next.scrollIntoView({ block: 'nearest' });
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [scroll, enabled]);
}
