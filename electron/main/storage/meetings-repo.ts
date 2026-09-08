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

export type MeetingListFilter = 'all' | 'pending' | 'processing' | 'done' | 'failed';
export type MeetingListSort = 'newest' | 'oldest' | 'longest' | 'title';

export interface MeetingListQuery {
  filter: MeetingListFilter;
  sort: MeetingListSort;
  cursor?: string;
  /** Positive integer; defaults to 50 and caps at 100. */
  pageSize?: number;
}

export interface MeetingPage { rows: MeetingRow[]; nextCursor: string | null; }
export interface MeetingCounts { all: number; pending: number; processing: number; done: number; failed: number; }

// Only these internal fragments can enter SQL. Values (including cursor values)
// are always bound parameters. Unknown statuses remain in the last bucket.
const STATUS_RANK_SQL = `CASE status WHEN 'pending' THEN 0 WHEN 'awaiting_user' THEN 1
  WHEN 'processing' THEN 2 WHEN 'failed' THEN 3 WHEN 'done' THEN 4 ELSE 9 END`;
const FILTER_SQL: Record<MeetingListFilter, string> = {
  all: '1', pending: "status = 'pending'", processing: "status IN ('awaiting_user', 'processing')",
  done: "status = 'done'", failed: "status = 'failed'",
};

type SortValue = string | number | null;
interface SortColumn {
  sql: string;
  field: string;
  direction: 'ASC' | 'DESC';
  type: 'string' | 'number';
  nullable?: boolean;
}
const NEWEST: SortColumn = { sql: 'started_at', field: 'started_at', direction: 'DESC', type: 'string', nullable: true };
const SORT_COLUMNS: Record<MeetingListSort, readonly SortColumn[]> = {
  newest: [NEWEST],
  oldest: [{ ...NEWEST, direction: 'ASC' }],
  longest: [{ sql: 'duration_s', field: 'duration_s', direction: 'DESC', type: 'number', nullable: true }, NEWEST],
  title: [{ sql: 'title COLLATE NOCASE', field: 'title', direction: 'ASC', type: 'string' }, NEWEST],
};
const RANK_COLUMN: SortColumn = { sql: STATUS_RANK_SQL, field: 'browse_status_rank', direction: 'ASC', type: 'number' };
const ID_COLUMN: SortColumn = { sql: 'id', field: 'id', direction: 'ASC', type: 'string' };

interface MeetingCursor {
  v: 1;
  statusRank: number;
  // The sort tag rejects reuse with a different sort; values contain every
  // ordered column before the immutable ID, including secondary recency.
  sortValue: { sort: MeetingListSort; values: SortValue[] };
  id: string;
}

function filterSql(filter: MeetingListFilter): string {
  if (!Object.hasOwn(FILTER_SQL, filter)) throw new Error('Invalid meeting filter');
  return FILTER_SQL[filter];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeCursor(encoded: string, sort: MeetingListSort): MeetingCursor {
  const invalid = () => new Error('Invalid meeting cursor');
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw invalid();
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) throw invalid();
  let cursor: unknown;
  try { cursor = JSON.parse(bytes.toString('utf8')); } catch { throw invalid(); }
  if (!isRecord(cursor) || cursor.v !== 1
    || ![0, 1, 2, 3, 4, 9].includes(cursor.statusRank as number)
    || typeof cursor.id !== 'string' || cursor.id.length === 0
    || !isRecord(cursor.sortValue) || cursor.sortValue.sort !== sort
    || !Array.isArray(cursor.sortValue.values)) throw invalid();
  const values = cursor.sortValue.values;
  const columns = SORT_COLUMNS[sort];
  if (values.length !== columns.length || !columns.every((column, i) =>
    values[i] === null ? column.nullable : typeof values[i] === column.type
      && (column.type !== 'number' || Number.isFinite(values[i])))) throw invalid();
  return cursor as unknown as MeetingCursor;
}

/** Lexicographic continuation for mixed ASC/DESC columns. IS compares nulls
 *  safely (and honors NOCASE); a non-null cursor also admits the trailing null
 *  group. A null cursor only advances via later tie-break columns. */
