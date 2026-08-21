// electron/renderer/src/lib/nav-history.ts
//
// Cursor-based navigation history for the app's view stack (#190).
// Extracted from App.tsx as a pure module so the semantics — de-dup,
// forward-truncation on navigate, bounds, entry cap, guard gating — are
// unit-testable without React.
//
// The guard mirrors unsaved-guard.requestLeave: navigation is blocked
// unless it resolves true (e.g. a dirty summary draft opens a discard
// confirmation first). Guarding lives INSIDE back/forward/navigate so
// callers can't forget it — and callers must therefore never pre-guard,
// or the user gets prompted twice (that was the bug fixed after review).

export type NavGuard = () => boolean | Promise<boolean>;

export interface NavHistoryOptions<V> {
  /** Entry equality for de-duplication (same screen counts once even if
   *  incidental payload like row hints differs). Default: Object.is. */
  equal?: (a: V, b: V) => boolean;
  /** Maximum retained entries. Oldest entries drop off the front.
   *  Default 50. */
  max?: number;
  /** Async gate consulted before every transition. */
  guard?: NavGuard;
  /** Called after a successful back/forward/navigate. */
  onChange?: (current: V) => void;
}

export interface NavHistory<V> {
  navigate(next: V): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  canBack(): boolean;
  canForward(): boolean;
  current(): V;
}

export function createNavHistory<V>(
  initial: V,
  opts: NavHistoryOptions<V> = {},
): NavHistory<V> {
  const equal = opts.equal ?? Object.is;
  const max = opts.max ?? 50;
  let stack: V[] = [initial];
  let cursor = 0;

  function commit(): void {
    opts.onChange?.(stack[cursor]!);
  }

  return {
    async navigate(next: V): Promise<void> {
      if (opts.guard && !(await opts.guard())) return;
      stack = stack.slice(0, cursor + 1);
      const cur = stack[stack.length - 1]!;
      if (!equal(cur, next)) stack.push(next);
      if (stack.length > max) stack.shift();
      cursor = stack.length - 1;
      commit();
    },

    async back(): Promise<void> {
      if (cursor === 0) return;
      if (opts.guard && !(await opts.guard())) return;
      cursor -= 1;
      commit();
    },

    async forward(): Promise<void> {
      if (cursor >= stack.length - 1) return;
      if (opts.guard && !(await opts.guard())) return;
      cursor += 1;
      commit();
    },

    canBack(): boolean {
      return cursor > 0;
    },

    canForward(): boolean {
      return cursor < stack.length - 1;
    },

    current(): V {
      return stack[cursor]!;
    },
  };
}

/** Loose equality for the app's View union: same screen (and same meeting
 *  + seek target for detail views) counts as one entry even when row hints
 *  captured at click-time differ between clicks. */
export function viewsEqual(a: unknown, b: unknown): boolean {
  const x = a as { kind: string; id?: string; seekSeconds?: number };
  const y = b as { kind: string; id?: string; seekSeconds?: number };
  if (x.kind !== y.kind) return false;
  if (x.kind === 'detail' && y.kind === 'detail') {
    return x.id === y.id && x.seekSeconds === y.seekSeconds;
  }
  return true;
}
