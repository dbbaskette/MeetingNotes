import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { recoverPendingMeetings } from './recovery.js';

describe('recoverPendingMeetings', () => {
  it('rolls non-terminal meetings back one stage and enqueues them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-rec-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    meetings.insert({ id: 'a', slug: 'a', title: 'A', startedAt: null, durationS: null, audioPath: '/a', status: 'processing', pipelineStage: 'transcribing' });
    meetings.insert({ id: 'b', slug: 'b', title: 'B', startedAt: null, durationS: null, audioPath: '/b', status: 'done', pipelineStage: 'done' });

    const enqueue = vi.fn();
    const logger = { info: vi.fn() };
    recoverPendingMeetings({ meetings, enqueue, logger } as any);

    expect(meetings.findById('a')?.pipelineStage).toBe('discovered');
    expect(enqueue).toHaveBeenCalledWith('a');
    expect(enqueue).not.toHaveBeenCalledWith('b');
  });
});
