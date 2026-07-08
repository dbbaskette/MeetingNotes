import { describe, it, expect } from 'vitest';
import { speakerColorIndex } from './speaker-colors';

const line = (speaker: string): { speaker: string } => ({ speaker });

describe('speakerColorIndex', () => {
  it('assigns indices in order of first appearance', () => {
    const map = speakerColorIndex([
      line('Alice'), line('Bob'), line('Alice'), line('Carol'), line('Bob'),
    ]);
    expect(map.get('Alice')).toBe(0);
    expect(map.get('Bob')).toBe(1);
    expect(map.get('Carol')).toBe(2);
    expect(map.size).toBe(3);
  });

  it('is stable under repeated lines from the same speaker', () => {
    const map = speakerColorIndex([
      line('SPEAKER_02'), line('SPEAKER_02'), line('SPEAKER_00'),
    ]);
    // First to speak gets index 0 even if their label sorts later.
    expect(map.get('SPEAKER_02')).toBe(0);
    expect(map.get('SPEAKER_00')).toBe(1);
  });

  it('returns an empty map for no lines', () => {
    expect(speakerColorIndex([]).size).toBe(0);
  });
});
