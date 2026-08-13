import type Database from 'better-sqlite3';

export interface RecordingSessionInsert {
  id: string;
  helperPid: number;
  targetPid: number | null;
  targetLabel: string;
  outputPath: string;
}

export interface RecordingSessionRow {
  id: string;
  helperPid: number;
  targetPid: number | null;
  targetLabel: string;
  outputPath: string;
  startedAt: string;
  finalizedAt: string | null;
  status: 'recording' | 'finalized' | 'orphaned' | 'error';
  dismissedAt: string | null;
}

export class RecordingSessionsRepo {
  constructor(private readonly db: Database.Database) {}

  insert(s: RecordingSessionInsert): void {
    this.db.prepare(`
      INSERT INTO recording_sessions
        (id, helper_pid, target_pid, target_label, output_path, started_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'recording')
    `).run(s.id, s.helperPid, s.targetPid, s.targetLabel, s.outputPath, new Date().toISOString());
  }

  finalize(id: string): void {
    this.db.prepare(`
      UPDATE recording_sessions
         SET status = 'finalized', finalized_at = ?
       WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  markOrphaned(id: string): void {
    this.db.prepare("UPDATE recording_sessions SET status = 'orphaned' WHERE id = ?").run(id);
  }

  markError(id: string): void {
    this.db.prepare("UPDATE recording_sessions SET status = 'error' WHERE id = ?").run(id);
  }

  findOpen(): RecordingSessionRow[] {
    return (this.db.prepare("SELECT * FROM recording_sessions WHERE status = 'recording'").all() as Record<string, unknown>[])
      .map(rowToSession);
  }

  findOrphaned(): RecordingSessionRow[] {
    return (this.db.prepare("SELECT * FROM recording_sessions WHERE status = 'orphaned'").all() as Record<string, unknown>[])
      .map(rowToSession);
  }

  findById(id: string): RecordingSessionRow | null {
    const row = this.db.prepare('SELECT * FROM recording_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : null;
  }

  findRecoverable(): RecordingSessionRow[] {
    return (this.db.prepare(`
      SELECT * FROM recording_sessions
       WHERE status IN ('finalized', 'orphaned', 'error')
         AND dismissed_at IS NULL
       ORDER BY started_at DESC
    `).all() as Record<string, unknown>[]).map(rowToSession);
  }

  dismissRecovery(id: string): void {
    this.db.prepare('UPDATE recording_sessions SET dismissed_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }
}

function rowToSession(r: Record<string, unknown>): RecordingSessionRow {
  return {
    id: r.id as string,
    helperPid: r.helper_pid as number,
    targetPid: (r.target_pid as number) ?? null,
    targetLabel: r.target_label as string,
    outputPath: r.output_path as string,
    startedAt: r.started_at as string,
    finalizedAt: (r.finalized_at as string) ?? null,
    status: r.status as RecordingSessionRow['status'],
    dismissedAt: (r.dismissed_at as string) ?? null,
  };
}
