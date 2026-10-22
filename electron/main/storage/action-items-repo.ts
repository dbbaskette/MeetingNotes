import type Database from 'better-sqlite3';
import { shortId } from '../lib/slug.js';
import type { ActionItem } from '../lib/action-item-schema.js';
import { ActionFilterSchema, type ActionFilter, type ActionPage, resolveSpeakerLabels } from '../../shared/productivity.js';

/** An action item as produced by the extract stage after provenance
 *  matching: the model's { text, owner, due_date } plus the verbatim
 *  summary bullet it was matched to (null when nothing matched). */
export type ActionItemWithSource = ActionItem & { sourceQuote?: string | null };

export interface ActionItemRow {
  id: string; meetingId: string; text: string;
  ownerSpeakerId: string | null; ownerName: string | null;
  dueDate: string | null;
  sourceQuote: string | null;
  status: string; exportedTo: string[]; createdAt: string;
}

function row(r: Record<string, unknown>): ActionItemRow {
  return {
    id: r.id as string,
    meetingId: r.meeting_id as string,
    text: r.text as string,
    ownerSpeakerId: (r.owner_speaker_id as string) ?? null,
    ownerName: (r.owner_name as string) ?? null,
    dueDate: (r.due_date as string) ?? null,
    sourceQuote: (r.source_quote as string) ?? null,
    status: r.status as string,
    exportedTo: JSON.parse((r.exported_to as string) || '[]'),
    createdAt: r.created_at as string,
  };
}

