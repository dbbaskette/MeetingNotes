import { describe, it, expect, vi } from 'vitest';
import { RecordShortcut, isPlausibleAccelerator, type ShortcutRegistry } from './shortcut.js';

function registry(taken: string[] = []) {
  const active = new Map<string, () => void>();
  const reg: ShortcutRegistry = {
    register: (accelerator, callback) => { if (taken.includes(accelerator)) return false; active.set(accelerator, callback); return true; },
    unregister: (accelerator) => { active.delete(accelerator); },
  };
  return { reg, active };
}

describe('isPlausibleAccelerator', () => {
  it('requires a modifier and a key', () => {
    expect(isPlausibleAccelerator('Control+Shift+R')).toBe(true);
    expect(isPlausibleAccelerator('CommandOrControl+Alt+F9')).toBe(true);
    expect(isPlausibleAccelerator('R')).toBe(false);
    expect(isPlausibleAccelerator('Shift+')).toBe(false);
    expect(isPlausibleAccelerator('Control+Shift')).toBe(false);
    expect(isPlausibleAccelerator('Hyper+R')).toBe(false);
  });
});

describe('RecordShortcut', () => {
  it('registers, fires and clears', () => {
    const { reg, active } = registry();
    const toggle = vi.fn();
    const shortcut = new RecordShortcut(reg, toggle);
    shortcut.apply('Control+Shift+R');
    expect(shortcut.accelerator).toBe('Control+Shift+R');
    active.get('Control+Shift+R')!();
    expect(toggle).toHaveBeenCalledTimes(1);
    shortcut.apply('');
    expect(active.size).toBe(0);
    expect(shortcut.accelerator).toBe('');
  });

  it('replaces the previous shortcut only after the new one registers', () => {
    const { reg, active } = registry();
    const shortcut = new RecordShortcut(reg, vi.fn());
    shortcut.apply('Control+Shift+R');
    shortcut.apply('Control+Alt+M');
    expect([...active.keys()]).toEqual(['Control+Alt+M']);
  });

  it('keeps the old shortcut when the new one is taken or malformed', () => {
    const { reg, active } = registry(['Command+Space']);
    const shortcut = new RecordShortcut(reg, vi.fn());
    shortcut.apply('Control+Shift+R');
    expect(() => shortcut.apply('Command+Space')).toThrow(/could not be registered/);
    expect(() => shortcut.apply('R')).toThrow(/modifier and a key/);
    expect(shortcut.accelerator).toBe('Control+Shift+R');
    expect([...active.keys()]).toEqual(['Control+Shift+R']);
  });

  it('treats a registry that throws as unavailable', () => {
    const shortcut = new RecordShortcut({ register: () => { throw new Error('bad accelerator'); }, unregister: vi.fn() }, vi.fn());
    expect(() => shortcut.apply('Control+Shift+R')).toThrow(/could not be registered/);
  });
});
