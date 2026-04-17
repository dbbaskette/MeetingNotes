import type Database from 'better-sqlite3';

export interface MeetingRow {
  id: string; slug: string; title: string;
  startedAt: string | null; durationS: number | null;
  audioPath: string; status: string; pipelineStage: string;
  createdAt: string; updatedAt: string;
}

export interface MeetingInsert {
  id: string; slug: string; title: string;
  startedAt: string | null; durationS: number | null;
  audioPath: string; status: string; pipelineStage: string;
}

function rowToMeeting(r: Record<string, unknown>): MeetingRow {
  return {
    id: r.id as string,
    slug: r.slug as string,
    title: r.title as string,
    startedAt: (r.started_at as string) ?? null,
    durationS: (r.duration_s as number) ?? null,
    audioPath: r.audio_path as string,
    status: r.status as string,
    pipelineStage: r.pipeline_stage as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export class MeetingsRepo {
  constructor(private readonly db: Database.Database) {}

  insert(m: MeetingInsert): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO meetings (id, slug, title, started_at, duration_s, audio_path, status, pipeline_stage, created_at, updated_at)
      VALUES (@id, @slug, @title, @startedAt, @durationS, @audioPath, @status, @pipelineStage, @createdAt, @updatedAt)
    `).run({ ...m, createdAt: now, updatedAt: now });
  }

  findById(id: string): MeetingRow | null {
    const row = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToMeeting(row) : null;
  }

  listAll(): MeetingRow[] {
    const rows = this.db.prepare('SELECT * FROM meetings ORDER BY COALESCE(started_at, created_at) DESC').all() as Record<string, unknown>[];
    return rows.map(rowToMeeting);
  }

  findNonTerminal(): MeetingRow[] {
    const rows = this.db.prepare("SELECT * FROM meetings WHERE pipeline_stage != 'done'").all() as Record<string, unknown>[];
    return rows.map(rowToMeeting);
  }

  updateStage(id: string, stage: string): void {
    this.db.prepare('UPDATE meetings SET pipeline_stage = ?, updated_at = ? WHERE id = ?')
      .run(stage, new Date().toISOString(), id);
  }

  updateTitle(id: string, title: string): void {
    this.db.prepare('UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, new Date().toISOString(), id);
  }

  updateStatus(id: string, status: string): void {
    this.db.prepare('UPDATE meetings SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
  }

  updateDuration(id: string, durationS: number): void {
    this.db.prepare('UPDATE meetings SET duration_s = ?, updated_at = ? WHERE id = ?')
      .run(durationS, new Date().toISOString(), id);
  }
}
