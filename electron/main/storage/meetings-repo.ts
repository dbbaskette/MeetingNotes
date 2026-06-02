import type Database from 'better-sqlite3';

export interface MeetingRow {
  id: string; slug: string; title: string;
  startedAt: string | null; durationS: number | null;
  audioPath: string; status: string; pipelineStage: string;
  stageStartedAt: string | null;
  /** Set when `status === 'failed'`: the error string from the stage that
   *  threw (e.g. "whisper: not ready ..."). NULL otherwise. Cleared on any
   *  transition back to a non-failed status. */
  errorMessage: string | null;
  skipSpeakerId: boolean;
  /** ISO timestamp of soft-delete. NULL = live. Rows with a non-null
   *  `deletedAt` are hidden from `listAll()` but still accessible via
   *  `findById()` so the undo-delete toast can restore them. */
  deletedAt: string | null;
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
    stageStartedAt: (r.stage_started_at as string) ?? null,
    errorMessage: (r.error_message as string) ?? null,
    skipSpeakerId: Boolean((r.skip_speaker_id as number | undefined) ?? 0),
    deletedAt: (r.deleted_at as string) ?? null,
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

  findByAudioPath(audioPath: string): MeetingRow | null {
    const row = this.db.prepare('SELECT * FROM meetings WHERE audio_path = ?').get(audioPath) as Record<string, unknown> | undefined;
    return row ? rowToMeeting(row) : null;
  }

  findById(id: string): MeetingRow | null {
    const row = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToMeeting(row) : null;
  }

  listAll(): MeetingRow[] {
    // Soft-deleted rows are in the DB until the purge job runs — hide them
    // from all user-facing listings. findById() still returns them for the
    // undo-delete path.
    const rows = this.db.prepare(
      'SELECT * FROM meetings WHERE deleted_at IS NULL ORDER BY COALESCE(started_at, created_at) DESC',
    ).all() as Record<string, unknown>[];
    return rows.map(rowToMeeting);
  }

  /** Returns meetings whose effective start time falls within
   *  [startIso, endIso]. Inclusive on both ends. Used by the weekly-
   *  summary view to gather meetings for one ISO week. Soft-deleted
   *  rows are excluded.
   *
   *  Effective start time is `COALESCE(started_at, created_at)` —
   *  the recording pipeline doesn't always set `started_at` (it's
   *  populated from audio metadata via ffprobe and from the
   *  `recording-YYYYMMDD-HHMMSS-...` filename when present, but
   *  legacy rows + some Audio Hijack imports leave it NULL). Falling
   *  back to `created_at` makes those rows visible in the weekly view
   *  rather than silently disappearing — created_at lands within a
   *  few minutes of the real start time in practice. */
  listInRange(startIso: string, endIso: string): MeetingRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM meetings
      WHERE deleted_at IS NULL
        AND COALESCE(started_at, created_at) >= ?
        AND COALESCE(started_at, created_at) <= ?
      ORDER BY COALESCE(started_at, created_at) ASC
    `).all(startIso, endIso) as Record<string, unknown>[];
    return rows.map(rowToMeeting);
  }

  findNonTerminal(): MeetingRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM meetings WHERE pipeline_stage != 'done' AND deleted_at IS NULL",
    ).all() as Record<string, unknown>[];
    return rows.map(rowToMeeting);
  }

  /** Meetings to auto-resume on launch: in-progress, never failed. */
  findResumable(): MeetingRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM meetings WHERE pipeline_stage != 'done' AND status = 'processing' AND deleted_at IS NULL",
    ).all() as Record<string, unknown>[];
    return rows.map(rowToMeeting);
  }

  /** Rows in the soft-delete limbo, optionally older than a given ISO
   *  timestamp. The main process's periodic purge passes a cutoff so it
   *  only hard-deletes entries past the undo window. */
  findSoftDeleted(olderThanIso?: string): MeetingRow[] {
    const sql = olderThanIso
      ? 'SELECT * FROM meetings WHERE deleted_at IS NOT NULL AND deleted_at < ?'
      : 'SELECT * FROM meetings WHERE deleted_at IS NOT NULL';
    const stmt = this.db.prepare(sql);
    const rows = (olderThanIso ? stmt.all(olderThanIso) : stmt.all()) as Record<string, unknown>[];
    return rows.map(rowToMeeting);
  }

  updateStage(id: string, stage: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE meetings SET pipeline_stage = ?, stage_started_at = ?, updated_at = ? WHERE id = ?',
    ).run(stage, now, now, id);
  }

  updateTitle(id: string, title: string): void {
    this.db.prepare('UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, new Date().toISOString(), id);
  }

  updateStatus(id: string, status: string): void {
    // Any move away from 'failed' clears the stale error so a retried or
    // resumed meeting doesn't keep showing the old failure reason.
    this.db.prepare(
      'UPDATE meetings SET status = ?, error_message = NULL, updated_at = ? WHERE id = ?',
    ).run(status, new Date().toISOString(), id);
  }

  /** Mark a meeting failed and record why. Keeps the error string the
   *  pipeline caught so the detail view can explain the failure. */
  recordFailure(id: string, message: string): void {
    this.db.prepare(
      "UPDATE meetings SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
    ).run(message, new Date().toISOString(), id);
  }

  updateDuration(id: string, durationS: number): void {
    this.db.prepare('UPDATE meetings SET duration_s = ?, updated_at = ? WHERE id = ?')
      .run(durationS, new Date().toISOString(), id);
  }

  updateSkipSpeakerId(id: string, skip: boolean): void {
    this.db.prepare('UPDATE meetings SET skip_speaker_id = ?, updated_at = ? WHERE id = ?')
      .run(skip ? 1 : 0, new Date().toISOString(), id);
  }

  /** Soft-delete: mark the row hidden but keep it around so the undo-delete
   *  toast can restore it. File moves to the trash dir happen in the IPC
   *  handler because they need the library root / audio paths. */
  softDelete(id: string): void {
    this.db.prepare('UPDATE meetings SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), id);
  }

  /** Clear the deleted_at stamp — user clicked Undo. */
  restore(id: string): void {
    this.db.prepare('UPDATE meetings SET deleted_at = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  /** Hard-delete: remove the row. Foreign keys in `meeting_speakers` and
   *  `action_items` cascade (see migrations.ts), so associated rows vacate
   *  automatically. File cleanup is the caller's job. Used by the purge
   *  job that runs on startup + on a timer to empty the trash. */
  hardDelete(id: string): void {
    this.db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  }

  /** All rows where `started_at` is unset. Used by the startup backfill
   *  job that parses the timestamp out of the audio filename. */
  findMissingStartedAt(): { id: string; audioPath: string }[] {
    const rows = this.db.prepare(
      'SELECT id, audio_path FROM meetings WHERE started_at IS NULL AND deleted_at IS NULL',
    ).all() as Array<{ id: string; audio_path: string }>;
    return rows.map((r) => ({ id: r.id, audioPath: r.audio_path }));
  }

  /** Set `started_at` directly. Backfill path only — normal inserts
   *  pass startedAt through `insert()`. Touches updated_at so the
   *  weekly aggregator's input-hash invalidation picks up the change. */
  setStartedAt(id: string, startedAtIso: string): void {
    this.db.prepare('UPDATE meetings SET started_at = ?, updated_at = ? WHERE id = ?')
      .run(startedAtIso, new Date().toISOString(), id);
  }
}
