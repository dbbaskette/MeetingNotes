import { describe, expect, it, vi } from 'vitest';
import { catalogAudio } from './catalog.js';
import type { MeetingInsert, MeetingsRepo } from '../storage/meetings-repo.js';

describe('catalogAudio', () => {
  it('catalogs simultaneous watcher and Stop probes exactly once', async () => {
    const rows = new Map<string, MeetingInsert>();
    const insert = vi.fn((row: MeetingInsert) => rows.set(row.audioPath, row));
    const createFolder = vi.fn();
    const deps = { meetings: { findByAudioPath: (file: string) => rows.get(file) ?? null, insert } as unknown as MeetingsRepo,
      libraryRoot: '/library', probe: async () => ({ durationS: 8 }), createFolder, id: () => 'one' };
    const result = await Promise.all([catalogAudio('/synthetic/mic-only.m4a', deps), catalogAudio('/synthetic/mic-only.m4a', deps)]);
    expect(result.map(row => row.kind)).toEqual(['added', 'existing']);
    expect(insert).toHaveBeenCalledOnce(); expect(createFolder).toHaveBeenCalledOnce();
  });
  it('creates one pending meeting and returns the existing row on retry', async () => {
    const rows = new Map<string, MeetingInsert>();
    const meetings = {
      findByAudioPath: vi.fn((audioPath: string) => rows.get(audioPath) ?? null),
      insert: vi.fn((row: MeetingInsert) => rows.set(row.audioPath, row)),
    };
    const createFolder = vi.fn();
    const deps = {
      meetings: meetings as unknown as MeetingsRepo,
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

  it('files a recovered capture under its original session group, even when discovered by the watcher first', async () => {
    const rows = new Map<string, MeetingInsert>();
    const groupId = 'e0db3539-78e0-4d71-bb8c-1d622b67bd0b';
    const original = '/recordings/recording-20260924-120000-xyz.m4a';
    const recovered = '/recordings/recording-20260924-120000-xyz.recovered-trimmed-123e4567-e89b-12d3-a456-426614174000.m4a';
    const findByOutputPath = vi.fn((audioPath: string) => audioPath === original ? { groupId } : null);
    const deps = {
      meetings: { findByAudioPath: (audioPath: string) => rows.get(audioPath) ?? null,
        insert: (row: MeetingInsert) => rows.set(row.audioPath, row) } as unknown as MeetingsRepo,
      sessions: { findByOutputPath } as unknown as NonNullable<Parameters<typeof catalogAudio>[1]['sessions']>,
      libraryRoot: '/library', probe: vi.fn(async () => ({ durationS: 30 })),
      createFolder: vi.fn(), id: () => 'abc2',
    };
    const first = await catalogAudio(recovered, deps);
    const retry = await catalogAudio(recovered, deps);
    expect(first.meeting).toMatchObject({ groupId });
    expect(retry.kind).toBe('existing');
    expect(deps.createFolder).toHaveBeenCalledTimes(1);
    expect(findByOutputPath).toHaveBeenCalledWith(original);
  });
});
