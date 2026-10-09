// electron/main/menu-bar/shortcut.ts
//
// A user-chosen global shortcut that starts or stops recording from any app
// (#253). Unset by default: a global shortcut takes the key combination away
// from every other app, so the user picks one deliberately.

/** The subset of Electron's globalShortcut used here; injected for tests. */
export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** Requires at least one modifier and one key, so a bare letter can never be
 *  captured system-wide. Mirrors Electron's accelerator grammar loosely; the
 *  registry has the final say. */
export function isPlausibleAccelerator(value: string): boolean {
  const parts = value.split('+').map((part) => part.trim());
  if (parts.length < 2 || parts.some((part) => part === '')) return false;
  const modifiers = /^(Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)$/i;
  const key = parts[parts.length - 1]!;
  return parts.slice(0, -1).every((part) => modifiers.test(part)) && !modifiers.test(key) && key.length <= 12;
}

export class RecordShortcut {
  private current = '';
  constructor(private readonly registry: ShortcutRegistry, private readonly onToggle: () => void) {}

  get accelerator(): string { return this.current; }

  /** Replaces the registered shortcut. An empty string clears it. Throws,
   *  leaving the previous shortcut in place, when the new one is malformed or
   *  already taken by another app. */
  apply(accelerator: string): void {
    const next = accelerator.trim();
    if (next === this.current) return;
    if (next === '') { this.clear(); return; }
    if (!isPlausibleAccelerator(next)) throw new Error('Use a modifier and a key, for example Control+Shift+R');
    let registered = false;
    try { registered = this.registry.register(next, this.onToggle); } catch { registered = false; }
    if (!registered) throw new Error(`${next} could not be registered. It may already be in use by macOS or another app, or name a key that does not exist.`);
    const previous = this.current;
    this.current = next;
    if (previous) this.registry.unregister(previous);
  }

  clear(): void {
    if (this.current) this.registry.unregister(this.current);
    this.current = '';
  }
}
