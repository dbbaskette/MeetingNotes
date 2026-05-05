import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { recoverPendingMeetings } from './recovery.js';

describe('recoverPendingMeetings', () => {
  it('rolls non-terminal meetings back to pending without auto-enqueueing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-rec-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    meetings.insert({ id: 'a', slug: 'a', title: 'A', startedAt: null, durationS: null, audioPath: '/a', status: 'processing', pipelineStage: 'transcribing' });
    meetings.insert({ id: 'b', slug: 'b', title: 'B', startedAt: null, durationS: null, audioPath: '/b', status: 'done', pipelineStage: 'done' });

    const enqueue = vi.fn();
    const logger = { info: vi.fn() };
    recoverPendingMeetings({ meetings, enqueue, logger } as any);

    // Stage rolled back to a safe re-entry point.
    expect(meetings.findById('a')?.pipelineStage).toBe('discovered');
    // Status is now 'pending' — explicit user action required to resume.
    // (Earlier behavior auto-enqueued and surprised users who had just
    // dropped a batch of files and wanted to control what ran first.)
    expect(meetings.findById('a')?.status).toBe('pending');
    expect(enqueue).not.toHaveBeenCalled();
    // Done meetings are untouched.
    expect(meetings.findById('b')?.pipelineStage).toBe('done');
    expect(meetings.findById('b')?.status).toBe('done');
  });
});
