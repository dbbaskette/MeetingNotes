// electron/renderer/src/lib/unsaved-guard.ts
//
// Tiny cross-component "unsaved edits" guard. The meeting detail view
// registers a guard while the summary editor holds a dirty draft; any
// code that is about to navigate away from that view (App's search-
// palette meeting switch, URL-scheme open, history back/forward, the
// detail view's own back button) asks `requestLeave()` first.
//
// Guards may be asynchronous: the detail view's guard opens a styled
// ConfirmDialog and resolves the promise with the user's answer, which
// replaced the old synchronous `window.confirm` (un-themed OS chrome,
// blocked the renderer thread). Callers therefore await the result.
//
// Only one guard can be active at a time: exactly one detail view is
// ever mounted, and it clears the guard on unmount / when the draft
// stops being dirty.

type Guard = () => boolean | Promise<boolean>;

let current: Guard | null = null;

/** Register (or clear, with null) the active unsaved-edits guard. */
export function setUnsavedGuard(g: Guard | null): void {
  current = g;
}

/** Resolves true when navigation may proceed — either nothing is
 *  guarding, or the guard (typically a confirm dialog) said yes. */
export async function requestLeave(): Promise<boolean> {
  if (current === null) return true;
  return await current();
}
