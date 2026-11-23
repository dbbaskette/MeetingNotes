// electron/renderer/src/lib/menu-keyboard.ts
//
// Keyboard behaviour for popover menus (WAI-ARIA menu pattern, #296). The
// row and group menus opened on click but left focus on the trigger, so a
// keyboard user had to Tab through the page behind them, arrow keys did
// nothing, and Escape did not return focus to where it came from.
import { useEffect, type RefObject } from 'react';

/** Index to focus next for a navigation key, or null when the key is not one.
 *  `index` is -1 when nothing in the menu has focus yet. */
export function nextMenuIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown': return index < 0 ? 0 : (index + 1) % count;
    case 'ArrowUp': return index < 0 ? count - 1 : (index - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/** While `open`, focuses the first `[role="menuitem"]`, moves focus with the
 *  arrow keys / Home / End, and on Escape closes the menu and returns focus
 *  to the trigger. Tab closes the menu and lets focus move on. Activating an
 *  item returns focus to the trigger before the item's own handler runs. */
export function useMenuKeyboard(
  menu: RefObject<HTMLElement>,
  trigger: RefObject<HTMLElement>,
  open: boolean,
  close: () => void,
): void {
  useEffect(() => {
    const el = menu.current;
    if (!open || !el) return;
    const items = (): HTMLElement[] =>
      [...el.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((item) => !item.matches(':disabled'));
    items()[0]?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Handled here so it does not also reach page-level Escape handlers
        // (the Library clears its bulk selection on Escape).
        event.preventDefault();
        event.stopPropagation();
        close();
        trigger.current?.focus();
        return;
      }
      if (event.key === 'Tab') { close(); return; }
      const list = items();
      const next = nextMenuIndex(event.key, list.indexOf(document.activeElement as HTMLElement), list.length);
      if (next === null) return;
      event.preventDefault();
      list[next]?.focus();
    };
    // Choosing an item usually unmounts the menu, which would drop focus on
    // <body>. Hand it back to the trigger first: a dialog the item opens then
    // records the trigger as the element to return to when it closes. This
    // native listener runs before React's delegated onClick.
    const onClick = (event: MouseEvent): void => {
      if ((event.target as Element | null)?.closest('[role="menuitem"]')) trigger.current?.focus();
    };
    el.addEventListener('keydown', onKey);
    el.addEventListener('click', onClick);
    return () => { el.removeEventListener('keydown', onKey); el.removeEventListener('click', onClick); };
  }, [menu, trigger, open, close]);
}
