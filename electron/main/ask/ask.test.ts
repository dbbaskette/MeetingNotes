import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { AskIndex } from './ask-index.js';
import { NOTHING_FOUND, askMeetings, citedNumbers, type AskDeps } from './ask-service.js';

let tmp: string, db: ReturnType<typeof openDb>, index: AskIndex;
const write = (slug: string, name: string, body: string): void => {
  const folder = path.join(tmp, 'meetings', slug); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, name), body);
};
const meetings = [
  { id: 'm1', slug: 'pricing', title: 'Pricing review', startedAt: '2026-10-01T09:00:00' },
  { id: 'm2', slug: 'hiring', title: 'Hiring sync', startedAt: '2026-10-02T09:00:00' },
];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-ask-'));
  db = openDb(path.join(tmp, 'db.sqlite')); index = new AskIndex(db, tmp);
  write('pricing', 'summary.md', '## Decisions\n\nPricing stays at twenty dollars through the year.');
  write('pricing', 'transcript.md', '[Alice 00:05] I think we keep the price where it is.\n[Bob 12:30] Agreed, no pricing change until the renewal.');
  write('hiring', 'summary.md', '## Overview\n\nTwo offers went out for the platform team.');
});
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('AskIndex', () => {
  it('finds passages by stemmed words and reports where they came from', async () => {
    expect(await index.sync(meetings)).toEqual({ updated: 2, removed: 0 });
    const hits = index.search('"priced" OR "renewals"');
    expect(hits.map((hit) => [hit.meetingId, hit.kind])).toContainEqual(['m1', 'summary']);
    expect(hits.find((hit) => hit.kind === 'transcript')).toMatchObject({ meetingId: 'm1', startS: 5 });
    expect(index.search('"offers"')).toMatchObject([{ meetingId: 'm2', heading: 'Overview' }]);
  });
  it('re-reads only meetings whose files changed and drops meetings that are gone', async () => {
    await index.sync(meetings);
    expect(await index.sync(meetings)).toEqual({ updated: 0, removed: 0 });
    write('hiring', 'summary.md', '## Overview\n\nThe contractor budget was approved, with more detail.');
    expect(await index.sync(meetings)).toEqual({ updated: 1, removed: 0 });
    expect(index.search('"offers"')).toEqual([]);
    expect(index.search('"contractor"')).toHaveLength(1);
    expect(await index.sync([meetings[0]!])).toEqual({ updated: 0, removed: 1 });
    expect(index.search('"contractor"')).toEqual([]);
  });
  it('limits how many passages one meeting contributes', async () => {
    write('pricing', 'transcript.md', Array.from({ length: 30 }, (_, i) => `[Alice ${String(i).padStart(2, '0')}:00] pricing point ${i} ${'pad '.repeat(250)}`).join('\n'));
    await index.sync(meetings);
    expect(index.search('"pricing"', 10, 2).filter((hit) => hit.meetingId === 'm1')).toHaveLength(2);
  });
});

describe('askMeetings', () => {
  const deps = (chat: AskDeps['chat']): AskDeps => ({ index, meetings: () => meetings, chat, ensureReady: async () => {}, model: () => 'local', disableThinking: () => true });
  it('answers from ranked passages and returns only the cited sources', async () => {
    const chat = vi.fn(async () => 'Pricing stays at twenty dollars [1].');
    const result = await askMeetings(deps(chat), 'What did we decide about pricing?');
    const prompt = chat.mock.calls[0]![0].messages[1]!.content;
    expect(prompt).toMatch(/\[\d\] Meeting "Pricing review" on 2026-10-01 \(notes, section "Decisions"\)/);
    expect(prompt).toMatch(/\[\d\] Meeting "Pricing review" on 2026-10-01 \(transcript\)/);
    expect(prompt).toContain('Question: What did we decide about pricing?');
    expect(result).toMatchObject({ found: true, answer: 'Pricing stays at twenty dollars [1].' });
    expect(result.sources).toMatchObject([{ n: 1, meetingId: 'm1', title: 'Pricing review' }]);
  });
  it('does not call the model when nothing in the library matches', async () => {
    const chat = vi.fn(async () => 'should not be asked');
    expect(await askMeetings(deps(chat), 'What about the zeppelin?')).toEqual({ answer: NOTHING_FOUND, sources: [], found: false });
    expect(await askMeetings(deps(chat), 'what did they say')).toMatchObject({ found: false });
    expect(chat).not.toHaveBeenCalled();
  });
  it('treats an uncited or declined answer as not found', async () => {
    expect(await askMeetings(deps(async () => NOTHING_FOUND), 'pricing?')).toMatchObject({ found: false, sources: [] });
    expect(await askMeetings(deps(async () => 'Probably twenty dollars.'), 'pricing?')).toMatchObject({ found: false, sources: [] });
  });
  it('reads citation numbers in first-use order and ignores out-of-range ones', () => {
    expect(citedNumbers('A [2], then [1][2] and [9].', 3)).toEqual([2, 1]);
  });
});
