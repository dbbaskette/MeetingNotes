import { describe, expect, it } from 'vitest';
import { nextMenuIndex } from './menu-keyboard.js';

describe('nextMenuIndex', () => {
  it('moves down and up, wrapping at both ends', () => {
    expect(nextMenuIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextMenuIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextMenuIndex('ArrowUp', 0, 3)).toBe(2);
    expect(nextMenuIndex('ArrowUp', 2, 3)).toBe(1);
  });
  it('enters the menu from the right end when nothing is focused', () => {
    expect(nextMenuIndex('ArrowDown', -1, 3)).toBe(0);
    expect(nextMenuIndex('ArrowUp', -1, 3)).toBe(2);
  });
  it('jumps with Home and End', () => {
    expect(nextMenuIndex('Home', 2, 3)).toBe(0);
    expect(nextMenuIndex('End', 0, 3)).toBe(2);
  });
  it('ignores other keys and empty menus', () => {
    expect(nextMenuIndex('Enter', 0, 3)).toBeNull();
    expect(nextMenuIndex('a', 0, 3)).toBeNull();
    expect(nextMenuIndex('ArrowDown', -1, 0)).toBeNull();
  });
});
