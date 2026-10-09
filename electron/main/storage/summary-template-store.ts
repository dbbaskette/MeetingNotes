// electron/main/storage/summary-template-store.ts
//
// Which summary template a meeting uses (#254). A meeting may carry its own
// choice; otherwise it inherits its group's default; otherwise General.
// Stored as template ids in two nullable columns, where NULL means inherit.

import type Database from 'better-sqlite3';
import { GENERAL_TEMPLATE_ID, isSummaryTemplateId, summaryTemplate, type SummaryTemplate } from '../../shared/summary-templates.js';

export interface MeetingTemplateChoice {
  /** The meeting's own override, or null when it inherits. */
  own: string | null;
  /** Its group's default, or null when the group has none (or no group). */
  group: string | null;
  /** The template that will actually be used. */
  effective: string;
}

/** Ids from an older or newer build that this build does not know are treated
 *  as "inherit", so they never surface as a broken choice. */
const known = (id: unknown): string | null => (isSummaryTemplateId(id) ? id : null);

export class SummaryTemplateStore {
  constructor(private readonly db: Database.Database) {}

  forMeeting(meetingId: string): MeetingTemplateChoice | null {
    const row = this.db.prepare(`
      SELECT m.summary_template AS own, g.summary_template AS grp
      FROM meetings m LEFT JOIN groups g ON g.id = m.group_id WHERE m.id = ?
    `).get(meetingId) as { own: string | null; grp: string | null } | undefined;
    if (!row) return null;
    const own = known(row.own), group = known(row.grp);
    return { own, group, effective: own ?? group ?? GENERAL_TEMPLATE_ID };
  }

  /** The template the summarize stage should use. Never throws for a missing
   *  meeting: summarization falls back to General. */
  effectiveFor(meetingId: string): SummaryTemplate {
    return summaryTemplate(this.forMeeting(meetingId)?.effective);
  }

  setForMeeting(meetingId: string, templateId: string | null): void {
    const result = this.db.prepare('UPDATE meetings SET summary_template = ? WHERE id = ?').run(validated(templateId), meetingId);
    if (result.changes === 0) throw new Error('Meeting not found');
  }

  setForGroup(groupId: string, templateId: string | null): void {
    const result = this.db.prepare('UPDATE groups SET summary_template = ? WHERE id = ?').run(validated(templateId), groupId);
    if (result.changes === 0) throw new Error('Group not found');
  }

  /** Group id -> template id, for groups that have a default. */
  groupDefaults(): Record<string, string> {
    const rows = this.db.prepare('SELECT id, summary_template FROM groups WHERE summary_template IS NOT NULL').all() as { id: string; summary_template: string }[];
    return Object.fromEntries(rows.flatMap((row) => (known(row.summary_template) ? [[row.id, row.summary_template]] : [])));
  }
}

function validated(templateId: string | null): string | null {
  if (templateId === null) return null;
  if (!isSummaryTemplateId(templateId)) throw new Error('Unknown summary template');
  return templateId;
}
