import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDb } from './db.js';
import { ActionItemsRepo } from './action-items-repo.js';
import { MeetingsRepo } from './meetings-repo.js';
import { GroupsRepo } from './groups-repo.js';
import { briefPrepSections, briefSection, groupBriefMarkdown, resolveSpeakerLabels } from '../../shared/productivity.js';
import { organizedSections } from '../../renderer/src/lib/organized-sections.js';
let db: ReturnType<typeof openDb>, items: ActionItemsRepo, meetings: MeetingsRepo, groups: GroupsRepo;
beforeEach(() => { db = openDb(':memory:'); items = new ActionItemsRepo(db); meetings = new MeetingsRepo(db); groups = new GroupsRepo(db); });
afterEach(() => db.close());
function meeting(id: string): void { meetings.insert({ id, slug: id, title: id, audioPath: `/${id}`, startedAt: '2020-01-01', durationS: 60, status: 'done', pipelineStage: 'done' }); }
it('finds old unfinished work, filters owners/dates/groups and excludes trash/done', () => {
  meeting('old'); meeting('trash');
  const group = groups.create('Research'); groups.assign(['old'], group.id);
  items.replaceForMeeting('old', [{ text: 'Follow up', owner: 'Dan', due_date: '2020-02-01' }, { text: 'Unscheduled', owner: null, due_date: null }]);
  const first = items.listByMeeting('old')[0]!;
  items.replaceForMeeting('trash', [{ text: 'Deleted meeting', owner: null, due_date: null }]); meetings.softDelete('trash');
  expect(items.live({ owner: 'mine', due: 'overdue', groupId: group.id }, { id: null, name: 'Dan' }).items.map(item => item.id)).toEqual([first.id]);
  expect(items.live({ owner: 'all', due: 'undated' }, { id: null, name: null }).total).toBe(1);
  items.setStatus(first.id, 'done'); expect(items.live({ owner: 'mine' }, { id: null, name: 'Dan' }).total).toBe(0);
});
it('keeps ungrouped first, then persisted pins, and limits preparation to five completed meetings', () => {
  const a = groups.create('Alpha'), z = groups.create('Zebra'); groups.pin(z.id, true);
  expect(organizedSections(groups.list(), 0).map(group => group.name)).toEqual(['Ungrouped', 'Zebra', 'Alpha']);
  expect(new GroupsRepo(db).list()[0]?.pinned).toBe(true);
  for (let i = 0; i < 8; i++) { meeting(`m${i}`); groups.assign([`m${i}`], a.id); }
  meetings.updateStatus('m7', 'processing'); meetings.softDelete('m6');
  expect(groups.recentMeetings(a.id)).toHaveLength(5);
  expect(groups.recentMeetings(a.id).map(row => row.id)).not.toContain('m7');
});
it('resolves only exact speaker labels and never substitutes an existing human name', () => {
  expect(resolveSpeakerLabels('SPEAKER_01, SPEAKER_010 and Dan; XSPEAKER_01', { SPEAKER_01: 'Dana' })).toBe('Dana, SPEAKER_010 and Dan; XSPEAKER_01');
  expect(briefSection('## Decisions\n- Keep it\n## Open Questions\n- When?', 'Decisions')).toEqual(['Keep it']);
});
it('filters open actions to meetings in no group', () => {
  meeting('grouped'); meeting('loose');
  const group = groups.create('Team'); groups.assign(['grouped'], group.id);
  items.replaceForMeeting('grouped', [{ text: 'In a group', owner: null, due_date: null }]);
  items.replaceForMeeting('loose', [{ text: 'Ungrouped task', owner: null, due_date: null }]);
  expect(items.live({ owner: 'all', ungrouped: true }, { id: null, name: null }).items.map(item => item.text)).toEqual(['Ungrouped task']);
  expect(items.live({ owner: 'all', groupId: group.id }, { id: null, name: null }).items.map(item => item.text)).toEqual(['In a group']);
  expect(items.live({ owner: 'all' }, { id: null, name: null }).total).toBe(2);
});
it('carries 1:1 and standup prep sections into the group brief, and only when present', () => {
  const oneOnOne = '## Updates\n- Shipped\n## Topics for Next Time\n- Career plan\n- Hiring\n## Open Questions\n- Budget?';
  expect(briefPrepSections(oneOnOne)).toEqual([{ heading: 'Topics for Next Time', items: ['Career plan', 'Hiring'] }]);
  expect(briefPrepSections('## Progress\n- Done\n## Planned Next\n- Tests\n## Blockers\n- CI is down').map(section => section.heading)).toEqual(['Blockers', 'Planned Next']);
  expect(briefPrepSections('## Overview\nNothing forward-looking')).toEqual([]);
});
it('renders a group brief as Markdown', () => {
  const markdown = groupBriefMarkdown('Research', { openActionCount: 1,
    actions: [{ id: 'a', meetingId: 'm', meetingTitle: 'Sync', text: 'Send plan', ownerName: 'Dan', dueDate: '2026-12-01', groupName: 'Research', processing: false }],
    meetings: [{ id: 'm', title: 'Sync', startedAt: '2026-11-20T10:00:00', decisions: ['Ship it'], questions: [], overview: 'We agreed.', missingNotes: false,
      prep: [{ heading: 'Topics for Next Time', items: ['Roadmap'] }] }] });
  expect(markdown).toContain('# Prepare: Research');
  expect(markdown).toContain('- [ ] Send plan (Dan, due 2026-12-01)');
  expect(markdown).toContain('### Decisions\n- Ship it');
  expect(markdown).toContain('### Topics for Next Time\n- Roadmap');
  expect(markdown).not.toContain('### Open questions');
});
