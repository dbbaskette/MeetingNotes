// electron/main/speakers/calendar-candidates.ts
//
// Calendar-aware recording (#253): the attendees of the event a meeting was
// recorded in, offered as names when the user names a voice. These are only
// suggestions. Nothing here links a voice to anyone; the user picks.

export interface CalendarCandidate {
  /** Attendee display name from the calendar invite. */
  displayName: string;
  /** Saved speaker with the same name, if any: picking it reuses that
   *  speaker instead of creating a duplicate. */
  rosterId: string | null;
}

const key = (name: string): string => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/** Attendee names not already given to a voice in this meeting, matched to
 *  saved speakers by name (case and spacing ignored). */
export function calendarCandidates(input: {
  attendees: readonly string[];
  roster: readonly { id: string; displayName: string }[];
  linkedRosterIds: readonly (string | null)[];
}): CalendarCandidate[] {
  const byName = new Map(input.roster.map(r => [key(r.displayName), r.id] as const));
  const linked = new Set(input.linkedRosterIds.filter((id): id is string => !!id));
  const linkedNames = new Set(input.roster.filter(r => linked.has(r.id)).map(r => key(r.displayName)));
  const seen = new Set<string>();
  const out: CalendarCandidate[] = [];
  for (const attendee of input.attendees) {
    const k = key(attendee);
    if (!k || k.includes('@') || seen.has(k) || linkedNames.has(k)) continue;
    seen.add(k);
    out.push({ displayName: attendee.trim().replace(/\s+/g, ' '), rosterId: byName.get(k) ?? null });
  }
  return out;
}
