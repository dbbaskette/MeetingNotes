import type { MeetingSummary } from './paged-meetings';

export const UNGROUPED_SECTION_KEY = 'ungrouped';

export interface OrganizedSection {
  key: string;
  groupId: string | null;
  name: string;
  count: number;
}

export function sectionKey(groupId: string | null): string {
  return groupId ?? UNGROUPED_SECTION_KEY;
}

export function organizedSections(
  groups: readonly { id: string; name: string; count: number }[],
  ungroupedCount: number,
): OrganizedSection[] {
  return [
    ...[...groups].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map((group) => ({ key: group.id, groupId: group.id, name: group.name, count: group.count })),
    { key: UNGROUPED_SECTION_KEY, groupId: null, name: 'Ungrouped', count: ungroupedCount },
  ];
}

/** Each search result has one home, even when both its title and content hit.
 * A stale group reference is displayed under Ungrouped until the next sync. */
export function groupSearchMeetings(
  sections: readonly OrganizedSection[],
  meetings: readonly MeetingSummary[],
): Map<string, MeetingSummary[]> {
  const known = new Set(sections.map((section) => section.key));
  const buckets = new Map(sections.map((section) => [section.key, [] as MeetingSummary[]]));
  const seen = new Set<string>();
  for (const meeting of meetings) {
    if (seen.has(meeting.id)) continue;
    seen.add(meeting.id);
    const key = sectionKey(meeting.groupId);
    buckets.get(known.has(key) ? key : UNGROUPED_SECTION_KEY)?.push(meeting);
  }
  return buckets;
}

export function readExpandedSections(raw: string | null): Set<string> {
  if (raw === null) return new Set([UNGROUPED_SECTION_KEY]);
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return new Set([UNGROUPED_SECTION_KEY]);
    return new Set(value.filter((item): item is string =>
      typeof item === 'string' && (item === UNGROUPED_SECTION_KEY || /^[0-9a-f-]{36}$/i.test(item))));
  } catch { return new Set([UNGROUPED_SECTION_KEY]); }
}
