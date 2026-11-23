import { describe, expect, it } from 'vitest';
import { acceleratorFromEvent, formatAccelerator, type KeyChord } from './shortcut';
import { isPlausibleAccelerator } from '../../../main/menu-bar/shortcut.js';

const chord = (patch: Partial<KeyChord>): KeyChord => ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...patch });

describe('acceleratorFromEvent', () => {
  it('builds an accelerator from modifiers and a key', () => {
    expect(acceleratorFromEvent(chord({ key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true }))).toBe('Control+Shift+R');
    expect(acceleratorFromEvent(chord({ key: 'F9', code: 'F9', metaKey: true, altKey: true }))).toBe('Alt+Command+F9');
    expect(acceleratorFromEvent(chord({ key: ' ', code: 'Space', ctrlKey: true }))).toBe('Control+Space');
    expect(acceleratorFromEvent(chord({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true }))).toBe('Command+Up');
  });
  it('records the physical key, not the character Option produces', () => {
    expect(acceleratorFromEvent(chord({ key: '®', code: 'KeyR', altKey: true }))).toBe('Alt+R');
    expect(acceleratorFromEvent(chord({ key: '¡', code: 'Digit1', altKey: true, metaKey: true }))).toBe('Alt+Command+1');
  });
  it('waits while only modifiers are held', () => {
    expect(acceleratorFromEvent(chord({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBeNull();
    expect(acceleratorFromEvent(chord({ key: 'Meta', code: 'MetaLeft', metaKey: true }))).toBeNull();
  });
  it('refuses a key with no modifier, or with Shift alone', () => {
    expect(acceleratorFromEvent(chord({ key: 'r', code: 'KeyR' }))).toBeNull();
    expect(acceleratorFromEvent(chord({ key: 'R', code: 'KeyR', shiftKey: true }))).toBeNull();
  });
  it('only produces accelerators the main process accepts', () => {
    for (const event of [
      chord({ key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true }), chord({ key: 'F12', code: 'F12', altKey: true }),
      chord({ key: ' ', code: 'Space', metaKey: true, shiftKey: true }), chord({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }),
      chord({ key: ',', code: 'Comma', metaKey: true, altKey: true }),
    ]) expect(isPlausibleAccelerator(acceleratorFromEvent(event)!)).toBe(true);
  });
});

describe('formatAccelerator', () => {
  it('shows macOS modifier symbols', () => {
    expect(formatAccelerator('Control+Shift+R')).toBe('⌃⇧R');
    expect(formatAccelerator('Alt+Command+F9')).toBe('⌥⌘F9');
  });
});
