import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { ActionItemsRepo } from '../storage/action-items-repo.js';
import { searchScope } from '../search/facets.js';
import type { SearchFacets } from '../../shared/search.js';
import { askEndpoint, describeAskScope, facetCandidates, facetsNarrowMeetings } from './ask-scope.js';

describe('facetCandidates', () => {
  let tmp: string, db: ReturnType<typeof openDb>, meetings: MeetingsRepo;
  const me = { id: null, name: 'Dan' };
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-ask-scope-'));
    db = openDb(path.join(tmp, 'db.sqlite'));
    meetings = new MeetingsRepo(db);
    const add = (id: string, startedAt: string, status: string): void => meetings.insert({
      id, slug: `slug-${id}`, title: `Meeting ${id}`, startedAt, durationS: 60, audioPath: `/audio/${id}.m4a`, status, pipelineStage: status === 'done' ? 'done' : 'queued',
    } as Parameters<MeetingsRepo['insert']>[0]);
    add('a', '2026-10-05T12:00:00Z', 'done');
    add('b', '2026-10-07T12:00:00Z', 'failed');
    add('c', '2026-10-14T12:00:00Z', 'done');
    add('gone', '2026-10-06T12:00:00Z', 'done');
    meetings.softDelete('gone');
    new ActionItemsRepo(db).create('c', { text: 'Send the plan', ownerName: 'Dan' });
  });
  afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  // What ⌘K search lists for the same facets (an empty title query matches
  // every title), so Ask and search cannot disagree about which meetings count.
  const searchIds = (facets: SearchFacets): string[] =>
    meetings.facetedSearch().titles('', 100, searchScope(facets, undefined, me)).map((row) => row.id).sort();

  it.each<SearchFacets>([
    { week: '2026-W41' },
    { status: 'done' },
    { from: '2026-10-06', to: '2026-10-31' },
    { actions: 'mine' },
    { week: '2026-W41', status: 'failed' },
  ])('allows exactly the meetings search allows for %j', (facets) => {
    const ids = facetCandidates(facets, meetings.listAll(), meetings.facetedSearch(), me)!;
    expect(ids.sort()).toEqual(searchIds(facets));
    expect(ids).not.toContain('gone');
  });

  it('leaves the library unrestricted when no facet narrows meetings', () => {
    expect(facetCandidates({}, meetings.listAll(), meetings.facetedSearch(), me)).toBeUndefined();
    expect(facetCandidates({ content: 'transcript' }, meetings.listAll(), meetings.facetedSearch(), me)).toBeUndefined();
    expect(facetsNarrowMeetings({ warning: false })).toBe(false);
    expect(facetsNarrowMeetings({ speakerId: 's1' })).toBe(true);
  });
});

describe('describeAskScope', () => {
  it('names the filters and the meeting count', () => {
    expect(describeAskScope({ week: '2026-W46', speakerId: 's1', status: 'done' }, 12, 'Alice'))
      .toBe('Asked across 12 meetings in week 2026-W46, with Alice, processed');
    expect(describeAskScope({ from: '2026-10-01' }, 1, null)).toBe('Asked across 1 meeting since 2026-10-01');
    expect(describeAskScope({ content: 'summary' }, 40, null)).toBe('Asked across 40 meetings notes only');
    expect(describeAskScope({}, 40, null)).toBeNull();
  });
});

describe('askEndpoint', () => {
  it('treats the managed runtimes as this Mac whatever the external URL says', () => {
    expect(askEndpoint('lm-studio', 'https://user:secret@api.example.com/v1')).toEqual({ local: true });
    expect(askEndpoint('ollama', '')).toEqual({ local: true });
  });
  it.each(['http://localhost:1234', 'http://127.0.0.1:8080/v1', 'http://[::1]:1234', 'http://LOCALHOST'])('treats %s as this Mac', (url) => {
    expect(askEndpoint('external', url)).toEqual({ local: true });
  });
  it('names only the host of a remote endpoint, never credentials, path or query', () => {
    const endpoint = askEndpoint('external', 'https://alice:s3cret@llm.example.com:8443/v1/chat?key=abc123');
    expect(endpoint).toEqual({ local: false, host: 'llm.example.com:8443' });
    expect(JSON.stringify(endpoint)).not.toMatch(/alice|s3cret|abc123|\/v1/);
    expect(askEndpoint('external', 'https://192.168.1.20/v1')).toEqual({ local: false, host: '192.168.1.20' });
  });
  it('does not call an unparseable URL local', () => {
    expect(askEndpoint('external', 'not a url')).toEqual({ local: false, host: 'the endpoint set in Settings' });
  });
});
