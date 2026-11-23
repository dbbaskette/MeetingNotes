import { describe, expect, it } from 'vitest';
import { obsidianAttention } from './obsidian-attention';

const on = { enabled: true };
describe('obsidianAttention', () => {
  it('reports nothing when sync is off, unconfigured or healthy', () => {
    expect(obsidianAttention(null)).toBeNull();
    expect(obsidianAttention({ config: null, error: 'x', issues: [1] })).toBeNull();
    expect(obsidianAttention({ config: { enabled: false }, error: 'Vault missing', issues: [1] })).toBeNull();
    expect(obsidianAttention({ config: on, error: null, issues: [] })).toBeNull();
  });
  it('reports notes paused by an external edit', () => {
    expect(obsidianAttention({ config: on, error: null, issues: [1] })).toEqual({ count: 1, message: '1 Obsidian note needs review before it can sync.' });
    expect(obsidianAttention({ config: on, error: null, issues: [1, 2, 3] })?.message).toBe('3 Obsidian notes need review before they can sync.');
  });
  it('reports a failing vault, with any paused notes', () => {
    expect(obsidianAttention({ config: on, error: 'Vault folder is unavailable', issues: [] })).toEqual({ count: 1, message: 'Obsidian sync is failing: Vault folder is unavailable' });
    expect(obsidianAttention({ config: on, error: 'Vault folder is unavailable', issues: [1, 2] })).toEqual({ count: 2, message: 'Obsidian sync is failing (Vault folder is unavailable) and 2 notes need review.' });
  });
});
