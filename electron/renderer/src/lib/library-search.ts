import type { SearchHit } from '../components/SearchMatches';
import type { MeetingCounts, MeetingFilter, MeetingSummary } from './paged-meetings';
import { hydrateMeetingIds } from './meeting-hydration';

export const LIBRARY_SEARCH_LIMIT = 100;

/** Search is global and independent of loaded browse pages. Commit hits and
 * hydrated rows together so sections/counts never see a partial result set. */
export async function hydrateLibrarySearch(query: string, api: {
  query: (query: string, limit: number) => Promise<SearchHit[]>;
  getMany: (ids: string[]) => Promise<MeetingSummary[]>;
}): Promise<{ hits: SearchHit[]; meetings: MeetingSummary[] }> {
  const hits = await api.query(query.trim(), LIBRARY_SEARCH_LIMIT);
  const meetings = await hydrateMeetingIds(hits.map((hit) => hit.meetingId), api.getMany);
  return { hits, meetings };
}

export function groupLibrarySearch(
  hits: SearchHit[], meetings: MeetingSummary[], filter: MeetingFilter,
  contentSort: 'recent' | 'count',
) {
  const hitsByMeeting = new Map<string, SearchHit[]>();
  const titleIds = new Set<string>();
  for (const hit of hits) {
    const group = hitsByMeeting.get(hit.meetingId);
    if (group) group.push(hit);
    else hitsByMeeting.set(hit.meetingId, [hit]);
    if (hit.source === 'title') titleIds.add(hit.meetingId);
  }
  const byId = new Map(meetings.map((meeting) => [meeting.id, meeting]));
  const titleMatches: MeetingSummary[] = [];
  const contentMatches: MeetingSummary[] = [];
  const counts: MeetingCounts = { all: 0, pending: 0, processing: 0, done: 0, failed: 0 };
  // Map iteration preserves the first hit's position, including a content
  // hit preceding a title hit for the same meeting (Title still wins).
  for (const id of hitsByMeeting.keys()) {
    const meeting = byId.get(id);
    if (!meeting) continue;
    counts.all++;
    const status = meeting.status === 'awaiting_user' ? 'processing' : meeting.status;
    if (status === 'pending' || status === 'processing' || status === 'done' || status === 'failed') counts[status]++;
    if (filter !== 'all' && status !== filter) continue;
    (titleIds.has(id) ? titleMatches : contentMatches).push(meeting);
  }
  const hitCount = (id: string): number => hitsByMeeting.get(id)!.filter((hit) => hit.source !== 'title').length;
  contentMatches.sort((a, b) => {
    const date = (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
    const count = hitCount(b.id) - hitCount(a.id);
    return contentSort === 'count' ? count || date : date || count;
  });
  return { hitsByMeeting, titleMatches, contentMatches, counts };
}
