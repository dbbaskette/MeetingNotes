import type Database from 'better-sqlite3';

interface Migration { version: number; up: string; }

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        started_at TEXT,
        duration_s INTEGER,
        audio_path TEXT NOT NULL,
        status TEXT NOT NULL,
        pipeline_stage TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meetings_stage ON meetings(pipeline_stage);
      CREATE INDEX IF NOT EXISTS idx_meetings_started ON meetings(started_at);
      CREATE INDEX IF NOT EXISTS idx_meetings_audio_path ON meetings(audio_path);

      CREATE TABLE IF NOT EXISTS speakers (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS meeting_speakers (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        local_label TEXT NOT NULL,
        roster_speaker_id TEXT REFERENCES speakers(id),
        confidence REAL,
        PRIMARY KEY (meeting_id, local_label)
      );

      CREATE TABLE IF NOT EXISTS action_items (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        owner_speaker_id TEXT REFERENCES speakers(id),
        due_date TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        exported_to TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    // stage_started_at lets the UI show elapsed time ("DIARIZING · 2m 18s")
    // without having to time-track separately in the renderer.
    up: `
      ALTER TABLE meetings ADD COLUMN stage_started_at TEXT;
      UPDATE meetings SET stage_started_at = updated_at WHERE stage_started_at IS NULL;
    `,
  },
  {
    version: 3,
    // Reset meetings that never actually finished a processing step back to
    // "pending". Historical 'failed' rows came from the old auto-enqueue
    // behavior where every dropped MP3 got jammed through a broken pipeline;
    // those aren't real failures, they're un-started recordings. Any row whose
    // pipeline_stage is 'discovered' (meaning nothing has actually run yet) is
    // safe to treat as pending regardless of status. Leaves real failures
    // alone (status='failed' with a real pipeline_stage like 'diarizing').
    up: `
      -- Discovered-but-not-pending: trivially wrong state, reset.
      UPDATE meetings
         SET status = 'pending'
       WHERE pipeline_stage = 'discovered'
         AND status != 'pending';

      -- Historical 'failed' cruft: old auto-enqueue builds jammed every MP3
      -- through a broken pipeline, so the library fills with FAILED pills
      -- before the user has ever clicked anything. One-time reset to pending
      -- + discovered so these look like fresh cataloged recordings again.
      -- Real deliberate failures going forward keep their 'failed' status.
      UPDATE meetings
         SET status = 'pending',
             pipeline_stage = 'discovered',
             stage_started_at = NULL
       WHERE status = 'failed';
    `,
  },
  {
    version: 4,
    // Swap the default LLM away from gemma-4-31b. On 24–32GB Apple Silicon
    // gemma-31b runs the Metal allocator out of memory on any meeting longer
    // than ~10 minutes (13k+ prompt tokens), so summarize and extract both
    // die mid-generation with "Channel Error" / empty content. qwen3.5-9b
    // produces comparable summary quality at a fraction of the VRAM. Users
    // who deliberately want the big model can still pick it in Settings.
    // Only rewrites the row if it's still on the problematic default; we
    // don't second-guess users who've already chosen something else.
    up: `
      UPDATE settings
         SET value = '"qwen/qwen3.5-9b"'
       WHERE key = 'llmModel'
         AND value IN ('"google/gemma-4-31b"', '""');
    `,
  },
  {
    version: 5,
    // Per-meeting flag for "skip the speaker-identification gate." The
    // pipeline pauses at `awaiting_speaker_id` by default so the user can
    // label unknown voices before summarize bakes SPEAKER_00 into the output.
    // Users who don't care (solo brain-dumps, low-stakes recordings) can flip
    // this on and have the pipeline run end-to-end without waiting. Stored
    // as 0/1 because better-sqlite3 doesn't have a native boolean type.
    up: `
      ALTER TABLE meetings ADD COLUMN skip_speaker_id INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 6,
    // Track in-flight recordings so we can recover orphans on next launch
    // (an unfinalized .m4a from a previous PID that never wrote 'finalized').
    // status='recording' on insert; updated to 'finalized' on clean stop or
    // 'orphaned' when the recovery scan finds the file abandoned.
    up: `
      CREATE TABLE IF NOT EXISTS recording_sessions (
        id TEXT PRIMARY KEY,
        helper_pid INTEGER NOT NULL,
        target_pid INTEGER,
        target_label TEXT NOT NULL,
        output_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finalized_at TEXT,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rec_status ON recording_sessions(status);
    `,
  },
  {
    version: 7,
    // Soft-delete support (UX rec #2). When the user deletes a meeting, we
    // stamp `deleted_at` and move the audio files + meeting folder into a
    // per-meeting trash directory. The row stays around so the user can
    // click "Undo" in the toast. A periodic purge hard-deletes entries that
    // have aged past the undo window. Partial index skips deleted rows from
    // the normal list queries for free.
    up: `
      ALTER TABLE meetings ADD COLUMN deleted_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_meetings_deleted ON meetings(deleted_at);
    `,
  },
  {
    version: 8,
    // Free-text owner name on action items (#44). The existing
    // owner_speaker_id FK is rarely populated because Extract pulls owner
    // strings out of the transcript that don't match the roster cleanly.
    // Keep the FK column but add a sibling TEXT column the UI writes to
    // directly — lets users type "Alice" or "Marketing team" without
    // needing a matching roster entry.
    up: `
      ALTER TABLE action_items ADD COLUMN owner_name TEXT;
    `,
  },
  {
    version: 9,
    // Weekly summaries (#weekly): cached LLM narrative + decisions for
    // an ISO week's worth of meetings. We persist only the LLM output
    // (which is expensive to regenerate) — meetings list and action
    // items are joined live on each read because both are already
    // indexed by date / meeting_id and the joins are cheap.
    //
    // input_hash is a sha256 over sorted (meeting_id, updated_at) pairs
    // for meetings whose started_at falls in the week. On each get(),
    // we recompute the hash and compare against the cached row; a
    // mismatch forces regeneration so a newly-arrived meeting or an
    // edited title invalidates the cache.
    //
    // PRIMARY KEY (iso_year, iso_week) keeps it one row per week. No FK
    // to meetings — deletion of a meeting just changes the input_hash,
    // which the next get() detects.
    up: `
      CREATE TABLE IF NOT EXISTS weekly_summaries (
        iso_year INTEGER NOT NULL,
        iso_week INTEGER NOT NULL,
        narrative TEXT NOT NULL,
        decisions_json TEXT NOT NULL DEFAULT '[]',
        input_hash TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        PRIMARY KEY (iso_year, iso_week)
      );
    `,
  },
  {
    version: 10,
    // Capture WHY a run failed. Until now a failed pipeline stored only
    // status='failed' + the last pipeline_stage; the actual error string
    // (e.g. "whisper: not ready within 120000ms") went to app.log and was
    // never shown to the user. error_message holds that string so the
    // detail view can explain the failure and offer a retry. Cleared
    // whenever a meeting transitions back to a non-failed state.
    up: `
      ALTER TABLE meetings ADD COLUMN error_message TEXT;
    `,
  },
  {
    version: 11,
    // Weekly summary themes (richer-weekly-summary). The narrative LLM call
    // now also returns synthesized topic threads across the week; cache them
    // alongside narrative/decisions. NOT NULL with a default so existing
    // cached rows upgrade cleanly — they show no themes until the next
    // regeneration repopulates the column.
    up: `
      ALTER TABLE weekly_summaries ADD COLUMN themes_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 12,
    // Action-item provenance (#provenance). Each extracted action item is a
    // reworded version of one "## Action Items" bullet in summary.md. Store
    // the verbatim source bullet so the UI can jump from an item to the
    // summary text it came from. Nullable with no default: existing rows and
    // hand-added items (which have no source) read back NULL, exactly the
    // "unknown provenance" state the UI already handles. Populated only by
    // the extract stage's post-hoc fuzzy matcher — no LLM/schema change.
    up: `
      ALTER TABLE action_items ADD COLUMN source_quote TEXT;
    `,
  },
  {
    version: 13,
    // Learned per-stage ETA (per-stage-progress-eta). Store one duration
    // sample per stage run, keyed by stage + a coarse transcript-size bucket,
    // so the UI can show "usually ~3m for a meeting this long on your machine"
    // next to elapsed time. Per-sample rows (not a rolling aggregate) because
    // the estimate is a median over the recent samples — that needs the raw
    // values and is what makes it robust to a single stage that limped to the
    // request timeout. The runner prunes each (stage, size_bucket) to the most
    // recent N (see StageDurationsRepo), so the table stays bounded. Lives in
    // the meetings/library DB alongside the pipeline state it describes.
    //
    // NOTE: version 13, not 12 as originally specced — v12 was taken by the
    // action_items.source_quote provenance migration that landed first.
    up: `
      CREATE TABLE IF NOT EXISTS stage_durations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stage TEXT NOT NULL,
        size_bucket INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stage_durations_lookup
        ON stage_durations(stage, size_bucket, recorded_at);
    `,
  },
  {
    version: 14,
    // action_items had no index on meeting_id, so countsByMeeting()'s
    // GROUP BY (run on every meetings:list poll, every ~3s) and
    // listByMeeting()'s WHERE both walked the whole table. Cheap now,
    // but it scales with total action items across all meetings forever.
    up: `
      CREATE INDEX IF NOT EXISTS idx_action_items_meeting
        ON action_items(meeting_id);
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  // Seed the version row exactly once. Idempotent across launches.
  const seeded = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number };
  if (seeded.n === 0) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();

  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
  let current = row.version;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.exec('BEGIN');
      try {
        db.exec(m.up);
        db.prepare('UPDATE schema_version SET version = ?').run(m.version);
        db.exec('COMMIT');
        current = m.version;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  }
}
