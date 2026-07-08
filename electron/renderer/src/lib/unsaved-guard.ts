// electron/renderer/src/lib/unsaved-guard.ts
//
// Tiny cross-component "unsaved edits" guard. The meeting detail view
// registers a guard while the summary editor holds a dirty draft; any
// code that is about to navigate away from that view (App's search-
// palette meeting switch, URL-scheme open, the detail view's own back
// button) asks `confirmLeave()` first. A `window.confirm` lives inside
// the registered guard — this module stays pure so it can be unit
// tested without a DOM.
//
// Only one guard can be active at a time: exactly one detail view is
// ever mounted, and it clears the guard on unmount / when the draft
// stops being dirty.

type Guard = () => boolean;

let current: Guard | null = null;

/** Register (or clear, with null) the active unsaved-edits guard. */
export function setUnsavedGuard(g: Guard | null): void {
  current = g;
}

/** True when navigation may proceed — either nothing is guarding, or
 *  the guard (typically a window.confirm) said yes. */
export function confirmLeave(): boolean {
  return current === null ? true : current();
}
