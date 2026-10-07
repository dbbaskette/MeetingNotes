import type Database from 'better-sqlite3';
import type { SearchFacets } from '../../shared/search.js';
import { isoWeekRange } from '../../shared/local-week.js';
export { FacetsSchema } from '../../shared/search-facets.js';
export function searchScope(
  f: SearchFacets,
  groupId: string | null | undefined,
  me: { id: string | null; name: string | null },
): { sql: string; params: Record<string, string | number | null> } {
  const conditions = ['m.deleted_at IS NULL'],
    params: Record<string, string | number | null> = {};
  if (groupId !== undefined) {
    conditions.push('m.group_id IS @groupId');
    params.groupId = groupId;
  }
  const instant = 'mn_instant(m.started_at, m.created_at, m.audio_path)';
  if (f.week) {
    const [year, week] = f.week.split('-W').map(Number),
      range = isoWeekRange(year!, week!);
    params.start = range.start.getTime();
    params.end = range.end.getTime();
    conditions.push(`${instant} BETWEEN @start AND @end`);
  }
  if (f.from) {
    params.from = new Date(`${f.from}T00:00:00`).getTime();
    conditions.push(`${instant} >= @from`);
  }
  if (f.to) {
    const end = new Date(`${f.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    params.to = end.getTime();
    conditions.push(`${instant} < @to`);
  }
  if (f.status) {
    params.status = f.status;
    conditions.push("(m.status = @status OR (@status='processing' AND m.status='awaiting_user'))");
  }
  if (f.speakerId) {
    params.speaker = f.speakerId;
    conditions.push(
      'EXISTS (SELECT 1 FROM meeting_speakers sp WHERE sp.meeting_id=m.id AND sp.roster_speaker_id=@speaker)',
    );
  }
  if (f.actions) {
    let mine = '';
    if (f.actions === 'mine') {
      params.meId = me.id;
      params.meName = me.name;
      mine =
        ' AND (a.owner_speaker_id=@meId OR (a.owner_speaker_id IS NULL AND a.owner_name COLLATE NOCASE=@meName))';
    }
    conditions.push(
      `EXISTS (SELECT 1 FROM action_items a WHERE a.meeting_id=m.id AND a.status!='done'${mine})`,
    );
  }
  if (f.source)
    conditions.push(
      `${f.source === 'import' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM recording_sessions rs WHERE rs.output_path=m.audio_path)`,
    );
  if (f.warning)
    conditions.push(
      "EXISTS (SELECT 1 FROM recording_sessions rs WHERE rs.output_path=m.audio_path AND rs.status IN ('error','orphaned'))",
    );
  if (Object.values(params).some((value) => typeof value === 'number' && !Number.isFinite(value)))
    throw new Error('Invalid search date');
  return { sql: conditions.join(' AND '), params };
}
/** Parameter-bound metadata filtering before either title or file result limits. */
export class FacetedMeetings {
  constructor(private db: Database.Database) {}
  titles(
    q: string,
    limit: number,
    scope: ReturnType<typeof searchScope>,
  ): { id: string; title: string; slug: string; groupName: string | null }[] {
    return this.db
      .prepare(
        `SELECT m.id,m.slug,m.title,(SELECT name FROM groups WHERE id=m.group_id) AS groupName
      FROM meetings m WHERE ${scope.sql} AND m.title LIKE @q ESCAPE '\\' COLLATE NOCASE ORDER BY m.started_at DESC,m.id LIMIT @limit`,
      )
      .all({ ...scope.params, q: `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit }) as {
      id: string;
      title: string;
      slug: string;
      groupName: string | null;
    }[];
  }
  matchesSlug(slug: string, scope: ReturnType<typeof searchScope>): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM meetings m WHERE m.slug=@slug AND ${scope.sql}`)
      .get({ ...scope.params, slug });
  }
}
