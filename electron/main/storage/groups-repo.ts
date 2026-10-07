import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface MeetingGroup {
  id: string;
  name: string;
  count: number;
  createdAt: string;
  updatedAt: string;
}
export interface GroupListSnapshot {
  groups: MeetingGroup[];
  allCount: number;
  ungroupedCount: number;
}

export interface GroupAssignment {
  id: string;
  previousGroupId: string | null;
}

export interface GroupAssignResult {
  moved: GroupAssignment[];
  failedIds: string[];
}

function cleanName(name: string): { name: string; key: string } {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > 80) throw new Error('Group name must be 1–80 characters');
  return { name: trimmed, key: trimmed.toLocaleLowerCase() };
}

export class GroupsRepo {
  constructor(private readonly db: Database.Database) {}

  list(): MeetingGroup[] {
    const rows = this.db.prepare(`
      SELECT g.*, COUNT(m.id) AS meeting_count FROM groups g
      LEFT JOIN meetings m ON m.group_id = g.id AND m.deleted_at IS NULL
      GROUP BY g.id ORDER BY g.name COLLATE NOCASE, g.id
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string, name: row.name as string,
      count: row.meeting_count as number,
      createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    }));
  }

  listWithCounts(): GroupListSnapshot {
    const totals = this.db.prepare(`SELECT COUNT(*) AS all_count,
      COUNT(CASE WHEN group_id IS NULL THEN 1 END) AS ungrouped_count
      FROM meetings WHERE deleted_at IS NULL`).get() as { all_count: number; ungrouped_count: number };
    return { groups: this.list(), allCount: totals.all_count, ungroupedCount: totals.ungrouped_count };
  }

  exists(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(id));
  }

  create(rawName: string): MeetingGroup {
    const { name, key } = cleanName(rawName);
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.db.prepare('INSERT INTO groups (id, name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, key, now, now);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new Error('A group with this name already exists');
      throw error;
    }
    return { id, name, count: 0, createdAt: now, updatedAt: now };
  }

  rename(id: string, rawName: string): void {
    const { name, key } = cleanName(rawName);
    try {
      const result = this.db.prepare('UPDATE groups SET name = ?, name_key = ?, updated_at = ? WHERE id = ?')
        .run(name, key, new Date().toISOString(), id);
      if (result.changes === 0) throw new Error('Group no longer exists');
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new Error('A group with this name already exists');
      throw error;
    }
  }

  delete(id: string): boolean {
    return this.db.transaction(() => {
      // Explicit updates work even when a test or imported DB omitted FK ON.
      this.db.prepare('UPDATE meetings SET group_id = NULL WHERE group_id = ?').run(id);
      this.db.prepare('UPDATE recording_sessions SET group_id = NULL WHERE group_id = ?').run(id);
      return this.db.prepare('DELETE FROM groups WHERE id = ?').run(id).changes > 0;
    })();
  }

  assign(ids: string[], groupId: string | null, expectedGroupId?: string | null): GroupAssignResult {
    if (groupId !== null && !this.exists(groupId)) throw new Error('Group no longer exists');
    const unique = [...new Set(ids)];
    return this.db.transaction(() => {
      const moved: GroupAssignment[] = [];
      const failedIds: string[] = [];
      const get = this.db.prepare('SELECT group_id FROM meetings WHERE id = ? AND deleted_at IS NULL');
      // Grouping does not change meeting content. Leave updated_at alone so
      // weekly-summary input hashes do not regenerate on organization alone.
      const set = this.db.prepare('UPDATE meetings SET group_id = ? WHERE id = ? AND deleted_at IS NULL');
      for (const id of unique) {
        const row = get.get(id) as { group_id: string | null } | undefined;
        if (!row) { failedIds.push(id); continue; }
        if (expectedGroupId !== undefined && row.group_id !== expectedGroupId) {
          failedIds.push(id); continue;
        }
        if (row.group_id !== groupId) {
          set.run(groupId, id);
          moved.push({ id, previousGroupId: row.group_id });
        }
      }
      return { moved, failedIds };
    })();
  }
}
