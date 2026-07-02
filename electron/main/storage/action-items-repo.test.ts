import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { MeetingsRepo } from './meetings-repo.js';
import { ActionItemsRepo } from './action-items-repo.js';

let repo: ActionItemsRepo;
let meetings: MeetingsRepo;
let meetingId: string;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-ai-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  meetings = new MeetingsRepo(db);
  repo = new ActionItemsRepo(db);
  meetingId = 'm1';
  meetings.insert({ id: meetingId, slug: 's', title: 't', startedAt: null, durationS: null, audioPath: '/a', status: 'done', pipelineStage: 'done' });
});

describe('ActionItemsRepo', () => {
  it('replace + listByMeeting', () => {
    repo.replaceForMeeting(meetingId, [
      { text: 'a', owner: null, due_date: null },
      { text: 'b', owner: 'Dan', due_date: '2026-04-22' },
    ]);
    const all = repo.listByMeeting(meetingId);
    expect(all).toHaveLength(2);
    expect(all[0]!.text).toBe('a');
  });

  it('setStatus', () => {
    repo.replaceForMeeting(meetingId, [{ text: 'x', owner: null, due_date: null }]);
    const [item] = repo.listByMeeting(meetingId);
    repo.setStatus(item!.id, 'done');
    expect(repo.listByMeeting(meetingId)[0]!.status).toBe('done');
  });

  it('markExported appends to exported_to JSON', () => {
    repo.replaceForMeeting(meetingId, [{ text: 'x', owner: null, due_date: null }]);
    const [item] = repo.listByMeeting(meetingId);
    repo.markExported(item!.id, 'reminders');
    expect(repo.listByMeeting(meetingId)[0]!.exportedTo).toEqual(['reminders']);
  });

  it('round-trips source_quote through replaceForMeeting + listByMeeting', () => {
    repo.replaceForMeeting(meetingId, [
      { text: 'Ship v2', owner: 'Dan', due_date: null, sourceQuote: '- Ship the v2 API — Dan' },
      { text: 'No source', owner: null, due_date: null },
    ]);
    const all = repo.listByMeeting(meetingId);
    expect(all[0]!.sourceQuote).toBe('- Ship the v2 API — Dan');
    // An item with no sourceQuote (hand-added shape) reads back null.
    expect(all[1]!.sourceQuote).toBeNull();
  });

  it('create() leaves source_quote null', () => {
    const created = repo.create(meetingId, { text: 'hand-added' });
    expect(created.sourceQuote).toBeNull();
    expect(repo.listByMeeting(meetingId)[0]!.sourceQuote).toBeNull();
  });
});