function afterCursor(columns: readonly SortColumn[], values: SortValue[], params: Record<string, SortValue>): string {
  const equal: string[] = [];
  const after: string[] = [];
  columns.forEach((column, i) => {
    const value = values[i]!;
    const parameter = `cursor${i}`;
    params[parameter] = value;
    if (value !== null) {
      const comparison = `${column.sql} ${column.direction === 'ASC' ? '>' : '<'} @${parameter}`;
      const next = column.nullable ? `(${comparison} OR ${column.sql} IS NULL)` : comparison;
      after.push(`(${[...equal, next].join(' AND ')})`);
    }
    equal.push(`${column.sql} IS @${parameter}`);
  });
  return `(${after.join(' OR ')})`;
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

  /** Live browse rows, status bucket first and ID last. Null dates/durations
   *  always sink within a bucket; title and longest break ties by newest.
   *  Cursors describe values, not row lookups, so deleting the anchor is safe.
   *  This is not a snapshot: callers must restart after changing the query or
   *  refreshing sort/status values that may move rows across the cursor. */
  listPage(query: MeetingListQuery): MeetingPage {
    const filter = filterSql(query.filter);
    if (!Object.hasOwn(SORT_COLUMNS, query.sort)) throw new Error('Invalid meeting sort');
    const requestedSize = query.pageSize === undefined ? 50 : query.pageSize;
    if (!Number.isInteger(requestedSize) || requestedSize < 1) throw new Error('Invalid meeting page size');
    const pageSize = Math.min(requestedSize, 100);
    const selectedColumns = SORT_COLUMNS[query.sort];
    const columns = [RANK_COLUMN, ...selectedColumns, ID_COLUMN];
    const params: Record<string, SortValue> = { limit: pageSize + 1 };
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor, query.sort);
    const continuation = cursor ? `AND ${afterCursor(columns,
      [cursor.statusRank, ...cursor.sortValue.values, cursor.id], params)}` : '';
    const order = columns.map((column) =>
      `${column.sql} ${column.direction}${column.nullable ? ' NULLS LAST' : ''}`).join(', ');
    const result = this.db.prepare(`
      SELECT *, ${STATUS_RANK_SQL} AS browse_status_rank FROM meetings
      WHERE deleted_at IS NULL AND ${filter} ${continuation}
      ORDER BY ${order} LIMIT @limit
    `).all(params) as Record<string, unknown>[];
    const hasMore = result.length > pageSize;
    const rows = result.slice(0, pageSize);
    const last = rows[rows.length - 1];
    const next: MeetingCursor | null = hasMore && last ? {
      v: 1, statusRank: last.browse_status_rank as number,
      sortValue: { sort: query.sort, values: selectedColumns.map((column) => last[column.field] as SortValue) },
      id: last.id as string,
    } : null;
    return { rows: rows.map(rowToMeeting), nextCursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null };
  }

  /** Global live totals, independent of the current browse page/filter. */
  counts(): MeetingCounts {
    return this.db.prepare(`
      SELECT COUNT(*) AS "all",
        COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending,
        COUNT(CASE WHEN status IN ('awaiting_user', 'processing') THEN 1 END) AS processing,
        COUNT(CASE WHEN status = 'done' THEN 1 END) AS done,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed
      FROM meetings WHERE deleted_at IS NULL
    `).get() as MeetingCounts;
  }

  /** Exact live-ID snapshot for bulk selection, in deterministic ID order. */
  listIds(filter: MeetingListFilter): string[] {
    const rows = this.db.prepare(`
      SELECT id FROM meetings WHERE deleted_at IS NULL AND ${filterSql(filter)} ORDER BY id ASC
    `).all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** Hydrate live rows in first-occurrence input order; omit missing/deleted
   *  IDs and duplicates. Each SQL statement binds at most 900 IDs. */
  findByIds(ids: string[]): MeetingRow[] {
    const uniqueIds = [...new Set(ids)];
    const found = new Map<string, MeetingRow>();
    for (let i = 0; i < uniqueIds.length; i += 900) {
      const chunk = uniqueIds.slice(i, i + 900);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT * FROM meetings WHERE deleted_at IS NULL AND id IN (${placeholders})`,
      ).all(...chunk) as Record<string, unknown>[];
      for (const row of rows) {
        const meeting = rowToMeeting(row);
        found.set(meeting.id, meeting);
      }
    }
    return uniqueIds.flatMap((id) => { const row = found.get(id); return row ? [row] : []; });
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

  /** Case-insensitive title substring search, newest first. Powers the
   *  Cmd+K palette's title tier — pushed down to SQL so a keystroke
   *  doesn't materialize the whole library via listAll(). Parameter-
   *  bound; excludes soft-deleted rows. */
  searchByTitle(q: string, limit: number): MeetingRow[] {
    // Escape LIKE metacharacters so the palette matches the user's text
    // literally — "50%" or "q_2" must behave like the old .includes()
    // substring match, not as SQL wildcards.
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = this.db.prepare(`
      SELECT * FROM meetings
      WHERE deleted_at IS NULL AND title LIKE '%'||?||'%' ESCAPE '\\' COLLATE NOCASE
      ORDER BY COALESCE(started_at, created_at) DESC
      LIMIT ?
    `).all(escaped, limit) as Record<string, unknown>[];
    return rows.map(rowToMeeting);
  }

  /** Resolve a set of folder slugs (e.g. from ripgrep content hits) to
   *  their live meeting rows in one round-trip. Parameter-bound IN list,
   *  chunked to stay under SQLite's default 999-variable limit. Excludes
   *  soft-deleted rows, matching listAll(). */
  findBySlugs(slugs: string[]): MeetingRow[] {
    const CHUNK = 900;
    const out: MeetingRow[] = [];
    for (let i = 0; i < slugs.length; i += CHUNK) {
      const chunk = slugs.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT * FROM meetings WHERE deleted_at IS NULL AND slug IN (${placeholders})`,
      ).all(...chunk) as Record<string, unknown>[];
      out.push(...rows.map(rowToMeeting));
    }
    return out;
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
