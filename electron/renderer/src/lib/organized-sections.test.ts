import { describe, expect, it } from 'vitest';
import { groupSearchMeetings, organizedSections, readExpandedSections, UNGROUPED_SECTION_KEY } from './organized-sections';
import type { MeetingSummary } from './paged-meetings';

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const groups = [{ id: second, name: 'Zeta', count: 2 }, { id: first, name: 'Alpha', count: 1 }];
const summary = (id: string, groupId: string | null): MeetingSummary => ({
  id, slug: id, title: id, groupId, groupName: null, startedAt: null, durationS: null,
  pipelineStage: 'done', status: 'done', errorMessage: null, stageStartedAt: null,
  skipSpeakerId: false, unidentifiedCount: 0, actionItemsCount: 0,
  stageEtaMs: null, stageEtaRough: false, speakers: [],
});

describe('organized Library sections', () => {
  it('keeps named groups alphabetic and Ungrouped last', () => {
    expect(organizedSections(groups, 3).map((section) => section.name))
      .toEqual(['Alpha', 'Zeta', 'Ungrouped']);
  });

  it('places each search result exactly once, including stale group references', () => {
    const sections = organizedSections(groups, 1);
    const buckets = groupSearchMeetings(sections, [summary('a', first), summary('a', first),
      summary('b', second), summary('c', null), summary('d', 'deleted-group')]);
    expect(buckets.get(first)?.map((meeting) => meeting.id)).toEqual(['a']);
    expect(buckets.get(second)?.map((meeting) => meeting.id)).toEqual(['b']);
    expect(buckets.get(UNGROUPED_SECTION_KEY)?.map((meeting) => meeting.id)).toEqual(['c', 'd']);
  });

  it('defaults to Ungrouped expanded and rejects corrupt stored preferences', () => {
    expect([...readExpandedSections(null)]).toEqual([UNGROUPED_SECTION_KEY]);
    expect([...readExpandedSections('not json')]).toEqual([UNGROUPED_SECTION_KEY]);
    expect([...readExpandedSections(JSON.stringify([first, 'bad', UNGROUPED_SECTION_KEY]))])
      .toEqual([first, UNGROUPED_SECTION_KEY]);
  });
});
