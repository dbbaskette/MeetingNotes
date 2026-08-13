import { describe, expect, it, vi } from 'vitest';
import { catalogAudio } from './catalog.js';

describe('catalogAudio', () => {
  it('creates one pending meeting and returns the existing row on retry', async () => {
    const rows = new Map<string, any>();
    const meetings = {
      findByAudioPath: vi.fn((audioPath: string) => rows.get(audioPath) ?? null),
      insert: vi.fn((row: any) => rows.set(row.audioPath, row)),
    } as any;
    const createFolder = vi.fn();
    const deps = {
      meetings,
      libraryRoot: '/library',
      probe: vi.fn(async () => ({ durationS: 83 })),
      createFolder,
      id: () => 'abc1',
    };

    const first = await catalogAudio('/recordings/recording-20260812-141500-xyz.m4a', deps);
    const second = await catalogAudio('/recordings/recording-20260812-141500-xyz.m4a', deps);

    expect(first.kind).toBe('added');
    expect(first.meeting.status).toBe('pending');
    expect(first.meeting.durationS).toBe(83);
    expect(second.kind).toBe('existing');
    expect(meetings.insert).toHaveBeenCalledTimes(1);
    expect(createFolder).toHaveBeenCalledTimes(1);
  });
});
