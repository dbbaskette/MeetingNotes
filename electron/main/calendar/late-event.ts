// electron/main/calendar/late-event.ts
//
// Calendar-aware recording (#253). The lookup runs alongside capture, so it
// can finish after the recording was stopped and its meeting cataloged. The
// session row already holds the event (and the title, when one was applied),
// so a meeting cataloged later picks both up there. This covers the meeting
// that already exists.
import type { MeetingsRepo } from '../storage/meetings-repo.js';
import { parseAudioHijackFilename } from '../lib/title-from-filename.js';
import type { CalendarEventSnapshot } from './service.js';

export function attachLateCalendarEvent(
  meetings: Pick<MeetingsRepo, 'findByAudioPath' | 'setCalendarEvent' | 'updateTitle'>,
  info: { outputPath: string; event: CalendarEventSnapshot; title: string | null },
): void {
  const meeting = meetings.findByAudioPath(info.outputPath);
  if (!meeting) return;
  meetings.setCalendarEvent(meeting.id, info.event);
  // Only replace the automatic title the catalog gave it: a rename by the
  // user (or any other title) in the meantime wins.
  if (info.title && !meeting.titleExplicit && meeting.title === parseAudioHijackFilename(info.outputPath).autoTitle) {
    meetings.updateTitle(meeting.id, info.title, true);
  }
}
