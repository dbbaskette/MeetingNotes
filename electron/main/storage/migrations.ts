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
