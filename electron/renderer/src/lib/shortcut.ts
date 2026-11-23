// Renderer-side platform helper for keyboard shortcuts. The app ships only on
// macOS today, but the renderer also runs in `npm run dev` on Linux for
// non-recording UI work; falling back to "Ctrl" there keeps in-UI hints
// honest instead of always claiming "⌘".
export function shortcutMod(): string {
  const platform = typeof navigator !== 'undefined' ? navigator.platform : '';
  return /Mac|iPhone|iPad/i.test(platform) ? '⌘' : 'Ctrl';
}

/** The parts of a KeyboardEvent an accelerator is built from. */
export interface KeyChord { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

const NAMED_KEYS: Record<string, string> = {
  ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Enter: 'Return', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
};

/** An Electron accelerator ("Control+Shift+R") for a pressed key combination,
 *  for the Settings shortcut recorder (#299). Returns null while only
 *  modifiers are down, and for a key with no modifier other than Shift: a
 *  global shortcut takes the combination away from every other app, so a bare
 *  letter must never be accepted. Uses the physical key (`code`) for letters
 *  and digits, so Option+R records as R rather than the "®" it types. */
export function acceleratorFromEvent(event: KeyChord): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'CapsLock', 'Dead'].includes(event.key)) return null;
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return null;
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(event.code)?.[1];
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(event.key)?.[0];
  const key = letter ?? digit ?? fn ?? NAMED_KEYS[event.key]
    ?? (event.key.length === 1 && /[!-~]/.test(event.key) && event.key !== '+' ? event.key.toUpperCase() : event.key === '+' ? 'Plus' : null);
  if (!key) return null;
  return [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Command', key].filter(Boolean).join('+');
}

/** "⌃⇧R" for an accelerator, for display next to the recorder. */
export function formatAccelerator(accelerator: string): string {
  const symbols: Record<string, string> = { control: '⌃', ctrl: '⌃', alt: '⌥', option: '⌥', shift: '⇧', command: '⌘', cmd: '⌘', commandorcontrol: '⌘', cmdorctrl: '⌘', meta: '⌘', super: '⌘' };
  return accelerator.split('+').map((part) => symbols[part.trim().toLowerCase()] ?? part.trim()).join('');
}
