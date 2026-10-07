import { createContext, useLayoutEffect, useRef, type RefObject } from 'react';
export const DialogDepth = createContext(0);
const stack: HTMLElement[] = [];
const depths = new Map<HTMLElement, number>();
const originals = new Map<HTMLElement, boolean>();
function syncInert(): void {
  for (const [el, value] of originals) el.inert = value;
  const top = stack.at(-1);
  if (!top) {
    originals.clear();
    return;
  }
  for (const child of document.body.children) {
    if (!(child instanceof HTMLElement) || child.contains(top)) continue;
    if (!originals.has(child)) originals.set(child, child.inert);
    child.inert = true;
  }
}
function focusables(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]'),
  ].filter(
    (el) =>
      !el.matches(':disabled,[tabindex="-1"]') &&
      el.getClientRects().length > 0 &&
      !el.closest('[inert]'),
  );
}
export function useDialogSurface(
  root: RefObject<HTMLElement>,
  options: {
    active?: boolean;
    busy?: boolean;
    depth?: number;
    onClose: () => void;
  },
): void {
  const latest = useRef(options);
  latest.current = options;
  const active = options.active ?? true;
  useLayoutEffect(() => {
    if (!active || !root.current) return;
    const el = root.current,
      trigger = document.activeElement as HTMLElement | null;
    depths.set(el, latest.current.depth ?? 0);
    stack.push(el);
    stack.sort((a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0));
    syncInert();
    const initial =
      el.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? focusables(el)[0] ?? el;
    if (stack.at(-1) === el && !initial.matches(':disabled')) initial.focus();
    const observer = new MutationObserver(syncInert);
    observer.observe(document.body, { childList: true });
    const onKey = (event: KeyboardEvent): void => {
      if (stack.at(-1) !== el) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!latest.current.busy) latest.current.onClose();
      } else if (event.key === 'Tab') {
        const list = focusables(el),
          index = list.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey
          ? index <= 0
            ? list.at(-1)
            : list[index - 1]
          : index < 0 || index === list.length - 1
            ? list[0]
            : list[index + 1];
        event.preventDefault();
        event.stopImmediatePropagation();
        (next ?? el).focus();
      }
    };
    const onFocus = (event: FocusEvent): void => {
      if (stack.at(-1) === el && !el.contains(event.target as Node))
        (focusables(el)[0] ?? el).focus();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus, true);
      stack.splice(stack.indexOf(el), 1);
      depths.delete(el);
      syncInert();
      const fallback = stack.at(-1);
      if (trigger?.isConnected && trigger !== document.body && !trigger.closest('[inert]'))
        trigger.focus();
      else if (fallback) (focusables(fallback)[0] ?? fallback).focus();
      else document.querySelector<HTMLElement>('button:not(:disabled),a[href]')?.focus();
    };
  }, [active, root]);
}
