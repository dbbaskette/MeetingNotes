import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDb } from './db.js';
import { ActionItemsRepo } from './action-items-repo.js';
import { MeetingsRepo } from './meetings-repo.js';
import { GroupsRepo } from './groups-repo.js';
import { briefSection, resolveSpeakerLabels } from '../../shared/productivity.js';
import { organizedSections } from '../../renderer/src/lib/organized-sections.js';
let db: ReturnType<typeof openDb>, items: ActionItemsRepo, meetings: MeetingsRepo, groups: GroupsRepo;
beforeEach(() => { db = openDb(':memory:'); items = new ActionItemsRepo(db); meetings = new MeetingsRepo(db); groups = new GroupsRepo(db); });
afterEach(() => db.close());
function meeting(id: string): void { meetings.insert({ id, slug: id, title: id, audioPath: `/${id}`, startedAt: '2020-01-01', durationS: 60, status: 'done', pipelineStage: 'done' }); }
it('finds old unfinished work, filters owners/dates/groups and excludes trash/done', () => {
  meeting('old'); meeting('trash');
  const group = groups.create('Research'); groups.assign(['old'], group.id);
  items.replaceForMeeting('old', [{ text: 'Follow up', owner: 'Dan', due_date: '2020-02-01' }, { text: 'Unscheduled', owner: null, due_date: null }]);
  const first = items.listByMeeting('old')[0]!; items.update(first.id, { ownerName: 'Dan' });
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