export class ActionItemsRepo {
  private deleted = new Map<string,{snapshot:Record<string,unknown>;revision:number;expires:number}>();
  constructor(private readonly db: Database.Database) {}
  live(filter: ActionFilter, me: { id: string | null; name: string | null }): ActionPage {
    const parsed = ActionFilterSchema.parse(filter);
    const conditions = ["a.status!='done'", 'm.deleted_at IS NULL'];
    const params: Record<string, string | number | null> = {};
    const owner = "COALESCE(a.owner_name,sp.display_name)";
    if (parsed.owner === 'mine') {
      conditions.push(`(a.owner_speaker_id=@me OR (a.owner_speaker_id IS NULL AND ${owner} COLLATE NOCASE=@name))`);
      params.me = me.id; params.name = me.name;
    } else if (parsed.owner !== 'all') { conditions.push(`${owner}=@owner COLLATE NOCASE`); params.owner = parsed.owner; }
    if (parsed.groupId) { conditions.push('m.group_id=@groupId'); params.groupId = parsed.groupId; }
    if (parsed.due === 'undated') conditions.push('a.due_date IS NULL');
    else if (parsed.due === 'overdue') conditions.push("a.due_date < date('now','localtime')");
    else if (parsed.due === 'soon') conditions.push("a.due_date BETWEEN date('now','localtime') AND date('now','localtime','+7 days')");
    const join = 'FROM action_items a JOIN meetings m ON m.id=a.meeting_id LEFT JOIN speakers sp ON sp.id=a.owner_speaker_id LEFT JOIN groups g ON g.id=m.group_id';
    const where = conditions.join(' AND ');
    const total = (this.db.prepare(`SELECT COUNT(*) AS n ${join} WHERE ${where}`).get(params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT a.id,a.meeting_id AS meetingId,m.title AS meetingTitle,a.text,
      ${owner} AS ownerName,a.due_date AS dueDate,g.name AS groupName,m.status='processing' AS processing
      ${join} WHERE ${where} ORDER BY a.due_date IS NULL,a.due_date,m.started_at DESC,a.id LIMIT 100 OFFSET @offset`).all({ ...params, offset: parsed.offset }) as (Omit<ActionPage['items'][number], 'processing'> & { processing: number })[];
    const owners = (this.db.prepare(`SELECT DISTINCT ${owner} AS name ${join} WHERE a.status!='done' AND m.deleted_at IS NULL AND ${owner} IS NOT NULL ORDER BY name COLLATE NOCASE`).all() as { name: string }[]).map(row => row.name);
    return { items: rows.map(row => ({ ...row, processing: !!row.processing })), total, owners, identified: !!(me.id || me.name) };
  }
  resolveLabels(meetingId: string, names: Record<string, string>): void {
    const update = this.db.prepare('UPDATE action_items SET text=?,owner_name=?,source_quote=? WHERE id=?');
    this.db.transaction(() => {
      for (const item of this.listByMeeting(meetingId)) {
        const text = resolveSpeakerLabels(item.text, names), owner = item.ownerName ? resolveSpeakerLabels(item.ownerName, names) : null;
        const quote = item.sourceQuote ? resolveSpeakerLabels(item.sourceQuote, names) : null;
        if (text !== item.text || owner !== item.ownerName || quote !== item.sourceQuote) update.run(text, owner, quote, item.id);
      }
    })();
  }
  findById(id:string):ActionItemRow|null{const found=this.db.prepare('SELECT * FROM action_items WHERE id=?').get(id) as Record<string,unknown>|undefined;return found?row(found):null;}

  replaceForMeeting(meetingId: string, items: readonly ActionItemWithSource[]): void {
    const del = this.db.prepare('DELETE FROM action_items WHERE meeting_id = ?');
    const ins = this.db.prepare(`
      INSERT INTO action_items (id, meeting_id, text, owner_speaker_id, due_date, source_quote, status, exported_to, created_at)
      VALUES (?, ?, ?, NULL, ?, ?, 'open', '[]', ?)
    `);
    const tx = this.db.transaction(() => {
      del.run(meetingId);
      const now = new Date().toISOString();
      for (const it of items) ins.run(`ai_${shortId()}`, meetingId, it.text, it.due_date, it.sourceQuote ?? null, now);
    });
    tx();
  }

  listByMeeting(meetingId: string): ActionItemRow[] {
    const rows = this.db.prepare('SELECT * FROM action_items WHERE meeting_id = ? ORDER BY created_at').all(meetingId) as Record<string, unknown>[];
    return rows.map(row);
  }

  countsByMeeting(): Map<string, number> {
    const rows = this.db.prepare(
      'SELECT meeting_id, COUNT(*) AS n FROM action_items GROUP BY meeting_id',
    ).all() as { meeting_id: string; n: number }[];
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.meeting_id, r.n);
    return out;
  }

  /** Scoped summary aggregation; bind at most 900 IDs per statement. */
  countsForMeetings(meetingIds: string[]): Map<string, number> {
    const ids = [...new Set(meetingIds)];
    const out = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 900) {
      const chunk = ids.slice(i, i + 900);
      const rows = this.db.prepare(`
        SELECT meeting_id, COUNT(*) AS n FROM action_items
        WHERE meeting_id IN (${chunk.map(() => '?').join(',')}) GROUP BY meeting_id
      `).all(...chunk) as { meeting_id: string; n: number }[];
      for (const r of rows) out.set(r.meeting_id, r.n);
    }
    return out;
  }

  deleteForMeeting(meetingId: string): void {
    this.db.prepare('DELETE FROM action_items WHERE meeting_id = ?').run(meetingId);
  }

  setStatus(id: string, status: string): void {
    this.db.prepare('UPDATE action_items SET status = ? WHERE id = ?').run(status, id);
  }

  markExported(id: string, target: string): void {
    const r = this.db.prepare('SELECT exported_to FROM action_items WHERE id = ?').get(id) as { exported_to: string } | undefined;
    if (!r) return;
    const list: string[] = JSON.parse(r.exported_to || '[]');
    if (!list.includes(target)) list.push(target);
    this.db.prepare('UPDATE action_items SET exported_to = ? WHERE id = ?').run(JSON.stringify(list), id);
  }

  /** User-edited single-field update for #44. text / ownerName / dueDate
   *  are each optional; passing undefined leaves the existing value
   *  untouched, passing null clears it (useful to remove a wrong owner). */
  update(id: string, patch: { text?: string; ownerName?: string | null; dueDate?: string | null }): ActionItemRow | null {
    const current = this.db.prepare('SELECT * FROM action_items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!current) return null;
    const text = patch.text !== undefined ? patch.text : (current.text as string);
    const ownerName = patch.ownerName !== undefined ? patch.ownerName : ((current.owner_name as string | null) ?? null);
    const dueDate = patch.dueDate !== undefined ? patch.dueDate : ((current.due_date as string | null) ?? null);
    this.db.prepare('UPDATE action_items SET text = ?, owner_name = ?, owner_speaker_id = ?, due_date = ? WHERE id = ?')
      .run(text, ownerName, patch.ownerName !== undefined && ownerName!==current.owner_name ? null : current.owner_speaker_id, dueDate, id);
    const updated = this.db.prepare('SELECT * FROM action_items WHERE id = ?').get(id) as Record<string, unknown>;
    return row(updated);
  }

  /** Hard-delete a single action item. Used by the row-level Delete
   *  action in the detail view (#44). Unlike meeting deletion, these
   *  don't have a trash path — an unwanted action item can just be
   *  re-added via create() if the user changes their mind. */
  delete(id: string): void {
    this.db.prepare('DELETE FROM action_items WHERE id = ?').run(id);
  }

  deleteWithUndo(id:string):string|null {
    for(const [token,entry] of this.deleted)if(entry.expires<Date.now())this.deleted.delete(token);
    const snapshot=this.db.prepare('SELECT * FROM action_items WHERE id=?').get(id) as Record<string,unknown>|undefined;
    if(!snapshot)return null;
    const token=`undo_${shortId()}`;
    this.db.transaction(()=>{
      this.delete(id);
      const meeting=this.db.prepare('SELECT action_revision FROM meetings WHERE id=?').get(snapshot.meeting_id) as {action_revision:number};
      this.deleted.set(token,{snapshot,revision:meeting.action_revision,expires:Date.now()+600000});
    })();
    return token;
  }
  undoDelete(token:string):boolean {
    const entry=this.deleted.get(token);if(!entry)return false;
    if(entry.expires<Date.now()){this.deleted.delete(token);return false;}
    return this.db.transaction(()=>{
      const meeting=this.db.prepare('SELECT action_revision,status,deleted_at FROM meetings WHERE id=?').get(entry.snapshot.meeting_id) as {action_revision:number;status:string;deleted_at:string|null}|undefined;
      if(!meeting||meeting.deleted_at||meeting.status==='processing'||meeting.action_revision!==entry.revision)return false;
      if(this.db.prepare('SELECT 1 FROM action_items WHERE id=?').get(entry.snapshot.id))return false;
      const fields=Object.keys(entry.snapshot); // trusted DB column names, never IPC input
      this.db.prepare(`INSERT INTO action_items (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`).run(...fields.map(key=>entry.snapshot[key]));
      this.deleted.delete(token);return true;
    })();
  }

  /** Create a single action item. For the "Add item" button in the
   *  detail view's right rail — lets users add things Extract missed. */
  create(meetingId: string, patch: { text: string; ownerName?: string | null; dueDate?: string | null }): ActionItemRow {
    const id = `ai_${shortId()}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO action_items (id, meeting_id, text, owner_speaker_id, owner_name, due_date, status, exported_to, created_at)
      VALUES (?, ?, ?, NULL, ?, ?, 'open', '[]', ?)
    `).run(id, meetingId, patch.text, patch.ownerName ?? null, patch.dueDate ?? null, now);
    const row_ = this.db.prepare('SELECT * FROM action_items WHERE id = ?').get(id) as Record<string, unknown>;
    return row(row_);
  }
}
