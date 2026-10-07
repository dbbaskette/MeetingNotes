import type { MeetingFilter } from './paged-meetings';
const key = 'libraryBrowseScope';
export function readBrowsePreferences(): { filter: MeetingFilter; groupId?: string | null } {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '{}') as {
      filter?: unknown;
      groupId?: unknown;
    };
    const filter = ['all', 'pending', 'processing', 'done', 'failed'].includes(String(raw.filter))
      ? (raw.filter as MeetingFilter)
      : 'all';
    const groupId =
      raw.groupId === null
        ? null
        : typeof raw.groupId === 'string' && /^[0-9a-f-]{36}$/i.test(raw.groupId)
          ? raw.groupId
          : undefined;
    return { filter, groupId };
  } catch {
    return { filter: 'all' };
  }
}
export function saveBrowsePreferences(
  filter: MeetingFilter,
  groupId: string | null | undefined,
): void {
  try {
    localStorage.setItem(key, JSON.stringify({ filter, groupId }));
  } catch {
    /* session navigation still retains context */
  }
}
